import hashlib
import mimetypes
from pathlib import Path
from uuid import uuid4

from slugify import slugify

from .config import get_settings
from .models import FileRole, ParseStatus


TEXT_ROLES = {FileRole.dump, FileRole.diff_all, FileRole.status, FileRole.version, FileRole.misc}


def ensure_storage_dirs() -> None:
    settings = get_settings()
    settings.upload_path.mkdir(parents=True, exist_ok=True)
    settings.export_path.mkdir(parents=True, exist_ok=True)


def safe_slug(value: str, fallback: str) -> str:
    slug = slugify(value)
    return slug or fallback


def build_relative_path(drone_slug: str, snapshot_slug: str | None, role: FileRole, original_name: str | None) -> tuple[str, str]:
    extension = Path(original_name or f"{role.value}.txt").suffix or ".txt"
    stored_filename = f"{uuid4().hex}{extension.lower()}"
    base_path = Path("drones") / drone_slug
    if snapshot_slug:
        base_path = base_path / "snapshots" / snapshot_slug
    else:
        base_path = base_path / "misc"
    return str(base_path / stored_filename), stored_filename


def detect_mime_type(filename: str | None) -> str:
    if not filename:
        return "application/octet-stream"
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def write_bytes(relative_path: str, data: bytes) -> Path:
    destination = get_settings().upload_path / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return destination


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_status_for_role(role: FileRole) -> ParseStatus:
    return ParseStatus.parsed if role in TEXT_ROLES else ParseStatus.unsupported


def excerpt_text(data: bytes, role: FileRole) -> str | None:
    if role not in TEXT_ROLES:
        return None
    return data.decode("utf-8", errors="replace")[:5000]
