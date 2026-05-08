from datetime import datetime
from enum import Enum

from sqlalchemy import Boolean, DateTime, Enum as SqlEnum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class FileRole(str, Enum):
    dump = "dump"
    diff_all = "diff_all"
    status = "status"
    version = "version"
    photo = "photo"
    blackbox = "blackbox"
    misc = "misc"


class ParseStatus(str, Enum):
    pending = "pending"
    parsed = "parsed"
    unsupported = "unsupported"


class DroneStatus(str, Enum):
    flyable = "flyable"
    needs_repair = "needs_repair"
    grounded_crash = "grounded_crash"
    in_build = "in_build"
    retired = "retired"
    for_parts = "for_parts"


class BatteryChemistry(str, Enum):
    lipo = "lipo"
    lihv = "lihv"
    li_ion = "li_ion"


class ComponentRole(str, Enum):
    FRAME = "FRAME"
    FLIGHT_CONTROLLER = "FLIGHT_CONTROLLER"
    ESC = "ESC"
    FC_ESC_STACK = "FC_ESC_STACK"
    AIO_BOARD = "AIO_BOARD"
    MOTOR = "MOTOR"
    PROPELLER = "PROPELLER"
    RECEIVER = "RECEIVER"
    VTX_VIDEO_UNIT = "VTX_VIDEO_UNIT"
    CAMERA = "CAMERA"
    ANTENNA = "ANTENNA"
    GPS = "GPS"
    BATTERY = "BATTERY"
    ACCESSORY = "ACCESSORY"
    OTHER = "OTHER"


# Default quantity per role
ROLE_DEFAULT_QUANTITY: dict[str, int] = {
    "MOTOR": 4,
    "PROPELLER": 4,
}


class Manufacturer(Base):
    __tablename__ = "manufacturers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    slug: Mapped[str] = mapped_column(String(140), unique=True, index=True)
    website: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    products: Mapped[list["Product"]] = relationship(back_populates="manufacturer")


class ProductCategory(Base):
    __tablename__ = "product_categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    component_role: Mapped[str] = mapped_column(String(32))  # maps to ComponentRole
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    products: Mapped[list["Product"]] = relationship(back_populates="category")


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    slug: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    manufacturer_id: Mapped[int | None] = mapped_column(ForeignKey("manufacturers.id", ondelete="SET NULL"), nullable=True, index=True)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("product_categories.id", ondelete="SET NULL"), nullable=True, index=True)
    component_role: Mapped[str] = mapped_column(String(32))  # denormalized for fast filtering
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    specs: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON blob
    tags: Mapped[str | None] = mapped_column(String(512), nullable=True)  # comma-separated
    image_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    product_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    manufacturer: Mapped["Manufacturer | None"] = relationship(back_populates="products")
    category: Mapped["ProductCategory | None"] = relationship(back_populates="products")
    variants: Mapped[list["ProductVariant"]] = relationship(back_populates="product", cascade="all, delete-orphan")
    installed_components: Mapped[list["InstalledComponent"]] = relationship(back_populates="product")


class ProductVariant(Base):
    __tablename__ = "product_variants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    slug: Mapped[str] = mapped_column(String(240), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    specs: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON blob of variant-specific specs
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    product: Mapped["Product"] = relationship(back_populates="variants")
    installed_components: Mapped[list["InstalledComponent"]] = relationship(back_populates="product_variant")


class Drone(Base):
    __tablename__ = "drones"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    slug: Mapped[str] = mapped_column(String(140), unique=True, index=True)
    frame: Mapped[str | None] = mapped_column(String(120), nullable=True)
    stack: Mapped[str | None] = mapped_column(String(120), nullable=True)
    motors: Mapped[str | None] = mapped_column(String(120), nullable=True)
    props: Mapped[str | None] = mapped_column(String(120), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Extended hardware fields (from community research)
    status: Mapped[str] = mapped_column(String(32), default=DroneStatus.flyable.value)
    auw_grams: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fc_target: Mapped[str | None] = mapped_column(String(80), nullable=True)
    radio_link: Mapped[str | None] = mapped_column(String(80), nullable=True)
    video_system: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # Appearance / classification
    image_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # EASA / EU regulatory fields
    operator_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    registration_country: Mapped[str | None] = mapped_column(String(10), nullable=True)
    registration_expiry: Mapped[str | None] = mapped_column(String(20), nullable=True)
    remote_id_module: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Current build version FK (set after build_version is created)
    current_build_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="drone", cascade="all, delete-orphan")
    flight_notes: Mapped[list["FlightNote"]] = relationship(back_populates="drone", cascade="all, delete-orphan")
    maintenance_events: Mapped[list["MaintenanceEvent"]] = relationship(back_populates="drone", cascade="all, delete-orphan")
    build_versions: Mapped[list["BuildVersion"]] = relationship(back_populates="drone", cascade="all, delete-orphan", foreign_keys="BuildVersion.drone_id")


class Battery(Base):
    __tablename__ = "batteries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    label: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    cell_count: Mapped[int] = mapped_column(Integer)
    capacity_mah: Mapped[int] = mapped_column(Integer)
    chemistry: Mapped[str] = mapped_column(String(16), default=BatteryChemistry.lipo.value)
    cycle_count: Mapped[int] = mapped_column(Integer, default=0)
    purchase_date: Mapped[str | None] = mapped_column(String(20), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Health tracking
    batt_status: Mapped[str] = mapped_column(String(16), default="active")  # active|watchlist|retired|damaged
    is_puffed: Mapped[bool] = mapped_column(Boolean, default=False)
    internal_resistance_mohm: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Snapshot(Base):
    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    drone_id: Mapped[int] = mapped_column(ForeignKey("drones.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    slug: Mapped[str] = mapped_column(String(180), index=True)
    betaflight_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_current: Mapped[bool] = mapped_column(Boolean, default=False)
    is_known_good: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    drone: Mapped[Drone] = relationship(back_populates="snapshots")
    files: Mapped[list["StoredFile"]] = relationship(back_populates="snapshot", cascade="all, delete-orphan")


class StoredFile(Base):
    __tablename__ = "stored_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    drone_id: Mapped[int] = mapped_column(ForeignKey("drones.id", ondelete="CASCADE"), index=True)
    snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("snapshots.id", ondelete="SET NULL"), nullable=True, index=True)
    role: Mapped[FileRole] = mapped_column(SqlEnum(FileRole), default=FileRole.misc)
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stored_filename: Mapped[str] = mapped_column(String(255), unique=True)
    relative_path: Mapped[str] = mapped_column(String(600), unique=True)
    mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    size_bytes: Mapped[int] = mapped_column(Integer)
    parse_status: Mapped[ParseStatus] = mapped_column(SqlEnum(ParseStatus), default=ParseStatus.pending)
    text_excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    snapshot: Mapped[Snapshot | None] = relationship(back_populates="files")


class FlightNote(Base):
    __tablename__ = "flight_notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    drone_id: Mapped[int] = mapped_column(ForeignKey("drones.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    note: Mapped[str] = mapped_column(Text)
    # Battery linkage + session metadata
    battery_id: Mapped[int | None] = mapped_column(ForeignKey("batteries.id", ondelete="SET NULL"), nullable=True, index=True)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    battery_used_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    drone: Mapped[Drone] = relationship(back_populates="flight_notes")
    battery: Mapped["Battery | None"] = relationship()


class MaintenanceEvent(Base):
    __tablename__ = "maintenance_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    drone_id: Mapped[int] = mapped_column(ForeignKey("drones.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    note: Mapped[str] = mapped_column(Text)
    # Event classification + crash report fields
    event_type: Mapped[str] = mapped_column(String(32), default="general")
    damage_items: Mapped[str | None] = mapped_column(Text, nullable=True)   # JSON list of damaged parts
    repair_cost_pln: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    drone: Mapped[Drone] = relationship(back_populates="maintenance_events")


class PreflightChecklistItem(Base):
    __tablename__ = "preflight_checklist_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    drone_id: Mapped[int] = mapped_column(ForeignKey("drones.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(160))
    order_idx: Mapped[int] = mapped_column(Integer, default=0)
    is_required: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    drone: Mapped[Drone] = relationship()


class BuildVersion(Base):
    __tablename__ = "build_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    drone_id: Mapped[int] = mapped_column(ForeignKey("drones.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160), default="Initial build")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    drone: Mapped["Drone"] = relationship(back_populates="build_versions", foreign_keys=[drone_id])
    installed_components: Mapped[list["InstalledComponent"]] = relationship(back_populates="build_version", cascade="all, delete-orphan")


class InstalledComponent(Base):
    __tablename__ = "installed_components"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    build_version_id: Mapped[int] = mapped_column(ForeignKey("build_versions.id", ondelete="CASCADE"), index=True)
    component_role: Mapped[str] = mapped_column(String(32))  # ComponentRole value
    # Catalogue reference (optional — null if custom part)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True)
    product_variant_id: Mapped[int | None] = mapped_column(ForeignKey("product_variants.id", ondelete="SET NULL"), nullable=True, index=True)
    # Custom/manual part fields
    custom_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    custom_manufacturer: Mapped[str | None] = mapped_column(String(120), nullable=True)
    custom_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    firmware_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    installed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    removed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    build_version: Mapped["BuildVersion"] = relationship(back_populates="installed_components")
    product: Mapped["Product | None"] = relationship(back_populates="installed_components")
    product_variant: Mapped["ProductVariant | None"] = relationship(back_populates="installed_components")


class SpareStock(Base):
    """Spare parts inventory."""
    __tablename__ = "spare_stock"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    part_name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str | None] = mapped_column(String(60), nullable=True)   # props, motors, fc, esc, frame, other
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    low_stock_threshold: Mapped[int] = mapped_column(Integer, default=2)
    drone_id: Mapped[int | None] = mapped_column(ForeignKey("drones.id", ondelete="SET NULL"), nullable=True, index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
