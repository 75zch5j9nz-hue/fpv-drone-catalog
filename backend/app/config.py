from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    postgres_db: str = "fpv_catalog"
    postgres_user: str = "fpv_user"
    postgres_password: str = "change_me"
    database_url: str = "postgresql+psycopg://fpv_user:change_me@postgres:5432/fpv_catalog"
    upload_dir: str = "/app/storage/uploads"
    export_dir: str = "/app/storage/exports"
    max_upload_mb: int = 100
    app_env: str = "production"
    app_url: str = "http://localhost:3000"
    api_url: str = "http://localhost:8000"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def upload_path(self) -> Path:
        return Path(self.upload_dir)

    @property
    def export_path(self) -> Path:
        return Path(self.export_dir)


@lru_cache
def get_settings() -> Settings:
    return Settings()
