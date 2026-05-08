import difflib
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
from .models import Battery, BuildVersion, Drone, FileRole, FlightNote, InstalledComponent, MaintenanceEvent, Manufacturer, Product, ProductCategory, ProductVariant, Snapshot, StoredFile
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
    StoredFileOut,
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
app = FastAPI(title="FPV Drone Catalog API")

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
    with engine.connect() as conn:
        for col, typedef in new_drone_columns:
            conn.execute(text(f"ALTER TABLE drones ADD COLUMN IF NOT EXISTS {col} {typedef}"))
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
    snapshot = Snapshot(
        drone_id=drone.id,
        name=payload.name,
        slug=next_unique_slug(db, Snapshot, base_slug, scope_column=Snapshot.drone_id, scope_value=drone.id),
        betaflight_version=payload.betaflight_version,
        notes=payload.notes,
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
    return RawSnapshotResponse(snapshot_id=snapshot.id, files=files)


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
    note = FlightNote(drone_id=drone.id, title=payload.title, note=payload.note)
    db.add(note)
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
    event = MaintenanceEvent(drone_id=drone.id, title=payload.title, note=payload.note)
    db.add(event)
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
