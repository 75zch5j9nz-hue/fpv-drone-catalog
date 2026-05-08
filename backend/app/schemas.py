from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .models import ComponentRole, FileRole, ParseStatus, ROLE_DEFAULT_QUANTITY


# ── Manufacturer ──────────────────────────────────────────────────────────────

class ManufacturerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    website: str | None = None


class ManufacturerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    slug: str
    website: str | None
    created_at: datetime


# ── ProductCategory ───────────────────────────────────────────────────────────

class ProductCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    component_role: ComponentRole


class ProductCategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    slug: str
    component_role: str
    created_at: datetime


# ── ProductVariant ────────────────────────────────────────────────────────────

class ProductVariantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    specs: dict | None = None


class ProductVariantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    slug: str
    name: str
    specs: str | None
    is_active: bool
    created_at: datetime


# ── Product ───────────────────────────────────────────────────────────────────

class ProductCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    manufacturer_id: int | None = None
    category_id: int | None = None
    component_role: ComponentRole
    description: str | None = None
    specs: dict | None = None
    tags: str | None = None
    image_url: str | None = None
    product_url: str | None = None
    variants: list[ProductVariantCreate] = []


class ProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    slug: str
    name: str
    manufacturer_id: int | None
    category_id: int | None
    component_role: str
    description: str | None
    specs: str | None
    tags: str | None
    image_url: str | None
    product_url: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime
    manufacturer: ManufacturerOut | None
    category: ProductCategoryOut | None
    variants: list[ProductVariantOut]


class ProductListOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    slug: str
    name: str
    component_role: str
    tags: str | None
    image_url: str | None
    is_active: bool
    manufacturer: ManufacturerOut | None
    category: ProductCategoryOut | None
    variants: list[ProductVariantOut]


# ── InstalledComponent ────────────────────────────────────────────────────────

class InstalledComponentCreate(BaseModel):
    component_role: ComponentRole
    product_id: int | None = None
    product_variant_id: int | None = None
    custom_name: str | None = None
    custom_manufacturer: str | None = None
    custom_notes: str | None = None
    quantity: int | None = None
    firmware_version: str | None = None

    @model_validator(mode="after")
    def validate_source(self) -> "InstalledComponentCreate":
        if self.product_id is None and not self.custom_name:
            raise ValueError("Either product_id or custom_name must be provided")
        if self.quantity is None:
            role = self.component_role.value if hasattr(self.component_role, "value") else str(self.component_role)
            self.quantity = ROLE_DEFAULT_QUANTITY.get(role, 1)
        return self


class InstalledComponentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    build_version_id: int
    component_role: str
    product_id: int | None
    product_variant_id: int | None
    custom_name: str | None
    custom_manufacturer: str | None
    custom_notes: str | None
    quantity: int
    firmware_version: str | None
    installed_at: datetime
    removed_at: datetime | None
    product: ProductListOut | None
    product_variant: ProductVariantOut | None


# ── BuildVersion ──────────────────────────────────────────────────────────────

class BuildVersionCreate(BaseModel):
    name: str = Field(default="Initial build", min_length=1, max_length=160)
    notes: str | None = None
    components: list[InstalledComponentCreate] = []


class BuildVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    drone_id: int
    name: str
    notes: str | None
    is_current: bool
    created_at: datetime
    installed_components: list[InstalledComponentOut]





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
    image_url: str | None
    category: str | None
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
    # Appearance / classification
    image_url: str | None = None
    category: str | None = None
    # EASA regulatory
    operator_id: str | None = None
    registration_country: str | None = None
    registration_expiry: str | None = None
    remote_id_module: str | None = None
    # Hardware build (optional on creation)
    create_default_build: bool = False
    installed_components: list[InstalledComponentCreate] = []


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
    image_url: str | None = None
    category: str | None = None
    operator_id: str | None = None
    registration_country: str | None = None
    registration_expiry: str | None = None
    remote_id_module: str | None = None


class ReplaceComponentRequest(BaseModel):
    new_component: InstalledComponentCreate


class FlightNoteCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    note: str = Field(min_length=1)
    battery_id: int | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=600)
    battery_used_percent: int | None = Field(default=None, ge=1, le=100)


class FlightNoteUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    note: str | None = Field(default=None, min_length=1)
    battery_id: int | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=600)
    battery_used_percent: int | None = Field(default=None, ge=1, le=100)


class MaintenanceEventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    note: str = Field(min_length=1)
    event_type: str = "general"  # general | motor_swap | prop_change | frame_repair | fc_flash | crash
    damage_items: str | None = None   # JSON string: list of damaged part labels
    repair_cost_pln: int | None = Field(default=None, ge=0)


class MaintenanceEventUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    note: str | None = Field(default=None, min_length=1)
    event_type: str | None = None
    damage_items: str | None = None
    repair_cost_pln: int | None = Field(default=None, ge=0)


class PreflightItemCreate(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    order_idx: int = 0
    is_required: bool = True


class PreflightItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    drone_id: int
    label: str
    order_idx: int
    is_required: bool
    created_at: datetime


class ProductUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    manufacturer_id: int | None = None
    category_id: int | None = None
    description: str | None = None
    tags: str | None = None
    image_url: str | None = None
    product_url: str | None = None
    is_active: bool | None = None


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
    battery_id: int | None
    duration_minutes: int | None
    battery_used_percent: int | None
    created_at: datetime


class MaintenanceEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    note: str
    event_type: str
    damage_items: str | None
    repair_cost_pln: int | None
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
    image_url: str | None
    category: str | None
    operator_id: str | None
    registration_country: str | None
    registration_expiry: str | None
    remote_id_module: str | None
    current_build_version_id: int | None
    created_at: datetime
    updated_at: datetime
    snapshots: list[SnapshotOut]
    flight_notes: list[FlightNoteOut]
    maintenance_events: list[MaintenanceEventOut]
    current_hardware: list[InstalledComponentOut] = []


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

