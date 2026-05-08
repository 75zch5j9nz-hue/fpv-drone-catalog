from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .models import FileRole, ParseStatus


class DroneExportOut(BaseModel):
    id: int
    name: str
    slug: str
    frame: str | None
    stack: str | None
    motors: str | None
    props: str | None
    notes: str | None
    status: str
    auw_grams: int | None
    fc_target: str | None
    radio_link: str | None
    video_system: str | None
    operator_id: str | None
    registration_country: str | None
    registration_expiry: str | None
    remote_id_module: str | None
    snapshots: list[dict]
    flight_notes: list[dict]
    maintenance_events: list[dict]
    exported_at: str


class DroneCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    frame: str | None = None
    stack: str | None = None
    motors: str | None = None
    props: str | None = None
    notes: str | None = None
    # Extended hardware
    status: str | None = "flyable"
    auw_grams: int | None = None
    fc_target: str | None = None
    radio_link: str | None = None
    video_system: str | None = None
    # EASA regulatory
    operator_id: str | None = None
    registration_country: str | None = None
    registration_expiry: str | None = None
    remote_id_module: str | None = None


class DroneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    frame: str | None = None
    stack: str | None = None
    motors: str | None = None
    props: str | None = None
    notes: str | None = None
    status: str | None = None
    auw_grams: int | None = None
    fc_target: str | None = None
    radio_link: str | None = None
    video_system: str | None = None
    operator_id: str | None = None
    registration_country: str | None = None
    registration_expiry: str | None = None
    remote_id_module: str | None = None


class FlightNoteCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    note: str = Field(min_length=1)


class MaintenanceEventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    note: str = Field(min_length=1)


class SnapshotCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    betaflight_version: str | None = None
    notes: str | None = None


class SnapshotUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    betaflight_version: str | None = None
    notes: str | None = None


class BatteryCreate(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    cell_count: int = Field(ge=1, le=12)
    capacity_mah: int = Field(ge=1)
    chemistry: str = "lipo"
    cycle_count: int = Field(default=0, ge=0)
    purchase_date: str | None = None
    notes: str | None = None


class BatteryUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    cell_count: int | None = Field(default=None, ge=1, le=12)
    capacity_mah: int | None = Field(default=None, ge=1)
    chemistry: str | None = None
    cycle_count: int | None = Field(default=None, ge=0)
    purchase_date: str | None = None
    notes: str | None = None


class BatteryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    label: str
    cell_count: int
    capacity_mah: int
    chemistry: str
    cycle_count: int
    purchase_date: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class StoredFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: FileRole
    original_filename: str | None
    mime_type: str | None
    sha256: str
    size_bytes: int
    parse_status: ParseStatus
    text_excerpt: str | None
    created_at: datetime


class SnapshotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    betaflight_version: str | None
    notes: str | None
    is_current: bool
    is_known_good: bool
    created_at: datetime
    files: list[StoredFileOut]


class FlightNoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    note: str
    created_at: datetime


class MaintenanceEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    note: str
    created_at: datetime


class DroneOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    frame: str | None
    stack: str | None
    motors: str | None
    props: str | None
    notes: str | None
    status: str
    auw_grams: int | None
    fc_target: str | None
    radio_link: str | None
    video_system: str | None
    operator_id: str | None
    registration_country: str | None
    registration_expiry: str | None
    remote_id_module: str | None
    created_at: datetime
    updated_at: datetime
    snapshots: list[SnapshotOut]
    flight_notes: list[FlightNoteOut]
    maintenance_events: list[MaintenanceEventOut]


class CompareRequest(BaseModel):
    left_snapshot_id: int
    right_snapshot_id: int


class CompareResponse(BaseModel):
    left_snapshot_id: int
    right_snapshot_id: int
    added_lines: int
    removed_lines: int
    diff: str


class RawSnapshotFile(BaseModel):
    file_id: int
    role: FileRole
    original_filename: str | None
    content: str
    parsed_config: dict[str, Any] | None = None


class RawSnapshotResponse(BaseModel):
    snapshot_id: int
    files: list[RawSnapshotFile]

