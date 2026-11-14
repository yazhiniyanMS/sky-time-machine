from __future__ import annotations

from collections import defaultdict
from functools import lru_cache
from typing import Any

import astropy.units as u
from astropy.coordinates import SkyCoord, get_constellation
from astropy.time import Time
from fastapi import APIRouter, HTTPException, Query

from stm.adapters.base import ArchiveError
from stm.adapters.spherex import SPHEREX_BANDS, SpherexAdapter
from stm.pipeline import spectral_timeline

router = APIRouter(prefix="/api", tags=["observations"])


@lru_cache
def adapter() -> SpherexAdapter:
    return SpherexAdapter()


@router.get("/survey")
def survey() -> dict[str, Any]:
    return adapter().describe()


@router.get("/resolve")
def resolve(name: str = Query(..., min_length=1, max_length=100)) -> dict[str, Any]:
    """Resolve an object name with the CDS Sesame service (via astropy)."""
    try:
        c = SkyCoord.from_name(name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"Could not resolve {name!r}: {e}") from e
    return {"name": name, "ra": float(c.icrs.ra.deg), "dec": float(c.icrs.dec.deg), "resolver": "CDS Sesame"}


@router.get("/constellation")
def constellation(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)) -> dict[str, Any]:
    """IAU constellation containing the position (astropy, Delporte boundaries precessed from B1875)."""
    c = SkyCoord(ra * u.deg, dec * u.deg, frame="icrs")
    return {"name": str(get_constellation(c)), "abbrev": str(get_constellation(c, short_name=True))}


@router.get("/observations")
def observations(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    radius: float = Query(0.01, gt=0, le=0.5),
) -> dict[str, Any]:
    """All SPHEREx Level 2 images whose footprint covers the position, grouped by exposure."""
    try:
        recs = adapter().query_position(ra, dec, radius)
    except ArchiveError as e:
        raise HTTPException(502, str(e)) from e
    by_obs: dict[str, list[Any]] = defaultdict(list)
    for r in recs:
        by_obs[r.obs_id].append(r)
    exposures = []
    for obs_id, rs in by_obs.items():
        t = rs[0].t_mid_mjd
        exposures.append(
            {
                "obs_id": obs_id,
                "t_mid_mjd": t,
                "date_iso": Time(t, format="mjd").isot,
                "exptime_s": rs[0].exptime_s,
                "products": [
                    {
                        "product_id": r.product_id,
                        "detector": r.detector,
                        "band": r.band_name,
                        "em_min_um": r.em_min_um,
                        "em_max_um": r.em_max_um,
                        "s_region": r.s_region,
                        "access_url": r.access_url,
                        "release_date": r.release_date,
                    }
                    for r in rs
                ],
            }
        )
    exposures.sort(key=lambda e: e["t_mid_mjd"])
    gaps = []
    for x, y in zip(exposures, exposures[1:], strict=False):
        dt = y["t_mid_mjd"] - x["t_mid_mjd"]
        if dt > 5:
            gaps.append({"from_mjd": x["t_mid_mjd"], "to_mjd": y["t_mid_mjd"], "days": dt})
    return {
        "query": {"ra": ra, "dec": dec, "radius_deg": radius},
        "source": adapter().describe(),
        "n_products": len(recs),
        "n_exposures": len(exposures),
        "detectors": {d: sum(1 for r in recs if r.detector == d) for d in SPHEREX_BANDS},
        "exposures": exposures,
        "coverage_gaps": gaps,
        "note": "Times are exposure midpoints from the archive (t_min/t_max). Gaps longer than 5 days are listed; "
        "no observations are interpolated.",
    }


@router.get("/observations/spectral")
def observations_spectral(
    ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90), detector: int = Query(..., ge=1, le=6)
) -> dict[str, Any]:
    try:
        return spectral_timeline(adapter(), ra, dec, detector)
    except ArchiveError as e:
        raise HTTPException(502, str(e)) from e
