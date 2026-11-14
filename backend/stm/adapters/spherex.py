"""NASA/IPAC IRSA SPHEREx adapter.

Data access (verified against the live archive, see docs/DATA_SOURCES.md):

* Discovery: IVOA SIA v2 at ``https://irsa.ipac.caltech.edu/SIA`` with
  ``COLLECTION=spherex_dr1`` (Level 2 spectral images, wide survey).
* Products: Level 2 multi-extension FITS (IMAGE, FLAGS, VARIANCE, ZODI, EPSF,
  WCS-WAVE), one file per detector per exposure, 2040x2040 pixels.
* Cutouts: IRSA IBE cutout service, ``<access_url>?center=RA,Dec&size=DEG``,
  which preserves all extensions and rewrites the wavelength lookup offsets.
* Headers: IBE supports HTTP Range requests, so per-exposure headers (WCS,
  timing, PSF FWHM) and the small WCS-WAVE table are read without downloading
  the 65 MB full product.
"""

from __future__ import annotations

import io
import json
import logging
import math
import re
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, TypeVar

import httpx
import numpy as np
from astropy.io import fits
from astropy.io.votable import parse as parse_votable

from stm.adapters.base import ArchiveError, ObservationRecord, SurveyAdapter
from stm.config import Settings, get_settings
from stm.storage import LocalStorage, ObjectStorage, stable_key

log = logging.getLogger(__name__)
T = TypeVar("T")

FITS_BLOCK = 2880
SIA_CACHE_TTL_S = 24 * 3600

# SPHEREx bands as documented by IRSA (detector -> nominal range, resolving power).
SPHEREX_BANDS: dict[int, dict[str, float]] = {
    1: {"min_um": 0.75, "max_um": 1.09, "R": 39},
    2: {"min_um": 1.10, "max_um": 1.62, "R": 41},
    3: {"min_um": 1.63, "max_um": 2.41, "R": 41},
    4: {"min_um": 2.42, "max_um": 3.82, "R": 35},
    5: {"min_um": 3.83, "max_um": 4.41, "R": 112},
    6: {"min_um": 4.42, "max_um": 5.00, "R": 128},
}


def _with_retries(fn: Callable[[], T], retries: int, what: str) -> T:
    delay = 1.0
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return fn()
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status is not None and 400 <= status < 500 and status not in (408, 429):
                raise ArchiveError(f"{what}: HTTP {status}") from e
            last = e
            log.warning("%s failed (attempt %d/%d): %s", what, attempt + 1, retries + 1, e)
            if attempt < retries:
                time.sleep(delay)
                delay *= 2
    raise ArchiveError(f"{what}: archive unreachable after {retries + 1} attempts ({last})")


def _hdu_data_bytes(h: fits.Header) -> int:
    naxis = int(h.get("NAXIS", 0))
    if naxis == 0:
        return 0
    n = 1
    for i in range(1, naxis + 1):
        n *= int(h[f"NAXIS{i}"])
    nbytes = abs(int(h["BITPIX"])) // 8 * int(h.get("GCOUNT", 1)) * (int(h.get("PCOUNT", 0)) + n)
    return int(math.ceil(nbytes / FITS_BLOCK) * FITS_BLOCK)


def _parse_header_block(buf: bytes) -> tuple[fits.Header, int] | None:
    """Return (header, header_size_bytes) if an END card is present in buf."""
    for i in range(0, len(buf) - 79, 80):
        if buf[i : i + 8] == b"END     ":
            size = int(math.ceil((i + 80) / FITS_BLOCK) * FITS_BLOCK)
            return fits.Header.fromstring(buf[: i + 80].decode("ascii", "replace")), size
    return None


class SpherexAdapter(SurveyAdapter):
    name = "spherex"

    def __init__(
        self, settings: Settings | None = None, storage: ObjectStorage | None = None, client: httpx.Client | None = None
    ):
        self.settings = settings or get_settings()
        self.storage = storage or LocalStorage(self.settings.data_dir)
        self.client = client or httpx.Client(
            timeout=self.settings.http_timeout_s,
            follow_redirects=True,
            headers={"User-Agent": "sky-time-machine/0.1 (research tool)"},
        )

    # ------------------------------------------------------------------ discovery
    def describe(self) -> dict[str, Any]:
        return {
            "survey": "SPHEREx",
            "archive": "NASA/IPAC Infrared Science Archive (IRSA)",
            "collection": self.settings.spherex_collection,
            "product": "Level 2 spectral image (calibrated surface brightness, MJy/sr)",
            "discovery_service": self.settings.irsa_sia_url,
            "documentation": "https://caltech-ipac.github.io/spherex-archive-documentation/",
            "bands": SPHEREX_BANDS,
        }

    def query_position(self, ra: float, dec: float, radius_deg: float = 0.01) -> list[ObservationRecord]:
        params = {
            "COLLECTION": self.settings.spherex_collection,
            "POS": f"circle {ra:.7f} {dec:.7f} {radius_deg:.5f}",
            "RESPONSEFORMAT": "VOTABLE",
        }
        key = f"spherex/sia/{stable_key(params['COLLECTION'], params['POS'])}.xml"
        raw: bytes | None = None
        if self.storage.exists(key):
            p = self.storage.local_path(key)
            if time.time() - p.stat().st_mtime < SIA_CACHE_TTL_S:
                raw = self.storage.read_bytes(key)
        if raw is None:

            def go() -> bytes:
                r = self.client.get(self.settings.irsa_sia_url, params=params)
                r.raise_for_status()
                return r.content

            raw = _with_retries(go, self.settings.http_retries, "SIA query")
            self.storage.write_bytes(key, raw)
        return self.parse_sia_votable(raw)

    def parse_sia_votable(self, raw: bytes) -> list[ObservationRecord]:
        try:
            vot = parse_votable(io.BytesIO(raw), verify="ignore")
            table = vot.get_first_table().to_table(use_names_over_ids=True)
        except Exception as e:  # malformed / error document
            raise ArchiveError(f"Could not parse SIA response: {e}") from e
        records: list[ObservationRecord] = []
        for row in table:
            r = {c: _plain(row[c]) for c in table.colnames}
            if r.get("dataproduct_subtype") not in (None, "", "science"):
                continue
            band = str(r.get("energy_bandpassname") or "")
            det = None
            if band.startswith("SPHEREx-D"):
                try:
                    det = int(band.rsplit("D", 1)[1])
                except ValueError:
                    det = None
            records.append(
                ObservationRecord(
                    survey="SPHEREx",
                    collection=str(r.get("obs_collection") or self.settings.spherex_collection),
                    product_id=f"{r['obs_id']}D{det}" if det else str(r.get("obs_publisher_did") or r["access_url"]),
                    obs_id=str(r["obs_id"]),
                    detector=det,
                    band_name=band,
                    em_min_um=_um(r.get("em_min")),
                    em_max_um=_um(r.get("em_max")),
                    t_min_mjd=float(r["t_min"]),
                    t_max_mjd=float(r["t_max"]),
                    exptime_s=_float(r.get("t_exptime")),
                    s_ra=float(r["s_ra"]),
                    s_dec=float(r["s_dec"]),
                    s_region=str(r.get("s_region") or ""),
                    access_url=str(r["access_url"]),
                    calib_level=_int(r.get("calib_level")),
                    release_date=str(r.get("obs_release_date") or "") or None,
                    cloud_access=str(r.get("cloud_access") or "") or None,
                    source_row=r,
                )
            )
        records.sort(key=lambda x: (x.t_min_mjd, x.detector or 0))
        return records

    # ------------------------------------------------------------------ headers via HTTP Range
    def _range(self, url: str, start: int, length: int) -> bytes:
        def go() -> bytes:
            r = self.client.get(url, headers={"Range": f"bytes={start}-{start + length - 1}"})
            r.raise_for_status()
            if r.status_code != 206:
                raise ArchiveError("Archive ignored HTTP Range request")
            return r.content

        return _with_retries(go, self.settings.http_retries, f"range read {url}")

    def iter_remote_headers(self, url: str, stop_at: str | None = None):
        """Yield (extname, header, data_offset, data_size) walking a remote FITS file."""
        offset = 0
        for _ in range(16):
            buf = b""
            parsed = None
            while parsed is None:
                chunk = self._range(url, offset + len(buf), FITS_BLOCK * 12)
                if not chunk:
                    return  # end of file
                buf += chunk
                parsed = _parse_header_block(buf)
                if len(buf) > FITS_BLOCK * 60:
                    raise ArchiveError("FITS header without END card")
            hdr, hsize = parsed
            dsize = _hdu_data_bytes(hdr)
            name = str(hdr.get("EXTNAME", "PRIMARY")).strip()
            yield name, hdr, offset + hsize, dsize
            if stop_at and name == stop_at:
                return
            offset += hsize + dsize

    def fetch_image_header(self, record: ObservationRecord) -> fits.Header:
        key = f"spherex/headers/{record.product_id}.hdr"
        if self.storage.exists(key):
            return fits.Header.fromstring(self.storage.read_bytes(key).decode("ascii"))
        for name, hdr, _, _ in self.iter_remote_headers(record.access_url, stop_at="IMAGE"):
            if name == "IMAGE":
                self.storage.write_bytes(key, hdr.tostring().encode("ascii"))
                return hdr
        raise ArchiveError(f"No IMAGE extension in {record.access_url}")

    def fetch_headers(self, records: list[ObservationRecord], workers: int = 8) -> dict[str, fits.Header | None]:
        out: dict[str, fits.Header | None] = {}

        def one(rec: ObservationRecord) -> tuple[str, fits.Header | None]:
            try:
                return rec.product_id, self.fetch_image_header(rec)
            except ArchiveError as e:
                log.warning("header fetch failed for %s: %s", rec.product_id, e)
                return rec.product_id, None

        with ThreadPoolExecutor(max_workers=workers) as ex:
            for pid, h in ex.map(one, records):
                out[pid] = h
        return out

    def fetch_wavelength_lookup(self, record: ObservationRecord) -> dict[str, Any]:
        """The detector's WCS-WAVE lookup table, read from the product itself via HTTP Range.

        Cached per (detector, L2 pipeline version). The calibration file name is
        kept from the table's HISTORY cards so provenance shows which spectral
        WCS calibration produced every wavelength estimate.
        """
        m = re.search(r"l2b-v(\d+)", record.access_url)
        version = m.group(1) if m else stable_key(record.access_url)
        key = f"spherex/lookup/D{record.detector}_l2b-v{version}.json"
        if self.storage.exists(key):
            return json.loads(self.storage.read_bytes(key))
        for name, hdr, doff, dsize in self.iter_remote_headers(record.access_url, stop_at="WCS-WAVE"):
            if name != "WCS-WAVE":
                continue
            data = self._range(record.access_url, doff, dsize)
            buf = io.BytesIO()
            fits.PrimaryHDU().writeto(buf)
            buf.write(hdr.tostring().encode("ascii"))
            buf.write(data)
            buf.seek(0)
            with fits.open(buf) as hd:
                tab = hd[1].data
                lut = {
                    "detector": record.detector,
                    "pipeline_version": f"l2b-v{version}",
                    "x": np.asarray(tab["X"][0]).astype(float).tolist(),
                    "y": np.asarray(tab["Y"][0]).astype(float).tolist(),
                    "values": np.asarray(tab["VALUES"][0]).astype(float).tolist(),  # [iy][ix][wave, bw]
                    "calibration_source": " ".join(
                        str(c) for c in hdr.get("HISTORY", []) if "Calibration source" in str(c)
                    ),
                    "from_product": record.product_id,
                }
            self.storage.write_bytes(key, json.dumps(lut).encode())
            return lut
        raise ArchiveError(f"No WCS-WAVE extension in {record.access_url}")

    # ------------------------------------------------------------------ cutouts
    def cutout_url(self, record: ObservationRecord, ra: float, dec: float, size_deg: float) -> str:
        return f"{record.access_url}?center={ra:.7f},{dec:.7f}&size={size_deg:.4f}"

    def fetch_cutout(self, record: ObservationRecord, ra: float, dec: float, size_deg: float) -> Path:
        size_deg = min(size_deg, self.settings.max_cutout_deg)
        key = f"spherex/cutouts/{record.product_id}_{stable_key(round(ra, 6), round(dec, 6), round(size_deg, 4))}.fits"
        if self.storage.exists(key):
            return self.storage.local_path(key)
        url = self.cutout_url(record, ra, dec, size_deg)

        def go() -> bytes:
            r = self.client.get(url)
            r.raise_for_status()
            return r.content

        content = _with_retries(go, self.settings.http_retries, f"cutout {record.product_id}")
        if not content.startswith(b"SIMPLE  ="):
            raise ArchiveError(f"Cutout for {record.product_id} is not a FITS file (target outside footprint?)")
        self.storage.write_bytes(key, content)
        return self.storage.local_path(key)


def _plain(v: Any) -> Any:
    if isinstance(v, np.ma.core.MaskedConstant):
        return None
    if isinstance(v, bytes):
        return v.decode()
    if isinstance(v, np.generic):
        return v.item()
    return v


def _float(v: Any) -> float | None:
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _um(v: Any) -> float | None:
    f = _float(v)
    return None if f is None else f * 1e6  # SIA em_min/em_max are in metres
