"""Betaflight CLI output parser.

Parses `diff all` / `dump` text into categorized key-value sections so the UI
can display structured PID / rate / filter tables instead of raw text.
"""

import re
from typing import Any

# Prefixes that classify a `set <key> = <value>` line into a section.
_PID_PREFIXES = (
    "pid_roll", "pid_pitch", "pid_yaw",
    "p_roll", "p_pitch", "p_yaw",
    "i_roll", "i_pitch", "i_yaw",
    "d_roll", "d_pitch", "d_yaw",
    "f_roll", "f_pitch", "f_yaw",
    "iterm_relax", "iterm_windup", "pidsum_limit",
    "angle_limit", "horizon_tilt", "anti_gravity",
    "crash_recovery", "vbat_pid_gain",
    "ff_interpolate", "ff_smooth", "ff_boost",
    "feedforward_transition", "feedforward_averaging",
    "feedforward_smooth_factor", "feedforward_jitter",
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
    "simplified_pids_mode", "simplified_master_multiplier",
)

_MOTOR_PREFIXES = (
    "motor_pwm_protocol", "motor_poles", "motor_pwm_rate",
    "dshot_idle_value", "idle_min_rpm", "digital_idle_percent",
    "use_unsynced_pwm", "min_throttle", "max_throttle",
    "motor_output_limit", "throttle_boost",
)

_RECEIVER_PREFIXES = (
    "serialrx_provider", "serialrx_halfduplex",
    "rc_smoothing", "rc_interp", "rc_deadband", "yaw_deadband",
    "receiver_type", "rx_min_usec", "rx_max_usec",
    "rssi_channel", "rssi_src", "rssi_scale",
)

_VTX_PREFIXES = (
    "vtx_band", "vtx_channel", "vtx_power", "vtx_low_power_disarm",
    "vcd_video_system",
)

_OSD_PREFIXES = (
    "osd_", "displayport_",
)


def _categorize(key: str) -> str:
    for prefix in _PID_PREFIXES:
        if key.startswith(prefix):
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
    return "other"


def parse_betaflight_config(text: str) -> dict[str, Any]:
    """Return a dict mapping section → list of {key, value} dicts.

    Only sections that actually contain at least one setting are included.
    The ``other`` key collects settings that don't match any known prefix.
    """
    buckets: dict[str, list[dict[str, str]]] = {
        "pids": [], "rates": [], "filters": [],
        "motor": [], "receiver": [], "vtx": [], "osd": [], "other": [],
    }
    pattern = re.compile(r"^set\s+(\w+)\s*=\s*(.+)$", re.MULTILINE)
    for match in pattern.finditer(text):
        key = match.group(1).strip()
        value = match.group(2).strip()
        bucket = _categorize(key)
        buckets[bucket].append({"key": key, "value": value})
    # Return only non-empty sections; drop "other" if empty to keep response clean
    return {section: entries for section, entries in buckets.items() if entries}
