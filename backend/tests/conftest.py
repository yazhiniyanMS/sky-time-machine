from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# Isolated data directory and database for the whole test session; must be set
# before stm.config is imported anywhere.
_TMP = Path(tempfile.mkdtemp(prefix="stm-test-"))
os.environ["STM_DATA_DIR"] = str(_TMP)
os.environ["STM_DATABASE_URL"] = f"sqlite:///{_TMP / 'test.sqlite'}"
os.environ["STM_ASSISTANT_PROVIDER"] = "none"
os.environ["STM_MODERATOR_TOKEN"] = "test-moderator-token"
sys.path.insert(0, str(Path(__file__).parent))

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def data_dir() -> Path:
    return _TMP


@pytest.fixture(scope="session", autouse=True)
def _db() -> None:
    from stm.db import init_db

    init_db()


@pytest.fixture
def real_cutout() -> Path:
    return FIXTURES / "spherex_dr1_m31_cutout_noepsf.fits"
