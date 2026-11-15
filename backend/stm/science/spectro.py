"""SPHEREx spectra at a sky position from real archive products.

Two independent sources, never mixed in one curve:

1. Per-exposure spectrophotometry (computed here). SPHEREx's linear variable
   filters mean every Level 2 exposure that covers a position samples it at one
   wavelength. For each exposure we read a small pixel stamp of IMAGE, FLAGS and
   VARIANCE with HTTP Range requests and run the same forced aperture photometry
   used elsewhere. Quantity: *measured aperture flux density* (µJy) with
   VARIANCE-based 1σ errors, plus an optional *derived* aperture-corrected
   point-source flux density using the detector EPSF.

2. The IRSA DR1 all-sky spectral cube (``spherex_dr1_cube``): a time-averaged
   102-channel coadd in HEALPix tiles (IMAGE in MJy/sr, NHITS, FLAGS, and the
   official SPECTRAL_CHANNELS table). Quantity: *archive coadded surface
   brightness* (MJy/sr). The cube has no uncertainty plane, so none is reported.
"""

from __future__ import annotations

import io
import json
import re
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS, FITSFixedWarning
from astropy.wcs.utils import proj_plane_pixel_scales

from stm.adapters.base import ArchiveError, ObservationRecord
from stm.adapters.spherex import SpherexAdapter
from stm.science.fitsio import (
    SPHEREX_DEFAULT_FLAGS,
    ImageProduct,
    celestial_wcs,
    parse_flag_definitions,
    raw_coords,
    wavelength_at_raw,
)
from stm.science.photometry import forced_photometry
from stm.science.psf import EPSFGrid, load_epsf
from stm.storage import stable_key

CHANNELS_FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "spherex_dr1_spectral_channels.json"


# ---------------------------------------------------------------------------- channels
def load_channel_table(
    adapter: SpherexAdapter | None = None, cube_record: ObservationRecord | None = None
) -> list[dict[str, Any]]:
    """Official 102-channel definitions from the DR1 cube SPECTRAL_CHANNELS table.

    Read once from a real cube tile (via Range) and cached. The test fixture is
    the same table extracted from IRSA and is used only when no archive copy is
    cached and none can be fetched.
    """
    if adapter is not None:
        key = "spherex/cube/spectral_channels.json"
        if adapter.storage.exists(key):
            return json.loads(adapter.storage.read_bytes(key))["channels"]
        if cube_record is not None:
            idx = adapter.hdu_index(cube_record)
            t = adapter.read_table(cube_record, idx["SPECTRAL_CHANNELS"])
            chans = [
                {
                    "index": i,
                    "detector": int(r["DETECTOR"]),
                    "subchannel": int(r["SUBCHAN"]),
                    "wave_um": float(r["WAVELENGTH"]),
                    "wave_min_um": float(r["WL_MIN"]),
                    "wave_max_um": float(r["WL_MAX"]),
                    "R": float(r["R"]),
                    "bandwidth_um": float(r["BANDWIDTH"]),
                }
                for i, r in enumerate(t)
            ]
            adapter.storage.write_bytes(key, json.dumps({"source": cube_record.access_url, "channels": chans}).encode())
            return chans
    return json.loads(CHANNELS_FIXTURE.read_text())["channels"]


def assign_channel(
    channels: list[dict[str, Any]], detector: int | None, wave_um: float | None
) -> dict[str, Any] | None:
    """Official channel of the given detector whose [wave_min, wave_max] contains the wavelength."""
    if detector is None or wave_um is None or not np.isfinite(wave_um):
        return None
    best = None
    for c in channels:
        if c["detector"] != detector:
            continue
        if c["wave_min_um"] <= wave_um <= c["wave_max_um"]:
            # adjacent channels can overlap at their edges; prefer the nearer centre
            if best is None or abs(wave_um - c["wave_um"]) < abs(wave_um - best["wave_um"]):
                best = c
    return best


# ---------------------------------------------------------------------------- per-exposure stamps
def _l2_version(url: str) -> str:
    m = re.search(r"l2b-v(\d+)", url)
    return f"l2b-v{m.group(1)}" if m else "unknown"


def detector_epsf(adapter: SpherexAdapter, record: ObservationRecord) -> EPSFGrid | None:
    """The detector's EPSF grid (calibration product, identical for all exposures of a detector and L2 version).

    Read once via Range (~3.8 MB) and cached as .npz.
    """
    key = f"spherex/epsf/D{record.detector}_{_l2_version(record.access_url)}.npz"
    if adapter.storage.exists(key):
        with np.load(io.BytesIO(adapter.storage.read_bytes(key)), allow_pickle=False) as z:
            meta = json.loads(str(z["meta"]))
            return EPSFGrid(z["xc"], z["yc"], z["psfs"], tuple(z["ov"].tolist()), (0.0, 0.0), meta)  # type: ignore[arg-type]
    idx = adapter.hdu_index(record)
    if "EPSF" not in idx:
        return None
    hdr = fits.Header.fromstring(idx["EPSF"]["header"])
    data = adapter._range_any(adapter.range_urls(record), idx["EPSF"]["data_offset"], idx["EPSF"]["data_size"])
    buf = io.BytesIO()
    fits.PrimaryHDU().writeto(buf)
    buf.write(hdr.tostring().encode("ascii"))
    buf.write(data)
    buf.seek(0)
    with fits.open(buf) as hd:
        grid = load_epsf(
            fits.HDUList([hd[0], fits.BinTableHDU(hd[1].data, hd[1].header, name="EPSF")]),
            fits.Header({"CRPIX1A": 1.0, "CRPIX2A": 1.0}),
        )
    if grid is None:
        return None
    out = io.BytesIO()
    np.savez_compressed(
        out,
        xc=grid.xc,
        yc=grid.yc,
        psfs=grid.psfs,
        ov=np.array(grid.oversampling),
        meta=json.dumps(grid.meta | {"from_product": record.product_id}),
    )
    adapter.storage.write_bytes(key, out.getvalue())
    return grid


def read_stamp(
    adapter: SpherexAdapter,
    record: ObservationRecord,
    ra: float,
    dec: float,
    half: int = 8,
    lut: dict[str, Any] | None = None,
) -> ImageProduct | None:
    """IMAGE/FLAGS/VARIANCE stamp around (ra, dec) from a Level 2 file, as an ImageProduct (None if outside)."""
    idx = adapter.hdu_index(record, stop_at="VARIANCE")
    ih = fits.Header.fromstring(idx["IMAGE"]["header"])
    wcs_full = celestial_wcs(ih)
    nx, ny = int(ih["NAXIS1"]), int(ih["NAXIS2"])
    x, y = (float(v) for v in wcs_full.world_to_pixel_values(ra, dec))
    if not (0 <= x < nx and 0 <= y < ny):
        return None
    xi, yi = int(round(x)), int(round(y))
    y0, y1 = max(0, yi - half), min(ny - 1, yi + half)
    x0, x1 = max(0, xi - half), min(nx - 1, xi + half)
    rows = {n: adapter.read_rows(record, idx[n], y0, y1) for n in ("IMAGE", "FLAGS", "VARIANCE")}
    img = rows["IMAGE"][:, x0 : x1 + 1].astype(float)
    flg = rows["FLAGS"][:, x0 : x1 + 1].astype(np.int64)
    var = rows["VARIANCE"][:, x0 : x1 + 1].astype(float)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        warnings.simplefilter("ignore", AstropyWarning)
        wcs = wcs_full[y0 : y1 + 1, x0 : x1 + 1]
    flag_bits = parse_flag_definitions(fits.Header.fromstring(idx["FLAGS"]["header"])) or dict(SPHEREX_DEFAULT_FLAGS)
    wave = bw = None
    if lut is not None:
        yy, xx = np.mgrid[y0 : y1 + 1, x0 : x1 + 1].astype(float)
        xr, yr = raw_coords(ih, xx, yy)
        wave, bw = wavelength_at_raw(np.asarray(lut["x"]), np.asarray(lut["y"]), np.asarray(lut["values"]), xr, yr)
    det = ih.get("DETECTOR")
    return ImageProduct(
        product_id=record.product_id,
        survey="SPHEREx",
        image=img,
        variance=var,
        flags=flg,
        wcs=wcs,
        t_mid_mjd=float(ih.get("MJD-AVG", record.t_mid_mjd)),
        exptime_s=ih.get("XPOSURE"),
        unit=str(ih.get("BUNIT", "")),
        detector=int(det) if det is not None else record.detector,
        zodi=None,
        wave_um=wave,
        bandwidth_um=bw,
        psf_fwhm_arcsec=ih.get("PSF_FWHM"),
        flag_bits=flag_bits,
        header_meta={"OBSID": ih.get("OBSID"), "stamp_origin": [x0, y0], "L1DQAFLG": ih.get("L1DQAFLG")},
    )


def aperture_correction(epsf: EPSFGrid, x_full: float, y_full: float, r_pix: float) -> float:
    """Fraction of a point source's flux inside a circular aperture, from the detector EPSF at that position."""
    from scipy.ndimage import map_coordinates

    p = epsf.at_active(x_full, y_full)
    ov = epsf.oversampling[0]
    c = (p.shape[0] - 1) / 2.0
    fx, fy = x_full - round(x_full), y_full - round(y_full)  # sub-pixel phase of the source
    n = int(np.ceil(r_pix)) + 3
    yy, xx = np.mgrid[-n : n + 1, -n : n + 1].astype(float)
    # pixel-response value of each native pixel = ePSF sampled at (pixel centre - source position)
    vals = map_coordinates(p, [c + (yy - fy) * ov, c + (xx - fx) * ov], order=3, mode="constant") * ov * ov
    inside = (xx - fx) ** 2 + (yy - fy) ** 2 <= r_pix**2
    tot = float(np.clip(vals, 0, None).sum())
    return float(np.clip(vals[inside], 0, None).sum() / tot) if tot > 0 else float("nan")


def measure_exposure(
    adapter: SpherexAdapter,
    record: ObservationRecord,
    ra: float,
    dec: float,
    lut: dict[str, Any] | None,
    epsf: EPSFGrid | None,
    channels: list[dict[str, Any]],
) -> dict[str, Any]:
    base = {
        "product_id": record.product_id,
        "obs_id": record.obs_id,
        "detector": record.detector,
        "t_mid_mjd": record.t_mid_mjd,
        "access_url": record.access_url,
    }
    try:
        stamp = read_stamp(adapter, record, ra, dec, lut=lut)
    except ArchiveError as e:
        return base | {"status": "error", "message": str(e)}
    if stamp is None:
        return base | {"status": "outside", "message": "position outside this exposure"}
    ph = forced_photometry(stamp, ra, dec)
    if not ph.get("in_image"):
        return base | {"status": "outside", "message": "position outside stamp"}
    if ph["masked_fraction"] >= 0.999:
        return base | {
            "status": "masked",
            "message": "every aperture pixel is flagged; no measurement",
            "wave_um": ph.get("wave_um"),
            "bandwidth_um": ph.get("bandwidth_um"),
            "channel": (assign_channel(channels, record.detector, ph.get("wave_um")) or {}).get("index"),
        }
    x0, y0 = stamp.header_meta["stamp_origin"]
    xs, ys = (float(v) for v in stamp.wcs.world_to_pixel_values(ra, dec))
    apcorr = aperture_correction(epsf, xs + x0, ys + y0, ph["aperture_radius_pix"]) if epsf is not None else None
    ch = assign_channel(channels, record.detector, ph.get("wave_um"))
    quality = "good"
    reasons: list[str] = []
    if ph["masked_fraction"] > 0.3:
        quality, reasons = "bad", reasons + [f"{ph['masked_fraction']:.0%} of aperture flagged"]
    elif ph["masked_fraction"] > 0:
        quality, reasons = "warning", reasons + [f"{ph['masked_fraction']:.0%} of aperture flagged"]
    if stamp.header_meta.get("L1DQAFLG") not in (None, "Pass"):
        quality, reasons = "warning", reasons + [f"L1 DQA {stamp.header_meta.get('L1DQAFLG')}"]
    if ch is None:
        reasons.append("wavelength outside the official channel ranges")
    out = base | {
        "status": "ok",
        "t_mid_mjd": stamp.t_mid_mjd,
        "wave_um": ph.get("wave_um"),
        "bandwidth_um": ph.get("bandwidth_um"),
        "channel": ch["index"] if ch else None,
        "subchannel": ch["subchannel"] if ch else None,
        "flux_ujy": ph["flux_ujy"],
        "flux_err_ujy": ph["flux_err_ujy"],
        "aperture_correction": apcorr,
        "flux_pointsource_ujy": ph["flux_ujy"] / apcorr if apcorr else None,
        "flux_pointsource_err_ujy": ph["flux_err_ujy"] / apcorr if apcorr else None,
        "background_mjy_sr": ph["background_mjy_sr"],
        "aperture_radius_pix": ph["aperture_radius_pix"],
        "masked_fraction": ph["masked_fraction"],
        "quality": quality,
        "quality_reasons": reasons,
    }
    return out


def spectrophotometry(
    adapter: SpherexAdapter,
    ra: float,
    dec: float,
    detectors: list[int] | None = None,
    max_exposures: int | None = None,
    progress: Any = None,
) -> dict[str, Any]:
    """Forced photometry at (ra, dec) in every Level 2 exposure that covers it."""
    prog = progress or (lambda p, m: None)
    recs = [
        r for r in adapter.query_position(ra, dec, 0.01) if r.detector and (not detectors or r.detector in detectors)
    ]
    recs.sort(key=lambda r: (r.t_mid_mjd, r.detector))
    skipped = []
    if max_exposures and len(recs) > max_exposures:
        skipped = [r.product_id for r in recs[max_exposures:]]
        recs = recs[:max_exposures]
    cube = None
    try:
        cube = query_cube_record(adapter, ra, dec)
    except ArchiveError:
        pass
    channels = load_channel_table(adapter, cube)
    by_det: dict[int, ObservationRecord] = {}
    for r in recs:
        by_det.setdefault(int(r.detector or 0), r)
    luts, epsfs = {}, {}
    for d, r in by_det.items():
        prog(0.02, f"Calibration tables for detector {d}")
        luts[d] = adapter.fetch_wavelength_lookup(r)
        try:
            epsfs[d] = detector_epsf(adapter, r)
        except ArchiveError:
            epsfs[d] = None
    points: list[dict[str, Any]] = []
    done = 0

    def one(r: ObservationRecord) -> dict[str, Any]:
        return measure_exposure(
            adapter, r, ra, dec, luts.get(int(r.detector or 0)), epsfs.get(int(r.detector or 0)), channels
        )

    with ThreadPoolExecutor(max_workers=adapter.settings.range_workers) as ex:
        for res in ex.map(one, recs):
            points.append(res)
            done += 1
            if done % 5 == 0 or done == len(recs):
                prog(0.05 + 0.9 * done / max(1, len(recs)), f"Measured {done}/{len(recs)} exposures")
    points.sort(key=lambda p: (p.get("wave_um") or 0, p["t_mid_mjd"]))
    return {
        "ra": ra,
        "dec": dec,
        "n_exposures": len(recs),
        "points": points,
        "skipped_over_limit": skipped,
        "calibration": {
            str(d): {
                "wavelength_lookup": {k: luts[d].get(k) for k in ("calibration_source", "pipeline_version")},
                "epsf": (epsfs[d].meta if epsfs.get(d) is not None else None),  # type: ignore[union-attr]
            }
            for d in luts
        },
        "method": "Forced circular-aperture photometry (r = 1.5 × header PSF FWHM) on archive IMAGE pixels read by "
        "HTTP Range, background = median of an annulus (r+2 to r+6 px), errors from VARIANCE; samples "
        "assigned to official DR1 channels by wavelength at the position. Aperture correction (point "
        "sources only) from the detector EPSF.",
    }


# ---------------------------------------------------------------------------- DR1 spectral cube
def query_cube_record(adapter: SpherexAdapter, ra: float, dec: float) -> ObservationRecord:
    key = f"spherex/cube/sia_{stable_key(round(ra, 4), round(dec, 4))}.json"
    if adapter.storage.exists(key):
        return ObservationRecord(**json.loads(adapter.storage.read_bytes(key)))
    recs = adapter.query_position(ra, dec, 0.001, collection=adapter.settings.spherex_cube_collection)
    tiles = [r for r in recs if r.access_url.endswith("_cube.fits")]
    if not tiles:
        raise ArchiveError("no DR1 spectral cube tile covers this position")
    rec = tiles[0]
    d = rec.to_dict()
    d.pop("t_mid_mjd", None)
    d["source_row"] = {}
    adapter.storage.write_bytes(key, json.dumps(d).encode())
    return rec


def cube_celestial_wcs(h: fits.Header) -> WCS:
    """2-D celestial WCS of a cube header (the spectral axis is a -TAB lookup that needs the table HDU)."""
    h2 = h.copy()
    for k in list(h2.keys()):
        if (
            re.match(r"^(CTYPE|CUNIT|CRPIX|CDELT|CRVAL|CNAME|NAXIS)3$", k)
            or re.match(r"^(PS|PV)3_\d+$", k)
            or re.match(r"^PC(3_\d|\d_3)$", k)
        ):
            del h2[k]
    h2["NAXIS"] = 2
    h2["WCSAXES"] = 2
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return WCS(h2)


def cube_spectrum(adapter: SpherexAdapter, ra: float, dec: float) -> dict[str, Any]:
    rec = query_cube_record(adapter, ra, dec)
    key = f"spherex/cube/spec_{stable_key(rec.access_url, round(ra, 5), round(dec, 5))}.json"
    if adapter.storage.exists(key):
        return json.loads(adapter.storage.read_bytes(key))
    idx = adapter.hdu_index(rec)
    ih = fits.Header.fromstring(idx["IMAGE"]["header"])
    ph = fits.Header.fromstring(idx["PRIMARY"]["header"])
    wcs = cube_celestial_wcs(ih)
    x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
    nx, ny, nz = int(ih["NAXIS1"]), int(ih["NAXIS2"]), int(ih["NAXIS3"])
    if not (0 <= x < nx and 0 <= y < ny):
        raise ArchiveError("position outside the cube tile")
    xi, yi = int(round(x)), int(round(y))
    channels = load_channel_table(adapter, rec)
    blank = {c.strip() for c in str(ph.get("BLANKCH", "")).split(",") if c.strip()}

    def plane(z: int) -> tuple[int, float, int, int]:
        v = adapter.read_rows(rec, idx["IMAGE"], yi, yi, plane=z)[0, xi]
        n = adapter.read_rows(rec, idx["NHITS"], yi, yi, plane=z)[0, xi]
        f = adapter.read_rows(rec, idx["FLAGS"], yi, yi, plane=z)[0, xi] if "FLAGS" in idx else 0
        return z, float(v), int(n), int(f)

    with ThreadPoolExecutor(max_workers=adapter.settings.range_workers) as ex:
        vals = sorted(ex.map(plane, range(nz)))
    pix = float(np.mean(proj_plane_pixel_scales(wcs)) * 3600.0)
    out_ch = []
    for (z, v, n, f), c in zip(vals, channels, strict=False):
        label = f"D{c['detector']}:{c['subchannel']:02d}"
        missing = (label in blank) or not np.isfinite(v)
        out_ch.append(
            c
            | {
                "plane": z,
                "surface_brightness_mjy_sr": None if missing else v,
                "nhits": n,
                "flags": f,
                "missing": bool(missing),
                "missing_reason": "BLANKCH (all-NaN plane in archive)"
                if label in blank
                else ("NaN at this pixel" if missing else None),
            }
        )
    result = {
        "ra": ra,
        "dec": dec,
        "tile": rec.access_url,
        "tile_id": rec.obs_id,
        "pixel": [xi, yi],
        "pixel_scale_arcsec": pix,
        "unit": str(ih.get("BUNIT", "MJy/sr")).strip(),
        "mjd_range": [ph.get("MJD-BEG"), ph.get("MJD-END")],
        "software_version": ph.get("VERSION"),
        "blank_channels": sorted(blank),
        "channels": out_ch,
        "quantity": "Archive coadded surface brightness at the nearest cube pixel (IRSA DR1 all-sky spectral "
        "cube, a time-averaged derived product). The cube provides no uncertainty plane; NHITS is "
        "the number of contributing samples.",
    }
    adapter.storage.write_bytes(key, json.dumps(result).encode())
    return result
