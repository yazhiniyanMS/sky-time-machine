"""Survey adapter interface.

A survey adapter knows how to (1) find observations covering a sky position,
(2) fetch lightweight per-observation metadata, and (3) fetch image products
(cutouts) for processing. Everything downstream (registration, differencing,
detection) works on :class:`stm.science.fitsio.ImageProduct` objects, so a new
survey only needs an adapter plus a FITS reader that produces ImageProducts.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ObservationRecord:
    """One archived image product, exactly as described by the archive."""

    survey: str
    collection: str
    product_id: str  # unique per image product (SPHEREx: obs_id + detector)
    obs_id: str
    detector: int | None
    band_name: str
    em_min_um: float | None
    em_max_um: float | None
    t_min_mjd: float
    t_max_mjd: float
    exptime_s: float | None
    s_ra: float
    s_dec: float
    s_region: str
    access_url: str
    calib_level: int | None = None
    release_date: str | None = None
    cloud_access: str | None = None
    # Original archive row (all columns, as strings/numbers) for provenance.
    source_row: dict[str, Any] = field(default_factory=dict)

    @property
    def t_mid_mjd(self) -> float:
        return 0.5 * (self.t_min_mjd + self.t_max_mjd)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["t_mid_mjd"] = self.t_mid_mjd
        return d


class ArchiveError(RuntimeError):
    """Raised when the archive cannot be reached or returns invalid data."""


class SurveyAdapter(ABC):
    name: str

    @abstractmethod
    def query_position(self, ra: float, dec: float, radius_deg: float) -> list[ObservationRecord]:
        """Observations whose footprint intersects a circle on the sky."""

    @abstractmethod
    def fetch_cutout(self, record: ObservationRecord, ra: float, dec: float, size_deg: float) -> Path:
        """Download (or return cached) cutout; returns local FITS path."""

    @abstractmethod
    def describe(self) -> dict[str, Any]:
        """Static description of the survey / data release for provenance."""
