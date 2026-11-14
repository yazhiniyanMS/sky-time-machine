"""Object-storage abstraction for FITS files and derived products.

Only a local-filesystem backend is implemented. Keys are POSIX-style relative
paths, so an S3/GCS backend can be added by implementing the same interface.
"""

from __future__ import annotations

import hashlib
import os
from abc import ABC, abstractmethod
from pathlib import Path


class ObjectStorage(ABC):
    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def read_bytes(self, key: str) -> bytes: ...

    @abstractmethod
    def write_bytes(self, key: str, data: bytes) -> None: ...

    @abstractmethod
    def local_path(self, key: str) -> Path:
        """Path usable by libraries that need a real file (astropy.io.fits)."""


class LocalStorage(ObjectStorage):
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents and p != self.root.resolve():
            raise ValueError(f"storage key escapes root: {key!r}")
        return p

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def read_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def write_bytes(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    def local_path(self, key: str) -> Path:
        return self._path(key)


def stable_key(*parts: object) -> str:
    """Deterministic short hash for cache keys."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return h[:20]
