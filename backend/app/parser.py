"""Betaflight CLI output parser.

Parses `diff all` / `dump` text into categorized key-value sections and a
structured summary (PID table, rates, filters, motor) for rich display.
"""

import re
from typing import Any

# ── Section classifiers ────────────────────────────────────────────────────────

_PID_PREFIXES = (
    "p_roll", "p_pitch", "p_yaw",
    "i_roll", "i_pitch", "i_yaw",
    "d_roll", "d_pitch", "d_yaw",
    "f_roll", "f_pitch", "f_yaw",
    "pid_roll", "pid_pitch", "pid_yaw",
    "iterm_relax", "iterm_windup", "iterm_limit",
    "pidsum_limit", "pidsum_limit_yaw",
    "angle_limit", "horizon_tilt", "anti_gravity",
    "crash_recovery", "vbat_pid_gain",
    "ff_interpolate", "ff_smooth", "ff_boost", "ff_spike",
    "feedforward_transition", "feedforward_averaging",
    "feedforward_smooth_factor", "feedforward_jitter",
    "simplified_pids", "simplified_master_multiplier",
    "simplified_roll_pitch_ratio", "simplified_i_gain",
    "simplified_d_gain", "simplified_pi_gain", "simplified_dmax_gain",
    "simplified_feedforward_gain",
    "dmin_roll", "dmin_pitch", "dmin_boost",
    "d_max_roll", "d_max_pitch", "d_max_advance",
)

_RATE_PREFIXES = (
    "roll_rc_rate", "pitch_rc_rate", "yaw_rc_rate",
    "roll_srate", "pitch_srate", "yaw_srate",
    "roll_expo", "pitch_expo", "yaw_expo",
    "rates_type", "tpa_rate", "tpa_breakpoint", "tpa_mode",
    "throttle_limit_type", "throttle_limit_percent",
    "roll_rate_limit", "pitch_rate_limit", "yaw_rate_limit",
)

_FILTER_PREFIXES = (
    "gyro_lpf1", "gyro_lpf2", "gyro_notch",
    "dterm_lowpass", "dterm_notch",
    "rpm_filter", "gyro_rpm_notch",
    "dyn_notch", "dynamic_filter",
    "simplified_gyro_filter", "simplified_dterm_filter",
    "simplified_gyro_filter_multiplier", "simplified_dterm_filter_multiplier",
    "gyro_hardware_lpf",
)

_MOTOR_PREFIXES = (
    "motor_pwm_protocol", "motor_poles", "motor_pwm_rate",
    "dshot_idle_value", "idle_min_rpm", "digital_idle_percent",
    "use_unsynced_pwm", "min_throttle", "max_throttle",
    "motor_output_limit", "throttle_boost",
    "motor_kv", "motor_output_reordering",
    "yaw_motors_reversed", "motor_direction_reversed",
)

_RECEIVER_PREFIXES = (
    "serialrx_provider", "serialrx_halfduplex",
    "rc_smoothing", "rc_interp", "rc_deadband", "yaw_deadband",
    "receiver_type", "rx_min_usec", "rx_max_usec",
    "rssi_channel", "rssi_src", "rssi_scale", "rssi_invert",
    "crsf_use_rx_snr",
)

_VTX_PREFIXES = (
    "vtx_band", "vtx_channel", "vtx_power", "vtx_low_power_disarm",
    "vcd_video_system", "vtx_freq",
)

_OSD_PREFIXES = (
    "osd_", "displayport_",
)

_FAILSAFE_PREFIXES = (
    "failsafe_", "gps_rescue_",
)


def _categorize(key: str) -> str:
    for prefix in _PID_PREFIXES:
        if key == prefix or key.startswith(prefix):
            return "pids"
    for prefix in _RATE_PREFIXES:
        if key == prefix or key.startswith(prefix):
            return "rates"
    for prefix in _FILTER_PREFIXES:
        if key.startswith(prefix):
            return "filters"
    for prefix in _MOTOR_PREFIXES:
        if key.startswith(prefix):
            return "motor"
    for prefix in _RECEIVER_PREFIXES:
        if key.startswith(prefix):
            return "receiver"
    for prefix in _VTX_PREFIXES:
        if key.startswith(prefix):
            return "vtx"
    for prefix in _OSD_PREFIXES:
        if key.startswith(prefix):
            return "osd"
    for prefix in _FAILSAFE_PREFIXES:
        if key.startswith(prefix):
            return "failsafe"
    return "other"


def _num(v: str) -> float | None:
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def extract_summary(kv: dict[str, str]) -> dict[str, Any]:
    """Build a structured summary from a flat key→value dict.

    Returns a dict with:
      pids    – P/I/D/F per Roll/Pitch/Yaw axis
      rates   – RC Rate / Super Rate / Expo per axis + rates_type
      filters – simplified vs manual filter settings
      motor   – protocol, poles, idle
      vtx     – band, channel, power
    """
    def g(k: str) -> str | None:
        return kv.get(k)

    def gn(k: str) -> float | None:
        return _num(kv.get(k, ""))

    # ── PIDs ──────────────────────────────────────────────────────────────────
    pids: dict[str, dict] = {}
    for axis in ("roll", "pitch", "yaw"):
        p = gn(f"p_{axis}")
        i = gn(f"i_{axis}")
        d = gn(f"d_{axis}")
        f = gn(f"f_{axis}")
        if any(v is not None for v in (p, i, d, f)):
            pids[axis] = {
                "p": int(p) if p is not None else None,
                "i": int(i) if i is not None else None,
                "d": int(d) if d is not None else None,
                "f": int(f) if f is not None else None,
            }

    # Simplified PID mode
    simplified_pids = g("simplified_pids_mode") or g("simplified_pids")
    simplified_master = gn("simplified_master_multiplier")
    simplified_pi = gn("simplified_pi_gain")
    simplified_d = gn("simplified_d_gain")
    simplified_ff = gn("simplified_feedforward_gain")
    simplified_i = gn("simplified_i_gain")

    # ── Rates ─────────────────────────────────────────────────────────────────
    rates_type = g("rates_type") or "BETAFLIGHT"
    rates: dict[str, dict] = {}
    for axis in ("roll", "pitch", "yaw"):
        rc = gn(f"{axis}_rc_rate")
        sr = gn(f"{axis}_srate")
        ex = gn(f"{axis}_expo")
        if any(v is not None for v in (rc, sr, ex)):
            rates[axis] = {
                "rc_rate": rc,
                "super_rate": sr,
                "expo": ex,
            }
    tpa_rate = gn("tpa_rate")
    tpa_breakpoint = gn("tpa_breakpoint")

    # ── Filters ───────────────────────────────────────────────────────────────
    simplified_gyro = g("simplified_gyro_filter")
    simplified_dterm = g("simplified_dterm_filter")
    gyro_lpf1_type = g("gyro_lpf1_type")
    gyro_lpf1_hz = gn("gyro_lpf1_static_hz")
    gyro_lpf2_hz = gn("gyro_lpf2_static_hz")
    dterm_lpf_hz = gn("dterm_lowpass_hz") or gn("dterm_lowpass1_static_hz")
    dyn_notch_count = gn("dyn_notch_count")
    dyn_notch_min = gn("dyn_notch_min_hz")
    dyn_notch_max = gn("dyn_notch_max_hz")
    rpm_filter_harmonics = gn("rpm_filter_harmonics") or gn("rpm_filter_min_hz")
    simplified_gyro_multiplier = gn("simplified_gyro_filter_multiplier")
    simplified_dterm_multiplier = gn("simplified_dterm_filter_multiplier")

    # ── Motor ─────────────────────────────────────────────────────────────────
    motor_protocol = g("motor_pwm_protocol")
    motor_poles = gn("motor_poles")
    digital_idle = gn("digital_idle_percent")
    idle_min_rpm = gn("idle_min_rpm")
    throttle_boost = gn("throttle_boost")
    motor_output_limit = gn("motor_output_limit")

    # ── VTX ───────────────────────────────────────────────────────────────────
    vtx_band = gn("vtx_band")
    vtx_channel = gn("vtx_channel")
    vtx_power = gn("vtx_power")
    vtx_freq = gn("vtx_freq")

    # ── Receiver ─────────────────────────────────────────────────────────────
    rx_provider = g("serialrx_provider")
    rssi_src = g("rssi_src")
    rc_smoothing = g("rc_smoothing")

    # ── Failsafe ─────────────────────────────────────────────────────────────
    failsafe_delay = gn("failsafe_delay")
    gps_rescue_min_sats = gn("gps_rescue_min_sats")

    result: dict[str, Any] = {}

    if pids:
        result["pids"] = pids
        if simplified_pids and simplified_pids.lower() not in ("off", "0", "false"):
            result["pids"]["_simplified"] = {
                "mode": simplified_pids,
                "master": simplified_master,
                "pi_gain": simplified_pi,
                "d_gain": simplified_d,
                "i_gain": simplified_i,
                "ff_gain": simplified_ff,
            }

    if rates:
        result["rates"] = {
            "type": rates_type,
            "axes": rates,
        }
        if tpa_rate is not None:
            result["rates"]["tpa"] = {"rate": tpa_rate, "breakpoint": tpa_breakpoint}

    filters: dict[str, Any] = {}
    if simplified_gyro:
        filters["mode"] = "simplified"
        filters["gyro_simplified"] = simplified_gyro
        if simplified_gyro_multiplier is not None:
            filters["gyro_multiplier"] = simplified_gyro_multiplier
        if simplified_dterm_multiplier is not None:
            filters["dterm_multiplier"] = simplified_dterm_multiplier
    elif gyro_lpf1_hz is not None:
        filters["mode"] = "manual"
        filters["gyro_lpf1_hz"] = gyro_lpf1_hz
        if gyro_lpf2_hz is not None:
            filters["gyro_lpf2_hz"] = gyro_lpf2_hz
    if dterm_lpf_hz is not None:
        filters["dterm_lpf_hz"] = dterm_lpf_hz
    if dyn_notch_count is not None:
        filters["dyn_notch"] = {"count": int(dyn_notch_count), "min_hz": dyn_notch_min, "max_hz": dyn_notch_max}
    if rpm_filter_harmonics is not None:
        filters["rpm_filter"] = rpm_filter_harmonics
    if filters:
        result["filters"] = filters

    motor: dict[str, Any] = {}
    if motor_protocol:
        motor["protocol"] = motor_protocol
    if motor_poles is not None:
        motor["poles"] = int(motor_poles)
    if digital_idle is not None:
        motor["idle_pct"] = digital_idle
    elif idle_min_rpm is not None:
        motor["idle_min_rpm"] = int(idle_min_rpm)
    if throttle_boost is not None:
        motor["throttle_boost"] = throttle_boost
    if motor_output_limit is not None and motor_output_limit != 100:
        motor["output_limit_pct"] = motor_output_limit
    if motor:
        result["motor"] = motor

    vtx: dict[str, Any] = {}
    if vtx_freq:
        vtx["freq_mhz"] = vtx_freq
    elif vtx_band is not None:
        vtx["band"] = int(vtx_band)
        vtx["channel"] = int(vtx_channel) if vtx_channel else None
    if vtx_power is not None:
        vtx["power_level"] = int(vtx_power)
    if vtx:
        result["vtx"] = vtx

    rx: dict[str, Any] = {}
    if rx_provider:
        rx["provider"] = rx_provider
    if rssi_src:
        rx["rssi_src"] = rssi_src
    if rc_smoothing:
        rx["rc_smoothing"] = rc_smoothing
    if rx:
        result["receiver"] = rx

    if failsafe_delay is not None:
        result["failsafe"] = {"delay": failsafe_delay}
        if gps_rescue_min_sats is not None:
            result["failsafe"]["gps_rescue_min_sats"] = int(gps_rescue_min_sats)

    return result


def parse_betaflight_config(text: str) -> dict[str, Any]:
    """Return a dict mapping section → list of {key, value} dicts.

    Only sections that actually contain at least one setting are included.
    The ``other`` key collects settings that don't match any known prefix.
    Includes a top-level ``_summary`` key with structured PID/rates/filter data.
    """
    buckets: dict[str, list[dict[str, str]]] = {
        "pids": [], "rates": [], "filters": [],
        "motor": [], "receiver": [], "vtx": [], "osd": [], "failsafe": [], "other": [],
    }
    kv: dict[str, str] = {}
    pattern = re.compile(r"^set\s+(\w+)\s*=\s*(.+)$", re.MULTILINE)
    for match in pattern.finditer(text):
        key = match.group(1).strip()
        value = match.group(2).strip()
        bucket = _categorize(key)
        buckets[bucket].append({"key": key, "value": value})
        kv[key] = value

    return {section: entries for section, entries in buckets.items() if entries}
