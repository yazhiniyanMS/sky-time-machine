"""External astronomical catalogues (cone searches over IVOA TAP) with caching and fallbacks.

| Catalogue | Primary service | Fallback |
|---|---|---|
| SIMBAD (identifiers, object types, coordinate errors, bibcodes) | CDS SIMBAD TAP | SIMBAD mirror at Harvard (CfA) |
| Gaia DR3 (positions, errors, G, parallax, proper motion) | ESA Gaia archive TAP | IRSA TAP `gaia_dr3_source` |
| Constellation boundaries / figures | d3-celestial v0.7.32 (BSD-3), via jsDelivr | — |

Responses are cached in object storage (default 7 days). A failed service is
reported as failed, never as an empty result.
"""

from __future__ import annotations

import io
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx
import numpy as np
from astropy.io.votable import parse as parse_votable

from stm.config import get_settings
from stm.storage import LocalStorage, ObjectStorage, stable_key

log = logging.getLogger(__name__)
CACHE_TTL_S = 7 * 24 * 3600

SIMBAD_TAP = ["https://simbad.cds.unistra.fr/simbad/sim-tap/sync", "https://simbad.harvard.edu/simbad/sim-tap/sync"]
GAIA_TAP = [
    ("https://gea.esac.esa.int/tap-server/tap/sync", "gaiadr3.gaia_source"),
    ("https://irsa.ipac.caltech.edu/TAP/sync", "gaia_dr3_source"),
]
D3_CELESTIAL = "https://cdn.jsdelivr.net/gh/ofrohn/d3-celestial@v0.7.32/data"

# SIMBAD object types used for the explorer's galaxy / nebula layers (SIMBAD otype codes).
GALAXY_OTYPES = (
    "G",
    "GiG",
    "GiC",
    "BiC",
    "IG",
    "PaG",
    "SBG",
    "LSB",
    "AGN",
    "SyG",
    "Sy1",
    "Sy2",
    "QSO",
    "rG",
    "H2G",
    "EmG",
    "LIN",
    "BLL",
    "Bla",
    "GiP",
    "GrG",
    "ClG",
)
NEBULA_OTYPES = ("PN", "HII", "RNe", "GNe", "SNR", "ISM", "Cld", "DNe", "MoC", "SFR", "bub", "EmO")


@dataclass
class CatalogResult:
    catalog: str
    status: str  # ok | failed
    service: str | None
    rows: list[dict[str, Any]] = field(default_factory=list)
    queried_at: float = 0.0
    message: str = ""
    cached: bool = False

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


class CatalogService:
    def __init__(self, storage: ObjectStorage | None = None, client: httpx.Client | None = None):
        s = get_settings()
        self.storage = storage or LocalStorage(s.data_dir)
        self.client = client or httpx.Client(
            timeout=45.0, follow_redirects=True, headers={"User-Agent": "sky-time-machine/0.2 (research tool)"}
        )

    # -------------------------------------------------------------- low level
    def _tap(self, url: str, adql: str) -> list[dict[str, Any]]:
        r = self.client.post(url, data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "QUERY": adql})
        r.raise_for_status()
        if not r.content.lstrip().startswith(b"<?xml") and b"<VOTABLE" not in r.content[:2000]:
            raise RuntimeError(f"non-VOTable response ({r.status_code})")
        vot = parse_votable(io.BytesIO(r.content), verify="ignore")
        table = vot.get_first_table().to_table(use_names_over_ids=True)
        rows = []
        for row in table:
            d: dict[str, Any] = {}
            for c in table.colnames:
                v = row[c]
                if np.ma.is_masked(v):
                    d[c] = None
                elif isinstance(v, bytes):
                    d[c] = v.decode()
                elif isinstance(v, np.generic):
                    d[c] = v.item()
                else:
                    d[c] = v
            rows.append(d)
        return rows

    def _cached(self, name: str, key_parts: tuple[Any, ...], services: list[tuple[str, str]]) -> CatalogResult:
        key = f"catalogs/{name}_{stable_key(*key_parts)}.json"
        if self.storage.exists(key):
            p = self.storage.local_path(key)
            if time.time() - p.stat().st_mtime < CACHE_TTL_S:
                d = json.loads(self.storage.read_bytes(key))
                return CatalogResult(**(d | {"cached": True}))
        errors = []
        for url, adql in services:
            try:
                rows = self._tap(url, adql)
                res = CatalogResult(name, "ok", url, rows, time.time())
                self.storage.write_bytes(key, json.dumps(res.to_dict(), default=str).encode())
                return res
            except Exception as e:  # noqa: BLE001 - try the next mirror, report all failures
                log.warning("%s query failed on %s: %s", name, url, e)
                errors.append(f"{url.split('/')[2]}: {type(e).__name__}: {str(e)[:120]}")
        return CatalogResult(name, "failed", None, [], time.time(), "; ".join(errors))

    # -------------------------------------------------------------- cone searches
    def simbad_cone(self, ra: float, dec: float, radius_arcsec: float, limit: int = 200) -> CatalogResult:
        r = radius_arcsec / 3600.0
        adql = (
            f"SELECT TOP {limit} main_id, ra, dec, otype, coo_err_maj, coo_err_min, coo_qual, coo_bibcode, "
            f"DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', {ra}, {dec})) * 3600 AS sep_arcsec FROM basic "
            f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {r}))=1 ORDER BY sep_arcsec"
        )
        res = self._cached(
            "simbad", (round(ra, 6), round(dec, 6), radius_arcsec, limit), [(u, adql) for u in SIMBAD_TAP]
        )
        res.message = res.message or ("truncated at row limit" if len(res.rows) >= limit else "")
        for row in res.rows:
            maj = row.get("coo_err_maj")  # mas
            row["pos_err_arcsec"] = float(maj) / 1000.0 if maj is not None else None
            row["id"] = row.get("main_id")
            row["type"] = row.get("otype")
            row["reference"] = row.get("coo_bibcode")
            row["url"] = "https://simbad.cds.unistra.fr/simbad/sim-id?Ident=" + quote(str(row.get("main_id")))
        return res

    def gaia_cone(self, ra: float, dec: float, radius_arcsec: float, limit: int = 500) -> CatalogResult:
        r = radius_arcsec / 3600.0
        services = []
        for url, table in GAIA_TAP:
            services.append(
                (
                    url,
                    (
                        f"SELECT TOP {limit} source_id, ra, dec, ra_error, dec_error, phot_g_mean_mag, parallax, pm, "
                        f"DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', {ra}, {dec})) * 3600 AS sep_arcsec "
                        f"FROM {table} WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {r}))=1 "
                        "ORDER BY sep_arcsec"
                    ),
                )
            )
        res = self._cached("gaia_dr3", (round(ra, 6), round(dec, 6), radius_arcsec, limit), services)
        res.message = res.message or ("truncated at row limit" if len(res.rows) >= limit else "")
        for row in res.rows:
            sid = row.get("source_id", row.get("SOURCE_ID"))
            row["source_id"] = sid
            e1, e2 = row.get("ra_error"), row.get("dec_error")  # mas, at epoch 2016.0
            row["pos_err_arcsec"] = float(max(e1, e2)) / 1000.0 if e1 is not None and e2 is not None else None
            row["id"] = f"Gaia DR3 {sid}"
            row["type"] = "Gaia source"
            row["reference"] = "2023A&A...674A...1G"
            row["url"] = None
        return res

    def objects_by_type(self, ra: float, dec: float, radius_deg: float, kind: str, limit: int = 500) -> CatalogResult:
        otypes = GALAXY_OTYPES if kind == "galaxy" else NEBULA_OTYPES
        lst = ",".join(f"'{t}'" for t in otypes)
        adql = (
            f"SELECT TOP {limit} main_id, ra, dec, otype, galdim_majaxis, galdim_minaxis, galdim_angle FROM basic "
            f"WHERE otype IN ({lst}) AND CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))=1"
        )
        return self._cached(
            f"simbad_{kind}",
            (round(ra, 3), round(dec, 3), round(radius_deg, 3), limit),
            [(u, adql) for u in SIMBAD_TAP],
        )

    def constellations(self) -> dict[str, Any]:
        key = "catalogs/d3_celestial_constellations_v0.7.32.json"
        if self.storage.exists(key):
            return json.loads(self.storage.read_bytes(key))
        out: dict[str, Any] = {
            "source": "d3-celestial v0.7.32 (BSD-3-Clause), https://github.com/ofrohn/d3-celestial",
            "notes": "Boundaries follow the IAU constellation boundaries (Delporte 1930, CDS VI/49). Figure lines are "
            "traditional (Western) asterism drawings: cultural, not physical.",
        }
        for name, f in (
            ("lines", "constellations.lines.json"),
            ("bounds", "constellations.bounds.json"),
            ("names", "constellations.json"),
        ):
            r = self.client.get(f"{D3_CELESTIAL}/{f}")
            r.raise_for_status()
            out[name] = r.json()
        self.storage.write_bytes(key, json.dumps(out).encode())
        return out
