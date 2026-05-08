import json
import os
import uuid
from urllib import parse, request

import pytest


BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")


def _api(path: str, method: str = "GET", payload: dict | None = None):
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = request.Request(f"{BASE_URL}{path}", data=body, method=method, headers=headers)
    try:
        with request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            if not raw:
                return resp.status, None
            return resp.status, json.loads(raw)
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(f"API call failed for {method} {path}: {exc}") from exc


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="module", autouse=True)
def _check_backend():
    try:
        status, _ = _api("/health")
        if status != 200:
            pytest.skip(f"Backend health check failed with status {status}")
    except RuntimeError as exc:
        pytest.skip(f"Backend not reachable at {BASE_URL}: {exc}")


def _create_manufacturer(name: str) -> dict:
    status, data = _api("/api/manufacturers", "POST", {"name": name})
    assert status == 201
    return data


def _create_category(name: str, role: str) -> dict:
    status, data = _api("/api/categories", "POST", {"name": name, "component_role": role})
    assert status == 201
    return data


def _create_product(name: str, role: str, manufacturer_id: int | None = None, category_id: int | None = None) -> dict:
    payload = {
        "name": name,
        "component_role": role,
        "manufacturer_id": manufacturer_id,
        "category_id": category_id,
    }
    status, data = _api("/api/products", "POST", payload)
    assert status == 201
    return data


def _create_drone(payload: dict) -> dict:
    status, data = _api("/api/drones", "POST", payload)
    assert status == 201
    return data


def test_create_drone_without_parts():
    drone = _create_drone({"name": _unique("no-parts")})
    assert drone["id"] > 0
    assert drone["current_build_version_id"] is None
    assert drone["current_hardware"] == []


def test_create_drone_with_catalogue_parts():
    m = _create_manufacturer(_unique("mfr"))
    c = _create_category(_unique("frame-cat"), "FRAME")
    p = _create_product(_unique("frame"), "FRAME", m["id"], c["id"])

    drone = _create_drone(
        {
            "name": _unique("catalogue"),
            "installed_components": [
                {
                    "component_role": "FRAME",
                    "product_id": p["id"],
                    "quantity": 1,
                }
            ],
        }
    )

    assert drone["current_build_version_id"] is not None
    assert len(drone["current_hardware"]) == 1
    assert drone["current_hardware"][0]["product_id"] == p["id"]


def test_create_drone_with_custom_parts():
    drone = _create_drone(
        {
            "name": _unique("custom"),
            "installed_components": [
                {
                    "component_role": "ACCESSORY",
                    "custom_name": "3D printed mount",
                    "custom_manufacturer": "DIY",
                    "quantity": 1,
                }
            ],
        }
    )

    assert len(drone["current_hardware"]) == 1
    assert drone["current_hardware"][0]["custom_name"] == "3D printed mount"


def test_motor_quantity_defaults_to_4():
    drone = _create_drone(
        {
            "name": _unique("motor-default"),
            "installed_components": [
                {
                    "component_role": "MOTOR",
                    "custom_name": "XING2 2207",
                }
            ],
        }
    )
    assert len(drone["current_hardware"]) == 1
    assert drone["current_hardware"][0]["quantity"] == 4


def test_propeller_quantity_defaults_to_4():
    drone = _create_drone(
        {
            "name": _unique("prop-default"),
            "installed_components": [
                {
                    "component_role": "PROPELLER",
                    "custom_name": "HQ 5x4x3",
                }
            ],
        }
    )
    assert len(drone["current_hardware"]) == 1
    assert drone["current_hardware"][0]["quantity"] == 4


def test_replace_component_preserves_old_record():
    drone = _create_drone(
        {
            "name": _unique("replace"),
            "installed_components": [
                {
                    "component_role": "CAMERA",
                    "custom_name": "Camera A",
                    "quantity": 1,
                }
            ],
        }
    )

    status, current = _api(f"/api/drones/{drone['id']}/components")
    assert status == 200
    assert len(current) == 1
    old_id = current[0]["id"]

    status, replaced = _api(
        f"/api/drones/{drone['id']}/components/{old_id}",
        "PUT",
        {
            "new_component": {
                "component_role": "CAMERA",
                "custom_name": "Camera B",
                "quantity": 1,
            }
        },
    )
    assert status == 200
    assert replaced["custom_name"] == "Camera B"

    status, history = _api(f"/api/drones/{drone['id']}/components/history")
    assert status == 200
    assert len(history) >= 2
    assert any(c["id"] == old_id and c["removed_at"] is not None for c in history)
    assert any(c["id"] == replaced["id"] and c["removed_at"] is None for c in history)


def test_product_filter_by_manufacturer_category_search():
    m1 = _create_manufacturer(_unique("filter-mfr-a"))
    m2 = _create_manufacturer(_unique("filter-mfr-b"))
    c1 = _create_category(_unique("filter-cat-a"), "FRAME")
    c2 = _create_category(_unique("filter-cat-b"), "FRAME")

    p1_name = _unique("alpha-frame")
    p2_name = _unique("beta-frame")
    p1 = _create_product(p1_name, "FRAME", m1["id"], c1["id"])
    _create_product(p2_name, "FRAME", m2["id"], c2["id"])

    query = parse.urlencode(
        {
            "manufacturer_id": m1["id"],
            "category_id": c1["id"],
            "search": "alpha",
        }
    )
    status, products = _api(f"/api/products?{query}")
    assert status == 200
    ids = {p["id"] for p in products}
    assert p1["id"] in ids
    assert all("alpha" in p["name"].lower() for p in products)


def test_drone_detail_returns_current_hardware_only():
    drone = _create_drone(
        {
            "name": _unique("detail-current"),
            "installed_components": [
                {
                    "component_role": "GPS",
                    "custom_name": "M10 GPS",
                    "quantity": 1,
                }
            ],
        }
    )

    status, current = _api(f"/api/drones/{drone['id']}/components")
    assert status == 200
    assert len(current) == 1
    comp_id = current[0]["id"]

    status, _ = _api(f"/api/drones/{drone['id']}/components/{comp_id}", "DELETE")
    assert status == 204

    status, detail = _api(f"/api/drones/{drone['id']}")
    assert status == 200
    assert detail["current_hardware"] == []


def test_hardware_history_includes_removed_components():
    drone = _create_drone(
        {
            "name": _unique("history-removed"),
            "installed_components": [
                {
                    "component_role": "RECEIVER",
                    "custom_name": "Receiver X",
                    "quantity": 1,
                }
            ],
        }
    )

    status, current = _api(f"/api/drones/{drone['id']}/components")
    assert status == 200
    comp_id = current[0]["id"]

    status, _ = _api(f"/api/drones/{drone['id']}/components/{comp_id}", "DELETE")
    assert status == 204

    status, history = _api(f"/api/drones/{drone['id']}/components/history")
    assert status == 200
    assert any(c["id"] == comp_id and c["removed_at"] is not None for c in history)


def test_stats_endpoint_exposes_operational_summary():
    status, stats = _api("/api/stats")
    assert status == 200
    assert stats["drones"]["total"] >= 1
    assert stats["drones"]["flyable"] >= 0
    assert stats["drones"]["grounded"] >= 0
    assert isinstance(stats["snapshots"], int)
    assert isinstance(stats["batteries"], int)
    assert isinstance(stats["products"], int)
    assert isinstance(stats["flights"], int)
    assert isinstance(stats["maintenance"], int)
    assert isinstance(stats["by_video"], dict)
    assert isinstance(stats["by_category"], dict)
