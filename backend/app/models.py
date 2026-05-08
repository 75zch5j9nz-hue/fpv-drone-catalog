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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="drone", cascade="all, delete-orphan")
    flight_notes: Mapped[list["FlightNote"]] = relationship(back_populates="drone", cascade="all, delete-orphan")
    maintenance_events: Mapped[list["MaintenanceEvent"]] = relationship(back_populates="drone", cascade="all, delete-orphan")


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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    drone: Mapped[Drone] = relationship(back_populates="flight_notes")


class MaintenanceEvent(Base):
    __tablename__ = "maintenance_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    drone_id: Mapped[int] = mapped_column(ForeignKey("drones.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    note: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    drone: Mapped[Drone] = relationship(back_populates="maintenance_events")
