"""Runtime configuration (environment variables, prefixed STM_ unless noted)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="STM_", env_file=(REPO_ROOT / ".env", REPO_ROOT / "backend" / ".env"), extra="ignore"
    )

    data_dir: Path = Field(default=REPO_ROOT / "data", description="Local cache for FITS and derived products")
    database_url: str = Field(default="", description="SQLAlchemy URL; defaults to SQLite in data_dir")

    # Archive access
    irsa_sia_url: str = "https://irsa.ipac.caltech.edu/SIA"
    spherex_collection: str = "spherex_dr1"
    http_timeout_s: float = 120.0
    http_retries: int = 3

    # Cutouts
    default_cutout_deg: float = 0.1
    max_cutout_deg: float = 0.3

    # AI assistant (provider keys are read without the STM_ prefix too, see assistant/providers.py)
    assistant_provider: str = "auto"  # auto | anthropic | none
    assistant_model: str = "claude-opus-5-5"
    anthropic_api_key: str = Field(
        default="", validation_alias=AliasChoices("ANTHROPIC_API_KEY", "STM_ANTHROPIC_API_KEY"), repr=False
    )

    # Shared secret for moderators/reviewers (moderation and verification endpoints are disabled when empty)
    moderator_token: str = ""

    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{self.data_dir / 'stm.sqlite'}"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    return s
