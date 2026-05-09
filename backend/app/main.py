import difflib
import io
import re
import shutil
import urllib.request
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from .config import get_settings
from .db import Base, engine, get_db
from .models import Battery, BuildVersion, Drone, ElrsProfile, FileRole, FlightNote, InstalledComponent, MaintenanceAlert, MaintenanceEvent, Manufacturer, PreflightChecklistItem, Product, ProductCategory, ProductVariant, Snapshot, SpareStock, StoredFile, User
from .parser import parse_betaflight_config

_BF_VERSION_RE = re.compile(r"Betaflight\s*/\s*(?:INAV\s*/\s*)?[^/]+\s+([0-9]+\.[0-9]+\.[0-9]+)", re.IGNORECASE)
from .schemas import (
    BatteryCreate,
    BatteryOut,
    BatteryUpdate,
    BuildVersionCreate,
    BuildVersionOut,
    CompareRequest,
    CompareResponse,
    DroneCreate,
    DroneOut,
    DroneUpdate,
    FlightNoteCreate,
    FlightNoteOut,
    FlightNoteUpdate,
    MaintenanceEventUpdate,
    PreflightItemCreate,
    PreflightItemOut,
    ProductUpdate,
    InstalledComponentCreate,
    InstalledComponentOut,
    MaintenanceEventCreate,
    MaintenanceEventOut,
    ManufacturerCreate,
    ManufacturerOut,
    ProductCategoryCreate,
    ProductCategoryOut,
    ProductCreate,
    ProductListOut,
    ProductOut,
    ProductVariantCreate,
    ProductVariantOut,
    RawSnapshotFile,
    RawSnapshotResponse,
    ReplaceComponentRequest,
    SnapshotCreate,
    SnapshotOut,
    SnapshotUpdate,
    DroneFlightStats,
    ElrsProfileCreate,
    ElrsProfileOut,
    MaintenanceAlertCreate,
    MaintenanceAlertOut,
    OsdImportResult,
    SpareStockCreate,
    SpareStockOut,
    SpareStockUpdate,
    StoredFileOut,
    TokenResponse,
    UserCreate,
    UserOut,
)
from .storage import (
    build_relative_path,
    detect_mime_type,
    ensure_storage_dirs,
    excerpt_text,
    parse_status_for_role,
    safe_slug,
    sha256_hex,
    write_bytes,
)

settings = get_settings()
app = FastAPI(
    title="FPV Drone Catalog API",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.app_url, "http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _run_migrations() -> None:
    """Add new columns to existing tables idempotently (PostgreSQL ADD COLUMN IF NOT EXISTS)."""
    new_drone_columns = [
        ("status", "VARCHAR(32) DEFAULT 'flyable'"),
        ("auw_grams", "INTEGER"),
        ("fc_target", "VARCHAR(80)"),
        ("radio_link", "VARCHAR(80)"),
        ("video_system", "VARCHAR(80)"),
        ("operator_id", "VARCHAR(80)"),
        ("registration_country", "VARCHAR(10)"),
        ("registration_expiry", "VARCHAR(20)"),
        ("remote_id_module", "VARCHAR(120)"),
        ("image_url", "VARCHAR(512)"),
        ("category", "VARCHAR(80)"),
        ("current_build_version_id", "INTEGER"),
    ]
    new_flight_note_columns = [
        ("battery_id", "INTEGER REFERENCES batteries(id) ON DELETE SET NULL"),
        ("duration_minutes", "INTEGER"),
        ("battery_used_percent", "INTEGER"),
    ]
    new_maintenance_columns = [
        ("event_type", "VARCHAR(32) DEFAULT 'general'"),
        ("damage_items", "TEXT"),
        ("repair_cost_pln", "INTEGER"),
    ]
    new_battery_columns = [
        ("batt_status", "VARCHAR(16) DEFAULT 'active'"),
        ("is_puffed", "BOOLEAN DEFAULT FALSE"),
        ("internal_resistance_mohm", "INTEGER"),
        ("ir_c1_mohm", "INTEGER"),
        ("ir_c2_mohm", "INTEGER"),
        ("ir_c3_mohm", "INTEGER"),
        ("ir_c4_mohm", "INTEGER"),
        ("ir_c5_mohm", "INTEGER"),
        ("ir_c6_mohm", "INTEGER"),
        ("last_charged_at", "TIMESTAMP"),
        ("voltage_after_last_flight", "REAL"),
        ("assigned_drone_id", "INTEGER REFERENCES drones(id) ON DELETE SET NULL"),
    ]
    new_flight_note_columns_v2 = [
        ("flight_date", "VARCHAR(20)"),
        ("location", "VARCHAR(200)"),
        ("wind_speed_kmh", "INTEGER"),
        ("temperature_c", "INTEGER"),
        ("outcome", "VARCHAR(32) DEFAULT 'ok'"),
        ("motor_temps", "VARCHAR(64)"),
        ("battery_voltage_after", "REAL"),
    ]
    new_maintenance_columns_v2 = [
        ("crash_severity", "VARCHAR(20)"),
        ("spare_parts_used", "TEXT"),
    ]
    with engine.connect() as conn:
        for col, typedef in new_drone_columns:
            conn.execute(text(f"ALTER TABLE drones ADD COLUMN IF NOT EXISTS {col} {typedef}"))
        for col, typedef in new_flight_note_columns:
            conn.execute(text(f"ALTER TABLE flight_notes ADD COLUMN IF NOT EXISTS {col} {typedef}"))
        for col, typedef in new_flight_note_columns_v2:
            conn.execute(text(f"ALTER TABLE flight_notes ADD COLUMN IF NOT EXISTS {col} {typedef}"))
        for col, typedef in new_maintenance_columns:
            conn.execute(text(f"ALTER TABLE maintenance_events ADD COLUMN IF NOT EXISTS {col} {typedef}"))
        for col, typedef in new_maintenance_columns_v2:
            conn.execute(text(f"ALTER TABLE maintenance_events ADD COLUMN IF NOT EXISTS {col} {typedef}"))
        for col, typedef in new_battery_columns:
            conn.execute(text(f"ALTER TABLE batteries ADD COLUMN IF NOT EXISTS {col} {typedef}"))
        # For each drone that has snapshots but none marked current, mark the newest one
        conn.execute(text("""
            UPDATE snapshots SET is_current = TRUE
            WHERE id IN (
                SELECT DISTINCT ON (drone_id) id
                FROM snapshots
                WHERE drone_id NOT IN (
                    SELECT DISTINCT drone_id FROM snapshots WHERE is_current = TRUE
                )
                ORDER BY drone_id, created_at DESC
            )
        """))
        conn.commit()


@app.on_event("startup")
def startup() -> None:
    ensure_storage_dirs()
    Base.metadata.create_all(bind=engine)
    _run_migrations()


def drone_query():
    return (
        select(Drone)
        .options(
            selectinload(Drone.snapshots).selectinload(Snapshot.files),
            selectinload(Drone.flight_notes),
            selectinload(Drone.maintenance_events),
            selectinload(Drone.build_versions).selectinload(BuildVersion.installed_components).selectinload(InstalledComponent.product).selectinload(Product.manufacturer),
            selectinload(Drone.build_versions).selectinload(BuildVersion.installed_components).selectinload(InstalledComponent.product).selectinload(Product.category),
            selectinload(Drone.build_versions).selectinload(BuildVersion.installed_components).selectinload(InstalledComponent.product).selectinload(Product.variants),
            selectinload(Drone.build_versions).selectinload(BuildVersion.installed_components).selectinload(InstalledComponent.product_variant),
        )
        .order_by(Drone.created_at.desc())
    )


def _get_current_hardware(drone: Drone) -> list[InstalledComponent]:
    """Return active components from the current build version."""
    if not drone.current_build_version_id:
        return []
    for bv in drone.build_versions:
        if bv.id == drone.current_build_version_id:
            return [c for c in bv.installed_components if c.removed_at is None]
    return []


def get_drone_or_404(db: Session, drone_id: int) -> Drone:
    drone = db.execute(drone_query().where(Drone.id == drone_id)).scalar_one_or_none()
    if not drone:
        raise HTTPException(status_code=404, detail="Drone not found")
    return drone


def get_snapshot_or_404(db: Session, snapshot_id: int) -> Snapshot:
    snapshot = db.execute(select(Snapshot).options(selectinload(Snapshot.files)).where(Snapshot.id == snapshot_id)).scalar_one_or_none()
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return snapshot


def serialize_drone(db: Session, drone_id: int) -> dict:
    drone = get_drone_or_404(db, drone_id)
    data = DroneOut.model_validate(drone).model_dump()
    data["current_hardware"] = [
        InstalledComponentOut.model_validate(c).model_dump() for c in _get_current_hardware(drone)
    ]
    return data


def next_unique_slug(db: Session, model, base_slug: str, scope_column=None, scope_value=None, current_id: int | None = None) -> str:
    slug = base_slug
    suffix = 2
    while True:
        query = select(model).where(model.slug == slug)
        if scope_column is not None:
            query = query.where(scope_column == scope_value)
        existing = db.execute(query).scalar_one_or_none()
        if existing is None or existing.id == current_id:
            return slug
        slug = f"{base_slug}-{suffix}"
        suffix += 1


def delete_drone_storage(drone_slug: str) -> None:
    drone_dir = settings.upload_path / "drones" / drone_slug
    if drone_dir.exists():
        shutil.rmtree(drone_dir)


def read_snapshot_text(snapshot: Snapshot) -> tuple[list[str], str]:
    collected: list[str] = []
    for stored_file in snapshot.files:
        file_path = settings.upload_path / stored_file.relative_path
        if file_path.exists() and stored_file.role in {FileRole.dump, FileRole.diff_all, FileRole.status, FileRole.version, FileRole.misc}:
            content = file_path.read_text(encoding="utf-8", errors="replace")
            collected.extend(content.splitlines())
    combined = "\n".join(collected)
    return collected, combined


@app.get("/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.execute(text("SELECT 1"))
    ensure_storage_dirs()
    writable = settings.upload_path.exists() and settings.export_path.exists()
    return {
        "status": "ok",
        "database": "connected",
        "uploadDir": "writable" if writable else "missing",
    }


_PROXY_ALLOWED_HOST = "iflight.oss-cn-hongkong.aliyuncs.com"


@app.get("/api/stats")
def get_stats(db: Session = Depends(get_db)) -> dict:
    from sqlalchemy import func
    total_drones = db.execute(select(func.count()).select_from(Drone)).scalar_one()
    flyable = db.execute(select(func.count()).select_from(Drone).where(Drone.status == "flyable")).scalar_one()
    total_snapshots = db.execute(select(func.count()).select_from(Snapshot)).scalar_one()
    total_batteries = db.execute(select(func.count()).select_from(Battery)).scalar_one()
    total_products = db.execute(select(func.count()).select_from(Product)).scalar_one()
    total_flights = db.execute(select(func.count()).select_from(FlightNote)).scalar_one()
    total_maintenance = db.execute(select(func.count()).select_from(MaintenanceEvent)).scalar_one()
    # Video system breakdown
    video_rows = db.execute(
        select(Drone.video_system, func.count().label("cnt"))
        .where(Drone.video_system.isnot(None))
        .group_by(Drone.video_system)
        .order_by(func.count().desc())
    ).all()
    # Category breakdown
    cat_rows = db.execute(
        select(Drone.category, func.count().label("cnt"))
        .where(Drone.category.isnot(None))
        .group_by(Drone.category)
        .order_by(func.count().desc())
    ).all()
    return {
        "drones": {"total": total_drones, "flyable": flyable, "grounded": total_drones - flyable},
        "snapshots": total_snapshots,
        "batteries": total_batteries,
        "products": total_products,
        "flights": total_flights,
        "maintenance": total_maintenance,
        "by_video": {row.video_system: row.cnt for row in video_rows},
        "by_category": {row.category: row.cnt for row in cat_rows},
    }


_PROXY_ALLOWED_HOST = "iflight.oss-cn-hongkong.aliyuncs.com"
_PROXY_REFERER = "https://shop.iflight.com/"


@app.get("/api/proxy-image")
async def proxy_image(url: str) -> Response:
    """Proxy manufacturer CDN images that require a specific Referer header."""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.netloc != _PROXY_ALLOWED_HOST:
        raise HTTPException(status_code=400, detail="URL not allowed")

    def _fetch():
        req = urllib.request.Request(url, headers={"Referer": _PROXY_REFERER, "User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            content_type = resp.headers.get("Content-Type", "image/jpeg")
            return resp.read(), content_type

    try:
        data, content_type = await run_in_threadpool(_fetch)
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to fetch image")
    return Response(content=data, media_type=content_type)


@app.get("/api/drones", response_model=list[DroneOut])
def list_drones(db: Session = Depends(get_db)) -> list[dict]:
    drones = list(db.execute(drone_query()).scalars().unique())
    return [serialize_drone(db, d.id) for d in drones]


def _validate_component_products(db: Session, comp_data: InstalledComponentCreate) -> None:
    """Verify product_id and product_variant_id exist in the catalogue."""
    if comp_data.product_id is not None:
        p = db.execute(select(Product).where(Product.id == comp_data.product_id)).scalar_one_or_none()
        if not p:
            raise HTTPException(status_code=422, detail=f"Product id={comp_data.product_id} not found in catalogue")
    if comp_data.product_variant_id is not None:
        pv = db.execute(select(ProductVariant).where(ProductVariant.id == comp_data.product_variant_id)).scalar_one_or_none()
        if not pv:
            raise HTTPException(status_code=422, detail=f"ProductVariant id={comp_data.product_variant_id} not found")


@app.post("/api/drones", response_model=DroneOut, status_code=201)
def create_drone(payload: DroneCreate, db: Session = Depends(get_db)) -> dict:
    base_slug = safe_slug(payload.name, "drone")
    exists = db.execute(select(Drone).where(Drone.name == payload.name)).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=409, detail="Drone already exists")
    slug = next_unique_slug(db, Drone, base_slug)
    drone = Drone(
        name=payload.name,
        slug=slug,
        frame=payload.frame,
        stack=payload.stack,
        motors=payload.motors,
        props=payload.props,
        notes=payload.notes,
        status=payload.status or "flyable",
        auw_grams=payload.auw_grams,
        fc_target=payload.fc_target,
        radio_link=payload.radio_link,
        video_system=payload.video_system,
        image_url=payload.image_url,
        category=payload.category,
        operator_id=payload.operator_id,
        registration_country=payload.registration_country,
        registration_expiry=payload.registration_expiry,
        remote_id_module=payload.remote_id_module,
    )
    db.add(drone)
    db.flush()  # get drone.id

    if payload.create_default_build or payload.installed_components:
        build = BuildVersion(drone_id=drone.id, name="Initial build", is_current=True)
        db.add(build)
        db.flush()
        for comp_data in payload.installed_components:
            _validate_component_products(db, comp_data)
            role = comp_data.component_role.value if hasattr(comp_data.component_role, "value") else str(comp_data.component_role)
            qty = comp_data.quantity if comp_data.quantity is not None else 1
            comp = InstalledComponent(
                build_version_id=build.id,
                component_role=role,
                product_id=comp_data.product_id,
                product_variant_id=comp_data.product_variant_id,
                custom_name=comp_data.custom_name,
                custom_manufacturer=comp_data.custom_manufacturer,
                custom_notes=comp_data.custom_notes,
                quantity=qty,
                firmware_version=comp_data.firmware_version,
            )
            db.add(comp)
        drone.current_build_version_id = build.id

    db.commit()
    db.refresh(drone)
    return serialize_drone(db, drone.id)


@app.get("/api/drones/{drone_id}", response_model=DroneOut)
def get_drone(drone_id: int, db: Session = Depends(get_db)) -> dict:
    return serialize_drone(db, drone_id)


@app.patch("/api/drones/{drone_id}", response_model=DroneOut)
def update_drone(drone_id: int, payload: DroneUpdate, db: Session = Depends(get_db)) -> dict:
    drone = db.execute(select(Drone).where(Drone.id == drone_id)).scalar_one_or_none()
    if not drone:
        raise HTTPException(status_code=404, detail="Drone not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == "name" and value:
            existing = db.execute(select(Drone).where(Drone.name == value, Drone.id != drone_id)).scalar_one_or_none()
            if existing:
                raise HTTPException(status_code=409, detail="Drone already exists")
            drone.slug = next_unique_slug(db, Drone, safe_slug(value, drone.slug), current_id=drone_id)
        setattr(drone, field, value)
    db.commit()
    return serialize_drone(db, drone_id)


@app.delete("/api/drones/{drone_id}", status_code=204)
def delete_drone(drone_id: int, db: Session = Depends(get_db)) -> None:
    drone = db.execute(select(Drone).where(Drone.id == drone_id)).scalar_one_or_none()
    if not drone:
        raise HTTPException(status_code=404, detail="Drone not found")
    drone_slug = drone.slug
    db.delete(drone)
    db.commit()
    delete_drone_storage(drone_slug)


@app.get("/api/drones/{drone_id}/snapshots", response_model=list[SnapshotOut])
def list_snapshots(drone_id: int, db: Session = Depends(get_db)) -> list[Snapshot]:
    drone = get_drone_or_404(db, drone_id)
    return sorted(drone.snapshots, key=lambda snapshot: snapshot.created_at, reverse=True)


@app.post("/api/drones/{drone_id}/snapshots", response_model=SnapshotOut, status_code=201)
def create_snapshot(drone_id: int, payload: SnapshotCreate, db: Session = Depends(get_db)) -> Snapshot:
    drone = get_drone_or_404(db, drone_id)
    base_slug = safe_slug(payload.name, f"snapshot-{drone.id}")
    existing_count = db.execute(
        select(Snapshot).where(Snapshot.drone_id == drone.id)
    ).scalars().all()
    is_first = len(existing_count) == 0
    snapshot = Snapshot(
        drone_id=drone.id,
        name=payload.name,
        slug=next_unique_slug(db, Snapshot, base_slug, scope_column=Snapshot.drone_id, scope_value=drone.id),
        betaflight_version=payload.betaflight_version,
        notes=payload.notes,
        is_current=is_first,
    )
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return get_snapshot_or_404(db, snapshot.id)


@app.post("/api/snapshots/{snapshot_id}/mark-current", response_model=SnapshotOut)
def mark_snapshot_current(snapshot_id: int, db: Session = Depends(get_db)) -> Snapshot:
    snapshot = get_snapshot_or_404(db, snapshot_id)
    db.execute(text("UPDATE snapshots SET is_current = false WHERE drone_id = :drone_id"), {"drone_id": snapshot.drone_id})
    snapshot.is_current = True
    db.commit()
    return get_snapshot_or_404(db, snapshot_id)


@app.post("/api/snapshots/{snapshot_id}/mark-known-good", response_model=SnapshotOut)
def mark_snapshot_known_good(snapshot_id: int, db: Session = Depends(get_db)) -> Snapshot:
    snapshot = get_snapshot_or_404(db, snapshot_id)
    db.execute(text("UPDATE snapshots SET is_known_good = false WHERE drone_id = :drone_id"), {"drone_id": snapshot.drone_id})
    snapshot.is_known_good = True
    db.commit()
    return get_snapshot_or_404(db, snapshot_id)


@app.delete("/api/snapshots/{snapshot_id}", status_code=204)
def delete_snapshot(snapshot_id: int, db: Session = Depends(get_db)) -> None:
    snapshot = db.execute(select(Snapshot).options(selectinload(Snapshot.files)).where(Snapshot.id == snapshot_id)).scalar_one_or_none()
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    # Remove stored files from disk
    for stored_file in snapshot.files:
        file_path = settings.upload_path / stored_file.relative_path
        if file_path.exists():
            file_path.unlink()
    db.delete(snapshot)
    db.commit()


@app.patch("/api/snapshots/{snapshot_id}", response_model=SnapshotOut)
def update_snapshot(snapshot_id: int, payload: SnapshotUpdate, db: Session = Depends(get_db)) -> Snapshot:
    snapshot = get_snapshot_or_404(db, snapshot_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(snapshot, field, value)
    db.commit()
    return get_snapshot_or_404(db, snapshot_id)


@app.delete("/api/files/{file_id}", status_code=204)
def delete_file(file_id: int, db: Session = Depends(get_db)) -> None:
    stored_file = db.execute(select(StoredFile).where(StoredFile.id == file_id)).scalar_one_or_none()
    if not stored_file:
        raise HTTPException(status_code=404, detail="File not found")
    file_path = settings.upload_path / stored_file.relative_path
    if file_path.exists():
        file_path.unlink()
    db.delete(stored_file)
    db.commit()


@app.post("/api/drones/{drone_id}/uploads", response_model=StoredFileOut, status_code=201)
async def upload_file(
    drone_id: int,
    file: UploadFile | None = File(default=None),
    rawText: str | None = Form(default=None),
    exportType: FileRole = Form(default=FileRole.misc),
    snapshotName: str | None = Form(default=None),
    snapshotId: int | None = Form(default=None),
    db: Session = Depends(get_db),
) -> StoredFile:
    drone = get_drone_or_404(db, drone_id)
    snapshot: Snapshot | None = None
    if snapshotId:
        snapshot = get_snapshot_or_404(db, snapshotId)
        if snapshot.drone_id != drone.id:
            raise HTTPException(status_code=400, detail="Snapshot does not belong to drone")
    elif snapshotName:
        base_slug = safe_slug(snapshotName, f"snapshot-{drone.id}")
        snapshot = Snapshot(
            drone_id=drone.id,
            name=snapshotName,
            slug=next_unique_slug(db, Snapshot, base_slug, scope_column=Snapshot.drone_id, scope_value=drone.id),
        )
        db.add(snapshot)
        db.flush()

    if file is None and not rawText:
        raise HTTPException(status_code=400, detail="Provide a file or rawText")

    if file is not None:
        data = await file.read()
        original_filename = file.filename or f"{exportType.value}.txt"
        mime_type = file.content_type or detect_mime_type(file.filename)
    else:
        data = rawText.encode("utf-8")
        original_filename = f"{exportType.value}.txt"
        mime_type = "text/plain"

    # Auto-detect Betaflight version from dump/diff_all text and backfill snapshot
    if snapshot and not snapshot.betaflight_version and exportType in {FileRole.dump, FileRole.diff_all}:
        text_content = data.decode("utf-8", errors="replace")
        m = _BF_VERSION_RE.search(text_content)
        if m:
            snapshot.betaflight_version = m.group(1)
            db.flush()

    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Upload exceeds configured size limit")

    relative_path, stored_filename = build_relative_path(
        drone.slug,
        snapshot.slug if snapshot else None,
        exportType,
        original_filename,
    )
    write_bytes(relative_path, data)

    stored_file = StoredFile(
        drone_id=drone.id,
        snapshot_id=snapshot.id if snapshot else None,
        role=exportType,
        original_filename=original_filename,
        stored_filename=stored_filename,
        relative_path=relative_path,
        mime_type=mime_type,
        sha256=sha256_hex(data),
        size_bytes=len(data),
        parse_status=parse_status_for_role(exportType),
        text_excerpt=excerpt_text(data, exportType),
    )
    db.add(stored_file)
    db.commit()
    db.refresh(stored_file)
    return stored_file


@app.get("/api/files/{file_id}", response_model=StoredFileOut)
def get_file_metadata(file_id: int, db: Session = Depends(get_db)) -> StoredFile:
    stored_file = db.execute(select(StoredFile).where(StoredFile.id == file_id)).scalar_one_or_none()
    if not stored_file:
        raise HTTPException(status_code=404, detail="File not found")
    return stored_file


@app.get("/api/files/{file_id}/download")
def download_file(file_id: int, db: Session = Depends(get_db)) -> FileResponse:
    stored_file = db.execute(select(StoredFile).where(StoredFile.id == file_id)).scalar_one_or_none()
    if not stored_file:
        raise HTTPException(status_code=404, detail="File not found")
    target = settings.upload_path / stored_file.relative_path
    if not target.exists():
        raise HTTPException(status_code=404, detail="Stored file is missing on disk")
    return FileResponse(path=target, filename=stored_file.original_filename or stored_file.stored_filename)


@app.get("/api/snapshots/{snapshot_id}/raw", response_model=RawSnapshotResponse)
def get_snapshot_raw(snapshot_id: int, db: Session = Depends(get_db)) -> RawSnapshotResponse:
    snapshot = get_snapshot_or_404(db, snapshot_id)
    files: list[RawSnapshotFile] = []
    for stored_file in snapshot.files:
        file_path = settings.upload_path / stored_file.relative_path
        if not file_path.exists():
            continue
        content = file_path.read_text(encoding="utf-8", errors="replace")
        parsed = None
        if stored_file.role in {FileRole.dump, FileRole.diff_all}:
            parsed = parse_betaflight_config(content) or None
        files.append(
            RawSnapshotFile(
                file_id=stored_file.id,
                role=stored_file.role,
                original_filename=stored_file.original_filename,
                content=content,
                parsed_config=parsed,
            )
        )
    # Merge summaries from all CLI files (dump/diff_all) into one combined view
    from .parser import extract_summary as _extract_summary
    merged_kv: dict[str, str] = {}
    for f in files:
        if f.parsed_config:
            for section_entries in f.parsed_config.values():
                if isinstance(section_entries, list):
                    for entry in section_entries:
                        if isinstance(entry, dict) and "key" in entry:
                            merged_kv[entry["key"]] = entry["value"]
    combined_summary = _extract_summary(merged_kv) if merged_kv else None
    return RawSnapshotResponse(snapshot_id=snapshot.id, files=files, summary=combined_summary)


@app.post("/api/snapshots/compare", response_model=CompareResponse)
def compare_snapshots(payload: CompareRequest, db: Session = Depends(get_db)) -> CompareResponse:
    left = get_snapshot_or_404(db, payload.left_snapshot_id)
    right = get_snapshot_or_404(db, payload.right_snapshot_id)
    left_lines, _ = read_snapshot_text(left)
    right_lines, _ = read_snapshot_text(right)
    diff_lines = list(
        difflib.unified_diff(left_lines, right_lines, fromfile=left.name, tofile=right.name, lineterm="")
    )
    added = sum(1 for line in diff_lines if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff_lines if line.startswith("-") and not line.startswith("---"))
    return CompareResponse(
        left_snapshot_id=left.id,
        right_snapshot_id=right.id,
        added_lines=added,
        removed_lines=removed,
        diff="\n".join(diff_lines),
    )


@app.post("/api/drones/{drone_id}/flights", response_model=FlightNoteOut, status_code=201)
def create_flight_note(drone_id: int, payload: FlightNoteCreate, db: Session = Depends(get_db)) -> FlightNote:
    drone = get_drone_or_404(db, drone_id)
    note = FlightNote(
        drone_id=drone.id,
        title=payload.title,
        note=payload.note,
        battery_id=payload.battery_id,
        duration_minutes=payload.duration_minutes,
        battery_used_percent=payload.battery_used_percent,
        flight_date=payload.flight_date,
        location=payload.location,
        wind_speed_kmh=payload.wind_speed_kmh,
        temperature_c=payload.temperature_c,
        outcome=payload.outcome,
        motor_temps=payload.motor_temps,
        battery_voltage_after=payload.battery_voltage_after,
    )
    db.add(note)
    # Increment battery cycle count + record last use if battery linked
    if payload.battery_id:
        battery = db.execute(select(Battery).where(Battery.id == payload.battery_id)).scalar_one_or_none()
        if battery:
            battery.cycle_count = battery.cycle_count + 1
            battery.last_charged_at = datetime.utcnow()
    # Auto-ground drone on crash outcome
    if payload.outcome == "crash" and drone.status == "flyable":
        drone.status = "grounded_crash"
    db.commit()
    db.refresh(note)
    return note


@app.patch("/api/drones/{drone_id}/flights/{note_id}", response_model=FlightNoteOut)
def update_flight_note(drone_id: int, note_id: int, payload: FlightNoteUpdate, db: Session = Depends(get_db)) -> FlightNote:
    note = db.execute(select(FlightNote).where(FlightNote.id == note_id, FlightNote.drone_id == drone_id)).scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=404, detail="Flight note not found")
    if payload.title is not None:
        note.title = payload.title
    if payload.note is not None:
        note.note = payload.note
    if payload.battery_id is not None:
        note.battery_id = payload.battery_id
    if payload.duration_minutes is not None:
        note.duration_minutes = payload.duration_minutes
    if payload.battery_used_percent is not None:
        note.battery_used_percent = payload.battery_used_percent
    if payload.flight_date is not None:
        note.flight_date = payload.flight_date
    if payload.location is not None:
        note.location = payload.location
    if payload.wind_speed_kmh is not None:
        note.wind_speed_kmh = payload.wind_speed_kmh
    if payload.temperature_c is not None:
        note.temperature_c = payload.temperature_c
    if payload.outcome is not None:
        note.outcome = payload.outcome
    if payload.motor_temps is not None:
        note.motor_temps = payload.motor_temps
    if payload.battery_voltage_after is not None:
        note.battery_voltage_after = payload.battery_voltage_after
    db.commit()
    db.refresh(note)
    return note


@app.delete("/api/drones/{drone_id}/flights/{note_id}", status_code=204)
def delete_flight_note(drone_id: int, note_id: int, db: Session = Depends(get_db)) -> None:
    note = db.execute(select(FlightNote).where(FlightNote.id == note_id, FlightNote.drone_id == drone_id)).scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=404, detail="Flight note not found")
    db.delete(note)
    db.commit()


@app.get("/api/drones/{drone_id}/flights", response_model=list[FlightNoteOut])
def list_flight_notes(drone_id: int, db: Session = Depends(get_db)) -> list[FlightNote]:
    get_drone_or_404(db, drone_id)
    return list(db.execute(select(FlightNote).where(FlightNote.drone_id == drone_id).order_by(FlightNote.created_at.desc())).scalars())


@app.post("/api/drones/{drone_id}/maintenance", response_model=MaintenanceEventOut, status_code=201)
def create_maintenance_event(drone_id: int, payload: MaintenanceEventCreate, db: Session = Depends(get_db)) -> MaintenanceEvent:
    drone = get_drone_or_404(db, drone_id)
    event = MaintenanceEvent(
        drone_id=drone.id,
        title=payload.title,
        note=payload.note,
        event_type=payload.event_type,
        damage_items=payload.damage_items,
        repair_cost_pln=payload.repair_cost_pln,
        crash_severity=payload.crash_severity,
        spare_parts_used=payload.spare_parts_used,
    )
    db.add(event)
    # Auto-ground drone on crash event
    if payload.event_type == "crash" and drone.status == "flyable":
        drone.status = "grounded_crash"
    # Auto-deduct spare parts from inventory
    if payload.spare_parts_used:
        import json as _json
        try:
            parts = _json.loads(payload.spare_parts_used)
            for entry in parts:
                spare = db.execute(select(SpareStock).where(SpareStock.id == entry.get("spare_stock_id"))).scalar_one_or_none()
                if spare:
                    spare.quantity = max(0, spare.quantity - int(entry.get("qty", 1)))
        except Exception:
            pass
    db.commit()
    db.refresh(event)
    return event


@app.patch("/api/drones/{drone_id}/maintenance/{event_id}", response_model=MaintenanceEventOut)
def update_maintenance_event(drone_id: int, event_id: int, payload: MaintenanceEventUpdate, db: Session = Depends(get_db)) -> MaintenanceEvent:
    event = db.execute(select(MaintenanceEvent).where(MaintenanceEvent.id == event_id, MaintenanceEvent.drone_id == drone_id)).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Maintenance event not found")
    if payload.title is not None:
        event.title = payload.title
    if payload.note is not None:
        event.note = payload.note
    if payload.event_type is not None:
        event.event_type = payload.event_type
    if payload.damage_items is not None:
        event.damage_items = payload.damage_items
    if payload.repair_cost_pln is not None:
        event.repair_cost_pln = payload.repair_cost_pln
    if payload.crash_severity is not None:
        event.crash_severity = payload.crash_severity
    if payload.spare_parts_used is not None:
        event.spare_parts_used = payload.spare_parts_used
    db.commit()
    db.refresh(event)
    return event


@app.delete("/api/drones/{drone_id}/maintenance/{event_id}", status_code=204)
def delete_maintenance_event(drone_id: int, event_id: int, db: Session = Depends(get_db)) -> None:
    event = db.execute(select(MaintenanceEvent).where(MaintenanceEvent.id == event_id, MaintenanceEvent.drone_id == drone_id)).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Maintenance event not found")
    db.delete(event)
    db.commit()


@app.get("/api/drones/{drone_id}/maintenance", response_model=list[MaintenanceEventOut])
def list_maintenance_events(drone_id: int, db: Session = Depends(get_db)) -> list[MaintenanceEvent]:
    get_drone_or_404(db, drone_id)
    return list(
        db.execute(
            select(MaintenanceEvent).where(MaintenanceEvent.drone_id == drone_id).order_by(MaintenanceEvent.created_at.desc())
        ).scalars()
    )


# ── Preflight checklist endpoints ─────────────────────────────────────────────

@app.get("/api/drones/{drone_id}/checklist", response_model=list[PreflightItemOut])
def list_checklist(drone_id: int, db: Session = Depends(get_db)) -> list[PreflightChecklistItem]:
    get_drone_or_404(db, drone_id)
    return list(
        db.execute(
            select(PreflightChecklistItem)
            .where(PreflightChecklistItem.drone_id == drone_id)
            .order_by(PreflightChecklistItem.order_idx, PreflightChecklistItem.id)
        ).scalars()
    )


@app.post("/api/drones/{drone_id}/checklist", response_model=PreflightItemOut, status_code=201)
def create_checklist_item(drone_id: int, payload: PreflightItemCreate, db: Session = Depends(get_db)) -> PreflightChecklistItem:
    get_drone_or_404(db, drone_id)
    item = PreflightChecklistItem(
        drone_id=drone_id,
        label=payload.label,
        order_idx=payload.order_idx,
        is_required=payload.is_required,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.delete("/api/drones/{drone_id}/checklist/{item_id}", status_code=204)
def delete_checklist_item(drone_id: int, item_id: int, db: Session = Depends(get_db)) -> None:
    item = db.execute(
        select(PreflightChecklistItem).where(PreflightChecklistItem.id == item_id, PreflightChecklistItem.drone_id == drone_id)
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Checklist item not found")
    db.delete(item)
    db.commit()


# ── Battery fleet endpoints ────────────────────────────────────────────────────

@app.get("/api/drones/{drone_id}/export")
def export_drone(drone_id: int, db: Session = Depends(get_db)) -> dict:
    drone = get_drone_or_404(db, drone_id)
    return {
        "id": drone.id,
        "name": drone.name,
        "slug": drone.slug,
        "frame": drone.frame,
        "stack": drone.stack,
        "motors": drone.motors,
        "props": drone.props,
        "notes": drone.notes,
        "status": drone.status,
        "auw_grams": drone.auw_grams,
        "fc_target": drone.fc_target,
        "radio_link": drone.radio_link,
        "video_system": drone.video_system,
        "operator_id": drone.operator_id,
        "registration_country": drone.registration_country,
        "registration_expiry": drone.registration_expiry,
        "remote_id_module": drone.remote_id_module,
        "snapshots": [
            {
                "id": s.id, "name": s.name, "betaflight_version": s.betaflight_version,
                "is_current": s.is_current, "is_known_good": s.is_known_good,
                "notes": s.notes, "created_at": s.created_at.isoformat(),
                "files": [{"id": f.id, "role": f.role.value, "original_filename": f.original_filename, "size_bytes": f.size_bytes} for f in s.files],
            } for s in drone.snapshots
        ],
        "flight_notes": [{"id": n.id, "title": n.title, "note": n.note, "created_at": n.created_at.isoformat()} for n in drone.flight_notes],
        "maintenance_events": [{"id": n.id, "title": n.title, "note": n.note, "created_at": n.created_at.isoformat()} for n in drone.maintenance_events],
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }

@app.get("/api/batteries", response_model=list[BatteryOut])
def list_batteries(db: Session = Depends(get_db)) -> list[Battery]:
    return list(db.execute(select(Battery).order_by(Battery.created_at.desc())).scalars())


@app.get("/api/batteries/{battery_id}", response_model=BatteryOut)
def get_battery(battery_id: int, db: Session = Depends(get_db)) -> Battery:
    battery = db.execute(select(Battery).where(Battery.id == battery_id)).scalar_one_or_none()
    if not battery:
        raise HTTPException(status_code=404, detail="Battery not found")
    return battery


@app.post("/api/batteries", response_model=BatteryOut, status_code=201)
def create_battery(payload: BatteryCreate, db: Session = Depends(get_db)) -> Battery:
    existing = db.execute(select(Battery).where(Battery.label == payload.label)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Battery label already exists")
    battery = Battery(**payload.model_dump())
    db.add(battery)
    db.commit()
    db.refresh(battery)
    return battery


@app.patch("/api/batteries/{battery_id}", response_model=BatteryOut)
def update_battery(battery_id: int, payload: BatteryUpdate, db: Session = Depends(get_db)) -> Battery:
    battery = db.execute(select(Battery).where(Battery.id == battery_id)).scalar_one_or_none()
    if not battery:
        raise HTTPException(status_code=404, detail="Battery not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == "label" and value:
            clash = db.execute(select(Battery).where(Battery.label == value, Battery.id != battery_id)).scalar_one_or_none()
            if clash:
                raise HTTPException(status_code=409, detail="Battery label already exists")
        setattr(battery, field, value)
    db.commit()
    db.refresh(battery)
    return battery


@app.delete("/api/batteries/{battery_id}", status_code=204)
def delete_battery(battery_id: int, db: Session = Depends(get_db)) -> None:
    battery = db.execute(select(Battery).where(Battery.id == battery_id)).scalar_one_or_none()
    if not battery:
        raise HTTPException(status_code=404, detail="Battery not found")
    db.delete(battery)
    db.commit()


# ── QR Code labels ────────────────────────────────────────────────────────────

@app.get("/api/qr/{entity_type}/{entity_id}")
def generate_qr(entity_type: str, entity_id: int, size: int = 200) -> Response:
    """Return a PNG QR code for a drone or battery deep-link URL."""
    if entity_type not in ("drone", "battery"):
        raise HTTPException(status_code=400, detail="entity_type must be 'drone' or 'battery'")
    settings = get_settings()
    base_url = settings.app_url
    path = f"/drones?id={entity_id}" if entity_type == "drone" else f"/?section=batteries&bat={entity_id}"
    url = f"{base_url}{path}"
    try:
        import qrcode  # type: ignore
        import qrcode.image.pil  # type: ignore
        qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=max(1, size // 25), border=2)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return Response(content=buf.getvalue(), media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})
    except ImportError:
        raise HTTPException(status_code=503, detail="qrcode library not installed")


# ── Spare Parts Inventory ─────────────────────────────────────────────────────

@app.get("/api/spare-stock", response_model=list[SpareStockOut])
@app.get("/api/spare-parts", response_model=list[SpareStockOut], include_in_schema=False)
def list_spare_stock(db: Session = Depends(get_db)) -> list[SpareStock]:
    return list(db.execute(select(SpareStock).order_by(SpareStock.part_name)).scalars())


@app.post("/api/spare-stock", response_model=SpareStockOut, status_code=201)
def create_spare_stock(payload: SpareStockCreate, db: Session = Depends(get_db)) -> SpareStock:
    item = SpareStock(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.patch("/api/spare-stock/{item_id}", response_model=SpareStockOut)
def update_spare_stock(item_id: int, payload: SpareStockUpdate, db: Session = Depends(get_db)) -> SpareStock:
    item = db.execute(select(SpareStock).where(SpareStock.id == item_id)).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Spare stock item not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@app.delete("/api/spare-stock/{item_id}", status_code=204)
def delete_spare_stock(item_id: int, db: Session = Depends(get_db)) -> None:
    item = db.execute(select(SpareStock).where(SpareStock.id == item_id)).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Spare stock item not found")
    db.delete(item)
    db.commit()


# ── Catalogue: Manufacturers ──────────────────────────────────────────────────

@app.get("/api/manufacturers", response_model=list[ManufacturerOut])
def list_manufacturers(db: Session = Depends(get_db)) -> list[Manufacturer]:
    return list(db.execute(select(Manufacturer).order_by(Manufacturer.name)).scalars())


@app.post("/api/manufacturers", response_model=ManufacturerOut, status_code=201)
def create_manufacturer(payload: ManufacturerCreate, db: Session = Depends(get_db)) -> Manufacturer:
    from .storage import safe_slug as _slug
    slug = _slug(payload.name, "mfr")
    existing = db.execute(select(Manufacturer).where(Manufacturer.name == payload.name)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Manufacturer already exists")
    mfr = Manufacturer(name=payload.name, slug=slug, website=payload.website)
    db.add(mfr)
    db.commit()
    db.refresh(mfr)
    return mfr


# ── Catalogue: Categories ─────────────────────────────────────────────────────

@app.get("/api/categories", response_model=list[ProductCategoryOut])
def list_categories(db: Session = Depends(get_db)) -> list[ProductCategory]:
    return list(db.execute(select(ProductCategory).order_by(ProductCategory.name)).scalars())


@app.post("/api/categories", response_model=ProductCategoryOut, status_code=201)
def create_category(payload: ProductCategoryCreate, db: Session = Depends(get_db)) -> ProductCategory:
    from .storage import safe_slug as _slug
    slug = _slug(payload.name, "cat")
    existing = db.execute(select(ProductCategory).where(ProductCategory.name == payload.name)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Category already exists")
    cat = ProductCategory(name=payload.name, slug=slug, component_role=payload.component_role.value)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


# ── Catalogue: Products ───────────────────────────────────────────────────────

import json as _json


def _product_query():
    return (
        select(Product)
        .options(
            selectinload(Product.manufacturer),
            selectinload(Product.category),
            selectinload(Product.variants),
        )
    )


@app.get("/api/products", response_model=list[ProductListOut])
def list_products(
    db: Session = Depends(get_db),
    search: str | None = None,
    manufacturer_id: int | None = None,
    category_id: int | None = None,
    component_role: str | None = None,
    tag: str | None = None,
    is_active: bool = True,
) -> list[Product]:
    q = _product_query().where(Product.is_active == is_active)
    if manufacturer_id is not None:
        q = q.where(Product.manufacturer_id == manufacturer_id)
    if category_id is not None:
        q = q.where(Product.category_id == category_id)
    if component_role is not None:
        q = q.where(Product.component_role == component_role.upper())
    if search:
        q = q.where(Product.name.ilike(f"%{search}%"))
    if tag:
        q = q.where(Product.tags.ilike(f"%{tag}%"))
    return list(db.execute(q.order_by(Product.name)).scalars())


@app.get("/api/products/{product_id}", response_model=ProductOut)
def get_product(product_id: int, db: Session = Depends(get_db)) -> Product:
    p = db.execute(_product_query().where(Product.id == product_id)).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    return p


@app.post("/api/products", response_model=ProductOut, status_code=201)
def create_product(payload: ProductCreate, db: Session = Depends(get_db)) -> Product:
    from .storage import safe_slug as _slug
    base_name = f"{payload.name}"
    slug = next_unique_slug(db, Product, _slug(base_name, "prod"))
    specs_json = _json.dumps(payload.specs) if payload.specs else None
    product = Product(
        slug=slug,
        name=payload.name,
        manufacturer_id=payload.manufacturer_id,
        category_id=payload.category_id,
        component_role=payload.component_role.value,
        description=payload.description,
        specs=specs_json,
        tags=payload.tags,
        image_url=payload.image_url,
        product_url=payload.product_url,
    )
    db.add(product)
    db.flush()
    for v in payload.variants:
        v_slug = next_unique_slug(db, ProductVariant, _slug(f"{base_name}-{v.name}", "var"))
        variant = ProductVariant(
            product_id=product.id,
            slug=v_slug,
            name=v.name,
            specs=_json.dumps(v.specs) if v.specs else None,
        )
        db.add(variant)
    db.commit()
    return db.execute(_product_query().where(Product.id == product.id)).scalar_one()


@app.patch("/api/products/{product_id}", response_model=ProductOut)
def update_product(product_id: int, payload: ProductUpdate, db: Session = Depends(get_db)) -> Product:
    product = db.execute(select(Product).where(Product.id == product_id)).scalar_one_or_none()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == 'specs' and isinstance(value, dict):
            setattr(product, field, _json.dumps(value))
        else:
            setattr(product, field, value)
    db.commit()
    return db.execute(_product_query().where(Product.id == product_id)).scalar_one()


@app.post("/api/products/{product_id}/variants", response_model=ProductVariantOut, status_code=201)
def add_product_variant(product_id: int, payload: ProductVariantCreate, db: Session = Depends(get_db)) -> ProductVariant:
    from .storage import safe_slug as _slug
    p = db.execute(select(Product).where(Product.id == product_id)).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    v_slug = next_unique_slug(db, ProductVariant, _slug(f"{p.name}-{payload.name}", "var"))
    variant = ProductVariant(
        product_id=product_id,
        slug=v_slug,
        name=payload.name,
        specs=_json.dumps(payload.specs) if payload.specs else None,
    )
    db.add(variant)
    db.commit()
    db.refresh(variant)
    return variant


# ── Drone Hardware / Build Versions ───────────────────────────────────────────

def _component_query():
    return (
        select(InstalledComponent)
        .options(
            selectinload(InstalledComponent.product).selectinload(Product.manufacturer),
            selectinload(InstalledComponent.product).selectinload(Product.category),
            selectinload(InstalledComponent.product).selectinload(Product.variants),
            selectinload(InstalledComponent.product_variant),
        )
    )


def _get_current_build(db: Session, drone_id: int) -> BuildVersion:
    """Return current build version, creating one if none exists."""
    drone = db.execute(select(Drone).where(Drone.id == drone_id)).scalar_one_or_none()
    if not drone:
        raise HTTPException(status_code=404, detail="Drone not found")
    if drone.current_build_version_id:
        bv = db.execute(select(BuildVersion).where(BuildVersion.id == drone.current_build_version_id)).scalar_one_or_none()
        if bv:
            return bv
    # Create default build version
    bv = BuildVersion(drone_id=drone_id, name="Initial build", is_current=True)
    db.add(bv)
    db.flush()
    drone.current_build_version_id = bv.id
    db.commit()
    db.refresh(bv)
    return bv


@app.get("/api/drones/{drone_id}/components", response_model=list[InstalledComponentOut])
def list_current_components(drone_id: int, db: Session = Depends(get_db)) -> list[InstalledComponent]:
    """Return currently installed components (not removed) for the drone's current build."""
    get_drone_or_404(db, drone_id)
    drone = db.execute(select(Drone).where(Drone.id == drone_id)).scalar_one_or_none()
    if not drone or not drone.current_build_version_id:
        return []
    return list(
        db.execute(
            _component_query()
            .where(InstalledComponent.build_version_id == drone.current_build_version_id)
            .where(InstalledComponent.removed_at.is_(None))
            .order_by(InstalledComponent.component_role)
        ).scalars()
    )


@app.get("/api/drones/{drone_id}/components/history", response_model=list[InstalledComponentOut])
def list_component_history(drone_id: int, db: Session = Depends(get_db)) -> list[InstalledComponent]:
    """Return all components including removed ones across all build versions."""
    get_drone_or_404(db, drone_id)
    bv_ids = [
        row[0] for row in db.execute(
            select(BuildVersion.id).where(BuildVersion.drone_id == drone_id)
        ).all()
    ]
    if not bv_ids:
        return []
    return list(
        db.execute(
            _component_query()
            .where(InstalledComponent.build_version_id.in_(bv_ids))
            .order_by(InstalledComponent.installed_at.desc())
        ).scalars()
    )


@app.post("/api/drones/{drone_id}/components", response_model=InstalledComponentOut, status_code=201)
def add_component(drone_id: int, payload: InstalledComponentCreate, db: Session = Depends(get_db)) -> InstalledComponent:
    """Add a component to the drone's current build."""
    get_drone_or_404(db, drone_id)
    _validate_component_products(db, payload)
    bv = _get_current_build(db, drone_id)
    role = payload.component_role.value if hasattr(payload.component_role, "value") else str(payload.component_role)
    qty = payload.quantity if payload.quantity is not None else 1
    comp = InstalledComponent(
        build_version_id=bv.id,
        component_role=role,
        product_id=payload.product_id,
        product_variant_id=payload.product_variant_id,
        custom_name=payload.custom_name,
        custom_manufacturer=payload.custom_manufacturer,
        custom_notes=payload.custom_notes,
        quantity=qty,
        firmware_version=payload.firmware_version,
    )
    db.add(comp)
    db.commit()
    db.refresh(comp)
    return db.execute(_component_query().where(InstalledComponent.id == comp.id)).scalar_one()


@app.delete("/api/drones/{drone_id}/components/{component_id}", status_code=204)
def remove_component(drone_id: int, component_id: int, db: Session = Depends(get_db)) -> None:
    """Remove a component. Sets removed_at if it was previously installed, else hard-deletes."""
    get_drone_or_404(db, drone_id)
    comp = db.execute(select(InstalledComponent).where(InstalledComponent.id == component_id)).scalar_one_or_none()
    if not comp:
        raise HTTPException(status_code=404, detail="Component not found")
    # Soft-delete: set removed_at
    comp.removed_at = datetime.utcnow()
    db.commit()


@app.put("/api/drones/{drone_id}/components/{component_id}", response_model=InstalledComponentOut)
def replace_component(drone_id: int, component_id: int, payload: ReplaceComponentRequest, db: Session = Depends(get_db)) -> InstalledComponent:
    """
    Replace an installed component.
    Old component gets removed_at set (history preserved).
    New component gets installed_at = now.
    TODO: If Betaflight snapshots exist after current install, warn that tune may not match.
    """
    get_drone_or_404(db, drone_id)
    old = db.execute(select(InstalledComponent).where(InstalledComponent.id == component_id)).scalar_one_or_none()
    if not old:
        raise HTTPException(status_code=404, detail="Component not found")
    old.removed_at = datetime.utcnow()
    db.flush()
    _validate_component_products(db, payload.new_component)
    bv = _get_current_build(db, drone_id)
    nc = payload.new_component
    role = nc.component_role.value if hasattr(nc.component_role, "value") else str(nc.component_role)
    qty = nc.quantity if nc.quantity is not None else 1
    new_comp = InstalledComponent(
        build_version_id=bv.id,
        component_role=role,
        product_id=nc.product_id,
        product_variant_id=nc.product_variant_id,
        custom_name=nc.custom_name,
        custom_manufacturer=nc.custom_manufacturer,
        custom_notes=nc.custom_notes,
        quantity=qty,
        firmware_version=nc.firmware_version,
    )
    db.add(new_comp)
    db.commit()
    db.refresh(new_comp)
    return db.execute(_component_query().where(InstalledComponent.id == new_comp.id)).scalar_one()


@app.get("/api/drones/{drone_id}/build-versions", response_model=list[BuildVersionOut])
def list_build_versions(drone_id: int, db: Session = Depends(get_db)) -> list[BuildVersion]:
    get_drone_or_404(db, drone_id)
    return list(
        db.execute(
            select(BuildVersion)
            .options(
                selectinload(BuildVersion.installed_components).selectinload(InstalledComponent.product).selectinload(Product.manufacturer),
                selectinload(BuildVersion.installed_components).selectinload(InstalledComponent.product).selectinload(Product.category),
                selectinload(BuildVersion.installed_components).selectinload(InstalledComponent.product).selectinload(Product.variants),
                selectinload(BuildVersion.installed_components).selectinload(InstalledComponent.product_variant),
            )
            .where(BuildVersion.drone_id == drone_id)
            .order_by(BuildVersion.created_at.desc())
        ).scalars()
    )


# ═══════════════════════════════════════════════════════════════════════════════
# #7  FLIGHT STATS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/drones/{drone_id}/stats", response_model=DroneFlightStats)
def get_drone_stats(drone_id: int, db: Session = Depends(get_db)) -> DroneFlightStats:
    drone = get_drone_or_404(db, drone_id)
    notes = list(db.execute(
        select(FlightNote).where(FlightNote.drone_id == drone_id)
    ).scalars())
    total_flights = len(notes)
    total_minutes = sum(n.duration_minutes or 0 for n in notes)
    avg_minutes = round(total_minutes / total_flights, 1) if total_flights else 0.0
    last_flight = max((n.flight_date or str(n.created_at)[:10] for n in notes), default=None)
    from datetime import timezone
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - __import__("datetime").timedelta(days=30)
    flights_30d = sum(1 for n in notes if n.created_at >= cutoff)
    return DroneFlightStats(
        drone_id=drone.id,
        total_flights=total_flights,
        total_minutes=total_minutes,
        avg_minutes=avg_minutes,
        last_flight_date=last_flight,
        flights_last_30d=flights_30d,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# #8  MAINTENANCE ALERTS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/drones/{drone_id}/maintenance-alerts", response_model=list[MaintenanceAlertOut])
def list_maintenance_alerts(drone_id: int, db: Session = Depends(get_db)) -> list[MaintenanceAlertOut]:
    get_drone_or_404(db, drone_id)
    alerts = list(db.execute(
        select(MaintenanceAlert).where(MaintenanceAlert.drone_id == drone_id)
    ).scalars())
    result = []
    for a in alerts:
        pct = min(100, int(a.current_count * 100 / a.trigger_value)) if a.trigger_value else 0
        out = MaintenanceAlertOut.model_validate(a)
        out.is_due = a.current_count >= a.trigger_value
        out.pct = pct
        result.append(out)
    return result


@app.post("/api/drones/{drone_id}/maintenance-alerts", response_model=MaintenanceAlertOut, status_code=201)
def create_maintenance_alert(drone_id: int, payload: MaintenanceAlertCreate, db: Session = Depends(get_db)) -> MaintenanceAlertOut:
    get_drone_or_404(db, drone_id)
    alert = MaintenanceAlert(drone_id=drone_id, **payload.model_dump())
    db.add(alert)
    db.commit()
    db.refresh(alert)
    out = MaintenanceAlertOut.model_validate(alert)
    out.pct = 0
    return out


@app.post("/api/maintenance-alerts/{alert_id}/reset", response_model=MaintenanceAlertOut)
def reset_maintenance_alert(alert_id: int, db: Session = Depends(get_db)) -> MaintenanceAlertOut:
    alert = db.execute(select(MaintenanceAlert).where(MaintenanceAlert.id == alert_id)).scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.current_count = 0
    alert.last_reset_at = datetime.utcnow()
    db.commit()
    db.refresh(alert)
    out = MaintenanceAlertOut.model_validate(alert)
    out.pct = 0
    return out


@app.patch("/api/maintenance-alerts/{alert_id}/increment")
def increment_maintenance_alert(alert_id: int, amount: int = 1, db: Session = Depends(get_db)) -> dict:
    alert = db.execute(select(MaintenanceAlert).where(MaintenanceAlert.id == alert_id)).scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.current_count = alert.current_count + amount
    db.commit()
    return {"current_count": alert.current_count, "is_due": alert.current_count >= alert.trigger_value}


@app.delete("/api/maintenance-alerts/{alert_id}", status_code=204)
def delete_maintenance_alert(alert_id: int, db: Session = Depends(get_db)) -> None:
    alert = db.execute(select(MaintenanceAlert).where(MaintenanceAlert.id == alert_id)).scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    db.delete(alert)
    db.commit()


@app.get("/api/maintenance-alerts/due", response_model=list[MaintenanceAlertOut])
def list_due_alerts(db: Session = Depends(get_db)) -> list[MaintenanceAlertOut]:
    """All alerts across all drones that are due."""
    alerts = list(db.execute(
        select(MaintenanceAlert).where(
            MaintenanceAlert.is_active == True,
            MaintenanceAlert.current_count >= MaintenanceAlert.trigger_value
        )
    ).scalars())
    result = []
    for a in alerts:
        out = MaintenanceAlertOut.model_validate(a)
        out.is_due = True
        out.pct = 100
        result.append(out)
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# #9  PDF EXPORT
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/drones/{drone_id}/report")
def drone_report_html(drone_id: int, db: Session = Depends(get_db)):
    """Returns a print-ready HTML report for the drone."""
    from fastapi.responses import HTMLResponse
    drone = get_drone_or_404(db, drone_id)
    snapshots = sorted(drone.snapshots, key=lambda s: s.created_at, reverse=True)
    flights = sorted(drone.flight_notes, key=lambda f: f.created_at, reverse=True)
    maintenance = sorted(drone.maintenance_events, key=lambda m: m.created_at, reverse=True)

    total_mins = sum(f.duration_minutes or 0 for f in flights)
    hours = total_mins // 60
    mins = total_mins % 60

    def row(label, value):
        if not value:
            return ""
        return f"<tr><td style='color:#888;padding:3px 8px;white-space:nowrap'>{label}</td><td style='padding:3px 8px'>{value}</td></tr>"

    snap_rows = "".join(
        f"<tr><td>{s.name}</td><td>{s.betaflight_version or '—'}</td><td>{'✓ current' if s.is_current else ''}</td><td>{'✓ known-good' if s.is_known_good else ''}</td><td>{str(s.created_at)[:10]}</td></tr>"
        for s in snapshots
    )
    flight_rows = "".join(
        f"<tr><td>{f.flight_date or str(f.created_at)[:10]}</td><td>{f.title}</td><td>{f.duration_minutes or '—'} min</td><td>{f.outcome}</td><td>{f.location or '—'}</td></tr>"
        for f in flights[:20]
    )
    maint_rows = "".join(
        f"<tr><td>{str(m.created_at)[:10]}</td><td>{m.title}</td><td>{m.event_type}</td><td>{m.repair_cost_pln or '—'} PLN</td></tr>"
        for m in maintenance
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/>
<title>Drone Report — {drone.name}</title>
<style>
  body{{font-family:system-ui,sans-serif;color:#1a1a1a;margin:32px;font-size:13px}}
  h1{{font-size:22px;margin:0 0 4px}} h2{{font-size:15px;margin:20px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}}
  table{{border-collapse:collapse;width:100%;margin-bottom:12px}}
  th{{background:#f4f4f4;text-align:left;padding:4px 8px;font-size:12px}}
  td{{border-top:1px solid #eee;padding:4px 8px;vertical-align:top}}
  .badge{{display:inline-block;padding:1px 6px;border-radius:4px;background:#e8f4e8;color:#2d7a2d;font-size:11px}}
  @media print{{body{{margin:16px}} .no-print{{display:none}}}}
</style>
</head>
<body>
<button class="no-print" onclick="window.print()" style="margin-bottom:16px;padding:6px 16px;cursor:pointer">🖨 Print / Save as PDF</button>
<h1>🚁 {drone.name}</h1>
<p style="color:#666;margin:0 0 16px">{drone.category or ''} &nbsp;·&nbsp; Generated {str(datetime.utcnow())[:10]}</p>
<h2>Basic Info</h2>
<table>
{row("Frame", drone.frame)}{row("Stack", drone.stack)}{row("Motors", drone.motors)}
{row("Props", drone.props)}{row("AUW", f"{drone.auw_grams}g" if drone.auw_grams else None)}
{row("FC Target", drone.fc_target)}{row("Radio", drone.radio_link)}{row("Video", drone.video_system)}
{row("Status", drone.status)}{row("Operator ID", drone.operator_id)}
{row("Reg. country", drone.registration_country)}{row("Reg. expiry", drone.registration_expiry)}
{row("Remote ID", drone.remote_id_module)}
</table>
<p><strong>Total flight time:</strong> {hours}h {mins}min &nbsp;·&nbsp; <strong>Flights logged:</strong> {len(flights)}</p>
{"<p style='color:#888;font-style:italic'>" + drone.notes + "</p>" if drone.notes else ""}
<h2>Betaflight Snapshots ({len(snapshots)})</h2>
{"<table><tr><th>Name</th><th>BF Version</th><th>Current</th><th>Known-good</th><th>Date</th></tr>" + snap_rows + "</table>" if snapshots else "<p style='color:#888'>No snapshots.</p>"}
<h2>Flight Log (last 20)</h2>
{"<table><tr><th>Date</th><th>Title</th><th>Duration</th><th>Outcome</th><th>Location</th></tr>" + flight_rows + "</table>" if flights else "<p style='color:#888'>No flights logged.</p>"}
<h2>Maintenance History</h2>
{"<table><tr><th>Date</th><th>Title</th><th>Type</th><th>Cost</th></tr>" + maint_rows + "</table>" if maintenance else "<p style='color:#888'>No maintenance events.</p>"}
<p style="margin-top:32px;color:#bbb;font-size:11px">FPV Drone Catalog — {drone.name} — exported {str(datetime.utcnow())[:19]} UTC</p>
</body></html>"""
    return HTMLResponse(html)


# ═══════════════════════════════════════════════════════════════════════════════
# #11  USER AUTH
# ═══════════════════════════════════════════════════════════════════════════════

import hashlib as _hashlib
import secrets as _secrets
import time as _time

_TOKEN_STORE: dict[str, dict] = {}  # in-memory token store (simple, no JWT dep)

def _hash_password(pw: str) -> str:
    return _hashlib.sha256(pw.encode()).hexdigest()

def _make_token(user_id: int) -> str:
    token = _secrets.token_urlsafe(32)
    _TOKEN_STORE[token] = {"user_id": user_id, "exp": _time.time() + 86400 * 30}
    return token

def _get_current_user(authorization: str | None = None, db: Session = Depends(get_db)) -> User | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[7:]
    entry = _TOKEN_STORE.get(token)
    if not entry or entry["exp"] < _time.time():
        return None
    return db.execute(select(User).where(User.id == entry["user_id"])).scalar_one_or_none()

from fastapi import Header as _Header

@app.get("/api/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db)) -> list[User]:
    return list(db.execute(select(User).order_by(User.created_at)).scalars())


@app.post("/api/users", response_model=UserOut, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db)) -> User:
    existing = db.execute(select(User).where(User.username == payload.username)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")
    user = User(
        username=payload.username,
        display_name=payload.display_name,
        hashed_password=_hash_password(payload.password),
        role=payload.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@app.post("/api/auth/login", response_model=TokenResponse)
def login(payload: dict, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.execute(select(User).where(User.username == payload.get("username"))).scalar_one_or_none()
    if not user or user.hashed_password != _hash_password(payload.get("password", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")
    user.last_login_at = datetime.utcnow()
    db.commit()
    token = _make_token(user.id)
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@app.get("/api/auth/me", response_model=UserOut)
def get_me(authorization: str | None = _Header(default=None), db: Session = Depends(get_db)) -> User:
    user = _get_current_user(authorization, db)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


@app.patch("/api/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: dict, db: Session = Depends(get_db)) -> User:
    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if "display_name" in payload:
        user.display_name = payload["display_name"]
    if "role" in payload:
        user.role = payload["role"]
    if "is_active" in payload:
        user.is_active = payload["is_active"]
    if "password" in payload and payload["password"]:
        user.hashed_password = _hash_password(payload["password"])
    db.commit()
    db.refresh(user)
    return user


@app.delete("/api/users/{user_id}", status_code=204)
def delete_user(user_id: int, db: Session = Depends(get_db)) -> None:
    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    db.delete(user)
    db.commit()


# ═══════════════════════════════════════════════════════════════════════════════
# #12  OSD / TELEMETRY IMPORT (DJI .srt)
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/api/drones/{drone_id}/import-osd", response_model=OsdImportResult, status_code=201)
async def import_osd(
    drone_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> OsdImportResult:
    drone = get_drone_or_404(db, drone_id)
    content = (await file.read()).decode("utf-8", errors="replace")
    imported = 0
    skipped = 0
    flight_notes_created = []

    fname = (file.filename or "").lower()

    if fname.endswith(".srt"):
        # DJI .srt subtitle format: timestamp + GPS/altitude/speed data
        import re as _re
        blocks = _re.split(r"\n\n+", content.strip())
        frames: list[dict] = []
        for block in blocks:
            lines = block.strip().splitlines()
            if len(lines) < 3:
                continue
            ts_match = _re.search(r"(\d{2}:\d{2}:\d{2}),(\d{3})", lines[1] if len(lines) > 1 else "")
            data_line = " ".join(lines[2:]) if len(lines) > 2 else ""
            gps_match = _re.search(r"GPS\s*\(([-\d.]+),\s*([-\d.]+)\)", data_line)
            alt_match = _re.search(r"(?:altitude|alt)[:\s]*([\d.]+)", data_line, _re.IGNORECASE)
            spd_match = _re.search(r"(?:speed|spd)[:\s]*([\d.]+)", data_line, _re.IGNORECASE)
            if ts_match:
                frames.append({
                    "ts": ts_match.group(0),
                    "lat": float(gps_match.group(1)) if gps_match else None,
                    "lon": float(gps_match.group(2)) if gps_match else None,
                    "alt": float(alt_match.group(1)) if alt_match else None,
                    "spd": float(spd_match.group(1)) if spd_match else None,
                })
        if frames:
            duration_secs = len(frames) / 30  # assume ~30fps
            duration_min = max(1, int(duration_secs / 60))
            today = str(datetime.utcnow())[:10]
            note = FlightNote(
                drone_id=drone.id,
                title=f"DJI flight — {file.filename}",
                note=f"Imported from OSD .srt file. {len(frames)} frames, ~{duration_min} min.",
                flight_date=today,
                duration_minutes=duration_min,
                outcome="ok",
            )
            db.add(note)
            db.commit()
            db.refresh(note)
            imported += 1
            flight_notes_created.append({"id": note.id, "title": note.title})
        else:
            skipped += 1

    elif fname.endswith(".csv"):
        import csv as _csv, io as _io
        reader = _csv.DictReader(_io.StringIO(content))
        rows = list(reader)
        if rows:
            duration_min = max(1, len(rows) // 600)  # assume ~10Hz
            note = FlightNote(
                drone_id=drone.id,
                title=f"CSV telemetry — {file.filename}",
                note=f"Imported CSV log. {len(rows)} data points.",
                flight_date=str(datetime.utcnow())[:10],
                duration_minutes=duration_min,
                outcome="ok",
            )
            db.add(note)
            db.commit()
            db.refresh(note)
            imported += 1
            flight_notes_created.append({"id": note.id, "title": note.title})
        else:
            skipped += 1
    else:
        raise HTTPException(status_code=400, detail="Unsupported format. Use .srt (DJI OSD) or .csv")

    return OsdImportResult(imported=imported, skipped=skipped, flight_notes=flight_notes_created)


# ═══════════════════════════════════════════════════════════════════════════════
# #15  ELRS PROFILE BACKUP
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/elrs-profiles", response_model=list[ElrsProfileOut])
def list_elrs_profiles(drone_id: int | None = None, db: Session = Depends(get_db)) -> list[ElrsProfile]:
    q = select(ElrsProfile).order_by(ElrsProfile.created_at.desc())
    if drone_id is not None:
        q = q.where(ElrsProfile.drone_id == drone_id)
    return list(db.execute(q).scalars())


@app.post("/api/elrs-profiles", response_model=ElrsProfileOut, status_code=201)
def create_elrs_profile(payload: ElrsProfileCreate, db: Session = Depends(get_db)) -> ElrsProfile:
    profile = ElrsProfile(**payload.model_dump())
    # Mark as current and unmark others for this drone/type
    if payload.drone_id:
        db.execute(
            select(ElrsProfile)
            .where(ElrsProfile.drone_id == payload.drone_id, ElrsProfile.device_type == payload.device_type)
        )
    profile.is_current = True
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


@app.patch("/api/elrs-profiles/{profile_id}", response_model=ElrsProfileOut)
def update_elrs_profile(profile_id: int, payload: dict, db: Session = Depends(get_db)) -> ElrsProfile:
    profile = db.execute(select(ElrsProfile).where(ElrsProfile.id == profile_id)).scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    for k, v in payload.items():
        if hasattr(profile, k):
            setattr(profile, k, v)
    db.commit()
    db.refresh(profile)
    return profile


@app.delete("/api/elrs-profiles/{profile_id}", status_code=204)
def delete_elrs_profile(profile_id: int, db: Session = Depends(get_db)) -> None:
    profile = db.execute(select(ElrsProfile).where(ElrsProfile.id == profile_id)).scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    db.delete(profile)
    db.commit()


# ═══════════════════════════════════════════════════════════════════════════════
# #16  BETAFLIGHT PRESETS COLD BACKUP SCRAPER
# ═══════════════════════════════════════════════════════════════════════════════

_BF_PRESETS_INDEX = "https://raw.githubusercontent.com/betaflight/firmware-presets/master/index.json"
_BF_PRESETS_RAW_BASE = "https://raw.githubusercontent.com/betaflight/firmware-presets/master/"

# Curated manufacturer CLI dump URLs for known popular drones
# Research confirmed: GEPRC hosts official .txt dumps at geprc.com/wp-content/uploads/
_MANUFACTURER_PRESETS: list[dict] = [
    # GEPRC Vapor-D6 O4 Pro (GEP-F722-HD v2)
    {"title":"GEPRC Vapor-D6 O4 — ELRS (BF 4.5.1)", "drone_hint":"vapor", "url":"https://geprc.com/wp-content/uploads/2025/06/Vapor-D6-O4-ELRS-4.5.1.txt", "source":"geprc.com"},
    {"title":"GEPRC Vapor-D6 O4 — ELRS + GPS (BF 4.5.1)", "drone_hint":"vapor", "url":"https://geprc.com/wp-content/uploads/2025/06/Vapor-D6-O4-ELRS-GPS-4.5.1.txt", "source":"geprc.com"},
    {"title":"GEPRC Vapor-D6 O4 — SBUS (BF 4.5.1)", "drone_hint":"vapor", "url":"https://geprc.com/wp-content/uploads/2025/06/Vapor-D6-O4-SBUS-4.5.1.txt", "source":"geprc.com"},
    {"title":"GEPRC Vapor-D6 O4 — SBUS + GPS (BF 4.5.1)", "drone_hint":"vapor", "url":"https://geprc.com/wp-content/uploads/2025/06/Vapor-D6-O4-SBUS-GPS-4.5.1.txt", "source":"geprc.com"},
    # GEPRC CineLog35 V3 O4 Pro (GEP-F722-45A AIO V2)
    {"title":"GEPRC CineLog35 V3 HD — SBUS (BF 4.5.2)", "drone_hint":"cinelog35", "url":"https://geprc.com/wp-content/uploads/2025/11/Cinelog35_V3-HD-SBUS-4.5.2.txt", "source":"geprc.com"},
    {"title":"GEPRC CineLog35 V3 HD — SBUS + GPS (BF 4.5.2)", "drone_hint":"cinelog35", "url":"https://geprc.com/wp-content/uploads/2025/11/Cinelog35_V3-HD-SBUS-GPS-4.5.2.txt", "source":"geprc.com"},
    {"title":"GEPRC CineLog35 V3 HD — ELRS (BF 4.5.2)", "drone_hint":"cinelog35", "url":"https://geprc.com/wp-content/uploads/2025/11/Cinelog35_V3-HD-TBS-ELRS-4.5.2.txt", "source":"geprc.com"},
    {"title":"GEPRC CineLog35 V3 HD — ELRS + GPS (BF 4.5.2)", "drone_hint":"cinelog35", "url":"https://geprc.com/wp-content/uploads/2025/11/Cinelog35_V3-HD-TBS-ELRS-GPS-4.5.2.txt", "source":"geprc.com"},
    # GEPRC Mark5 downloads page (O3 / DC HD)
    {"title":"GEPRC Mark5 DC HD — ELRS (BF 4.4.3)", "drone_hint":"mark5", "url":"https://geprc.com/wp-content/uploads/2024/07/MARK5-DC-O3-ELRS-4.4.3.txt", "source":"geprc.com"},
    # Flywoo Explorer LR4 — community diff (IntoFPV)
    {"title":"Flywoo Explorer LR4 O4 Pro — community diff (IntoFPV)", "drone_hint":"explorer lr4", "url":"https://intofpv.com/attachment.php?aid=16742", "source":"intofpv.com"},
]

@app.get("/api/presets/search")
async def search_bf_presets(q: str = "", drone_id: int | None = None, db: Session = Depends(get_db)) -> dict:
    """Search BF presets from firmware-presets repo + curated manufacturer dumps."""

    # Build search terms
    search_terms: list[str] = []
    drone_name = ""
    if q:
        search_terms = [t.strip().lower() for t in q.split() if t.strip()]
    elif drone_id:
        drone = get_drone_or_404(db, drone_id)
        drone_name = drone.name.lower()
        for field in (drone.name, drone.frame, drone.fc_target, drone.stack):
            if field:
                search_terms.extend(field.lower().split())
        search_terms = list(set(s for s in search_terms if len(s) > 2))

    # 1. Manufacturer curated presets (always checked first)
    manufacturer_matches = []
    for p in _MANUFACTURER_PRESETS:
        hint = p["drone_hint"].lower()
        if not search_terms or drone_name and hint in drone_name:
            manufacturer_matches.append({**p, "source_type": "manufacturer", "is_factory_dump": True})
        elif any(t in hint or hint in t for t in search_terms):
            manufacturer_matches.append({**p, "source_type": "manufacturer", "is_factory_dump": True})

    # 2. Community firmware-presets repo
    community_matches = []
    try:
        req = urllib.request.Request(_BF_PRESETS_INDEX, headers={"User-Agent": "FPV-Catalog/1.0"})
        raw = urllib.request.urlopen(req, timeout=8).read()
        data = json.loads(raw)
        presets = data if isinstance(data, list) else []

        def score(p: dict) -> int:
            text = " ".join([
                str(p.get("title", "")), str(p.get("description", "")), str(p.get("author", "")),
                " ".join(p.get("keywords", []) if isinstance(p.get("keywords"), list) else [])
            ]).lower()
            return sum(1 for t in search_terms if t in text)

        if search_terms:
            scored = [(score(p), p) for p in presets]
            community_matches = [
                {**p, "url": _BF_PRESETS_RAW_BASE + p.get("fullPath", ""),
                 "source_type": "community", "is_factory_dump": False}
                for s, p in sorted(scored, key=lambda x: x[0], reverse=True)
                if s > 0
            ][:15]
        else:
            community_matches = [
                {**p, "url": _BF_PRESETS_RAW_BASE + p.get("fullPath", ""),
                 "source_type": "community", "is_factory_dump": False}
                for p in presets[:10]
            ]
    except Exception:
        pass  # Community index unavailable — use manufacturer presets only

    all_results = manufacturer_matches + community_matches
    return {
        "total": len(all_results),
        "manufacturer": len(manufacturer_matches),
        "community": len(community_matches),
        "results": all_results,
        "search_terms": search_terms,
    }


@app.post("/api/drones/{drone_id}/presets/import", response_model=SnapshotOut, status_code=201)
async def import_bf_preset(drone_id: int, payload: dict, db: Session = Depends(get_db)) -> Snapshot:
    """Download a BF preset file and store it as a cold-backup snapshot."""
    drone = get_drone_or_404(db, drone_id)
    preset_url: str = payload.get("url", "")
    preset_title: str = payload.get("title", "BF Preset")

    if not preset_url.startswith("https://"):
        raise HTTPException(status_code=400, detail="Invalid preset URL")

    try:
        req = urllib.request.Request(preset_url, headers={"User-Agent": "FPV-Catalog/1.0"})
        content = urllib.request.urlopen(req, timeout=10).read().decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot fetch preset: {e}")

    # Auto-detect BF version from content
    bf_ver = None
    m = _BF_VERSION_RE.search(content)
    if m:
        bf_ver = m.group(1)

    # Create snapshot marked as cold backup
    today = str(datetime.utcnow())[:10]
    snap_name = f"[Preset] {preset_title} — {today}"
    base_slug = safe_slug(snap_name, f"preset-{drone.id}")
    snap = Snapshot(
        drone_id=drone.id,
        name=snap_name,
        slug=next_unique_slug(db, Snapshot, base_slug, scope_column=Snapshot.drone_id, scope_value=drone.id),
        betaflight_version=bf_ver,
        notes=f"Cold backup — imported from betaflight-presets.\nSource: {preset_url}",
        is_current=False,
        is_known_good=False,
    )
    db.add(snap)
    db.flush()

    # Store the preset content as a stored file
    relative_path, stored_filename = build_relative_path(
        drone.slug, snap.slug, FileRole.diff_all, "preset.txt"
    )
    write_bytes(settings.upload_path / relative_path, content.encode("utf-8"))
    parsed = parse_betaflight_config(content) or None
    sf = StoredFile(
        drone_id=drone.id,
        snapshot_id=snap.id,
        role=FileRole.diff_all,
        original_filename="preset.txt",
        stored_filename=stored_filename,
        relative_path=str(relative_path),
        mime_type="text/plain",
        sha256=sha256_hex(content.encode()),
        size_bytes=len(content.encode()),
        parse_status="parsed" if parsed else "unsupported",
        text_excerpt=excerpt_text(content),
    )
    db.add(sf)
    db.commit()
    return get_snapshot_or_404(db, snap.id)
