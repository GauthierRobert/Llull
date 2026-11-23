"""VELOX-X: inline contra-rotating 'spindle' drone. All four rotors on the fuselage axis.

Nose pair (tractor) + tail pair (pusher), each pair contra-rotating, cruciform elevon fins on a short boom behind the tail pair:
  * no pods, no pylons: the drag of the X-quad's 4 pods + 4 pylons + their junctions (55 % of its CdA) is gone;
  * the aft rotor of each pair meets the fore rotor's swirl head-on (swirl recovery) and its slipstream (axial add);
  * the tail pair ingests the fuselage boundary layer (BLI): its inflow is reduced by the momentum deficit;
  * matched contra pairs carry ~zero net angular momentum: no gyroscopic coupling, fast attitude response;
  * the fins sit in the combined slipstream of both pairs: elevon control in hover (tail-sitter) and at speed; roll about the
    long axis comes from the torque split inside each pair; fin incidence carries the weight at speed; thin toe rods on the
    fin tips reach past the disk radius and are the landing feet.
Same component physics as velox_model.py (BEMT, motor, pack, drag build-up).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

import numpy as np

from velox_model import (
    CELLS,
    G0,
    RPM_GRID,
    Motor,
    Pack,
    Prop,
    _body_cda,
    _surface_cda,
    isa,
    prop_performance,
)


@dataclass(frozen=True)
class InlineAirframe:
    fuselage_length_mm: float = 660.0
    fuselage_diameter_mm: float = 78.0
    fin_chord_mm: float = 48.0  # mean (55 root, 40 tip)
    fin_span_mm: float = 81.0  # boom radius 16 mm -> 0.85 R (inside the hover slipstream)
    fin_tc: float = 0.08
    interference: float = 1.06  # four fin junctions only
    cooling_cda_m2: float = 0.00026  # annular ram inlet behind the nose spinner + exit through the tail-pair hub, 4 motors + pack
    toe_rods_cda_m2: float = 0.00004  # 4 streamlined CFRP landing toes, 6 x 3 mm
    misc_factor: float = 1.06
    structure_mass_kg: float = 0.54  # longer shell, tail boom, 4 fins + toes, 2 motor bulkheads, 2 bearing cartridges
    avionics_mass_kg: float = 0.38  # 4 ESCs, FC + GNSS + RX + telemetry, 4 elevon servos, wiring
    bli_deficit: float = 0.04  # disk-averaged inflow deficit at the tail rotors from the fuselage boundary layer


def inline_cda(af: InlineAirframe, v: float, rho: float, a: float, mu: float) -> dict[str, float]:
    mach = max(v / a, 0.05)
    v = max(v, 5.0)
    mm = 1e-3
    parts = {
        "fuselage": _body_cda(af.fuselage_length_mm * mm, af.fuselage_diameter_mm * mm, v, rho, mu, mach),
        "fins x4": 4 * _surface_cda(af.fin_chord_mm * mm, af.fin_span_mm * mm, af.fin_tc, v, rho, mu, mach),
    }
    clean = sum(parts.values())
    parts["interference"] = clean * (af.interference - 1)
    parts["cooling"] = af.cooling_cda_m2
    parts["toe rods"] = af.toe_rods_cda_m2
    parts["misc"] = (clean * af.interference + af.cooling_cda_m2 + af.toe_rods_cda_m2) * (af.misc_factor - 1)
    parts["total"] = sum(parts.values())
    return parts


@dataclass(frozen=True)
class InlineVehicle:
    prop: Prop = field(default_factory=lambda: Prop(diameter_in=9.0, pitch_ratio=3.4, hub_ratio=0.36, chord_75_over_r=0.13))
    aft_pitch_delta: float = 0.25  # the aft rotor of each pair is pitched up by this P/D (it sees the fore slipstream)
    motor: Motor = field(default_factory=lambda: Motor(kv=850.0, mass_kg=0.32))
    pack: Pack = field(default_factory=lambda: Pack(series=18, parallel=2, cell_key="1550"))
    airframe: InlineAirframe = field(default_factory=InlineAirframe)
    esc_efficiency: float = 0.97
    max_duty: float = 0.97
    prop_mass_kg: float = 0.034  # CFRP blade pair on a split hub, 9 in with a 0.36 hub ratio
    altitude_m: float = 0.0
    delta_t: float = 0.0
    fin_cl_max_use: float = 0.6
    swirl_recovery: float = 1.0  # share of the fore rotor's far-wake swirl met by the aft rotor (1 = close-coupled pair)
    slipstream_factor: float = 1.6  # fore induced velocity at the aft disk / at the fore disk (0.15 R spacing: 1 + ~0.6)

    @property
    def mass_kg(self) -> float:
        return self.pack.mass_kg + 4 * (self.motor.mass_kg + self.prop_mass_kg) + self.airframe.structure_mass_kg + self.airframe.avionics_mass_kg


@dataclass
class InlinePoint:
    rpm: list[float]
    thrust: list[float]
    shaft_power: list[float]
    motor_current: list[float]
    bus_voltage: float
    pack_current: float
    electrical_power: float
    propulsive_efficiency: float  # sum(T) * V / sum(shaft power)
    tip_helical_mach: float
    limited_by: str


_CURVES: dict[tuple, object] = {}


def _rotor_curve(veh: InlineVehicle, prop: Prop, v_axial: float, axial_add, swirl_add, rho, a, mu, key_extra=None):
    m = veh.motor
    key = (prop, round(v_axial, 3), rho, key_extra)
    curve = _CURVES.get(key)
    if curve is None:
        curve = prop_performance(prop, v_axial, RPM_GRID, rho, a, mu, axial_add, swirl_add)
        if len(_CURVES) > 4000:
            _CURVES.clear()
        _CURVES[key] = curve
    current = np.maximum(curve.torque, 0) / m.kt + m.i0_per_krpm * RPM_GRID / 1000
    v_needed = current * m.r_hot + RPM_GRID * 2 * math.pi / 60 * m.kt
    return curve, current, v_needed


def _settle(v_needed, current, v_limit, i_limit) -> float:
    feasible = (v_needed <= v_limit) & (current <= i_limit)
    if not feasible[0]:
        return float(RPM_GRID[0])
    if feasible.all():
        return float(RPM_GRID[-1])
    k = int(np.argmin(feasible)) - 1
    g0 = max((v_needed[k] - v_limit) / v_limit, (current[k] - i_limit) / i_limit)
    g1 = max((v_needed[k + 1] - v_limit) / v_limit, (current[k + 1] - i_limit) / i_limit)
    f = g0 / (g0 - g1) if g1 != g0 else 0.0
    return float(RPM_GRID[k] + f * (RPM_GRID[k + 1] - RPM_GRID[k]))


def _pair(veh: InlineVehicle, v_in: float, v_limit: float, i_limit: float, rho, a, mu):
    """Fore + aft rotor of one contra pair at a motor voltage limit: (rpms, thrusts, powers, currents, max tip Mach)."""
    fore = veh.prop
    aft = replace(veh.prop, pitch_ratio=veh.prop.pitch_ratio + veh.aft_pitch_delta)
    c1, i1, v1 = _rotor_curve(veh, fore, v_in, 0.0, 0.0, rho, a, mu)
    rpm1 = _settle(v1, i1, v_limit, i_limit)
    k = int(np.clip(np.searchsorted(RPM_GRID, rpm1), 1, len(RPM_GRID) - 1))
    w = (rpm1 - RPM_GRID[k - 1]) / (RPM_GRID[k] - RPM_GRID[k - 1])
    vi1 = (1 - w) * c1.induced_axial[k - 1] + w * c1.induced_axial[k]
    vt1 = (1 - w) * c1.induced_swirl[k - 1] + w * c1.induced_swirl[k]
    aft_key = ("aft", round(rpm1 / 40), veh.slipstream_factor, veh.swirl_recovery)
    c2, i2, v2 = _rotor_curve(veh, aft, v_in, (veh.slipstream_factor - 1) * vi1, 2 * vt1 * veh.swirl_recovery, rho, a, mu, aft_key)
    rpm2 = _settle(v2, i2, v_limit, i_limit)
    rpms = [rpm1, rpm2]
    thrust = [float(np.interp(rpm1, RPM_GRID, c1.thrust)), float(np.interp(rpm2, RPM_GRID, c2.thrust))]
    power = [float(np.interp(rpm1, RPM_GRID, c1.power)), float(np.interp(rpm2, RPM_GRID, c2.power))]
    currents = [float(np.interp(rpm1, RPM_GRID, i1)), float(np.interp(rpm2, RPM_GRID, i2))]
    volts = [float(np.interp(rpm1, RPM_GRID, v1)), float(np.interp(rpm2, RPM_GRID, v2))]
    tip = max(float(np.interp(rpm1, RPM_GRID, c1.tip_helical_mach)), float(np.interp(rpm2, RPM_GRID, c2.tip_helical_mach)))
    return rpms, thrust, power, currents, volts, tip, float(np.mean(vi1))


def inline_point(veh: InlineVehicle, v: float, throttle: float = 1.0) -> InlinePoint:
    rho, a, mu = isa(veh.altitude_m, veh.delta_t)
    pack = veh.pack
    v_bus = pack.series * pack.ocv_cell_at_run
    limited = "voltage"
    for _ in range(40):
        v_lim = v_bus * veh.max_duty * throttle
        f_rpm, f_t, f_p, f_i, f_v, f_tip, vi_mean = _pair(veh, v, v_lim, veh.motor.i_max, rho, a, mu)
        # tail pair: freestream minus the boundary-layer deficit plus what is left of the nose slipstream (2 vi, mixed out)
        v_tail = v * (1 - veh.airframe.bli_deficit) + 2 * vi_mean * 0.5
        r_rpm, r_t, r_p, r_i, r_v, r_tip, _ = _pair(veh, v_tail, v_lim, veh.motor.i_max, rho, a, mu)
        p_el = sum(vv * ii for vv, ii in zip(f_v + r_v, f_i + r_i)) / veh.esc_efficiency
        i_pack = p_el / v_bus
        if i_pack > pack.i_max * 1.001:
            throttle *= (pack.i_max / i_pack) ** 0.5
            limited = "pack current"
            continue
        v_new = pack.series * pack.ocv_cell_at_run - pack.r_int * i_pack
        if abs(v_new - v_bus) < 0.05:
            v_bus = v_new
            break
        v_bus = 0.5 * v_bus + 0.5 * v_new
    currents = f_i + r_i
    if limited != "pack current":
        limited = "motor current" if max(currents) >= 0.99 * veh.motor.i_max else "voltage"
    thrust = f_t + r_t
    shaft = f_p + r_p
    # BLI: the tail pair's thrust is produced on slower air, so the useful power is sum(T) * V on the flight speed
    eta = sum(thrust) * v / sum(shaft) if sum(shaft) > 0 else 0.0
    return InlinePoint(f_rpm + r_rpm, thrust, shaft, currents, v_bus, p_el / v_bus, p_el, eta, max(f_tip, r_tip), limited)


def fin_lift(veh: InlineVehicle, v: float) -> tuple[float, float]:
    rho, _, _ = isa(veh.altitude_m, veh.delta_t)
    af = veh.airframe
    q = 0.5 * rho * v**2
    area = 4 * af.fin_chord_mm * af.fin_span_mm * 1e-6
    weight = veh.mass_kg * G0
    lift = min(weight, q * area * veh.fin_cl_max_use * math.cos(math.pi / 4))
    span = 2 * (af.fuselage_diameter_mm / 2 + af.fin_span_mm) * 1e-3 * math.cos(math.pi / 4)
    induced = lift**2 / (q * math.pi * span**2 * 0.9) if q > 0 else 0.0
    return lift, induced


def inline_excess(veh: InlineVehicle, v: float) -> tuple[float, InlinePoint, float, float]:
    rho, a, mu = isa(veh.altitude_m, veh.delta_t)
    lift, induced = fin_lift(veh, v)
    drag = 0.5 * rho * v**2 * inline_cda(veh.airframe, v, rho, a, mu)["total"] + induced
    lift_needed = veh.mass_kg * G0 - lift
    t_req = math.hypot(drag, lift_needed)
    eps = math.atan2(lift_needed, drag)
    pt = inline_point(veh, v * math.cos(eps))
    return sum(pt.thrust) - t_req, pt, eps, drag


def inline_top_speed(veh: InlineVehicle, v_lo: float = 150.0, v_hi: float = 340.0):
    for _ in range(13):
        mid = 0.5 * (v_lo + v_hi)
        if inline_excess(veh, mid)[0] > 0:
            v_lo = mid
        else:
            v_hi = mid
    ex, pt, eps, drag = inline_excess(veh, v_lo)
    return v_lo, pt, eps, drag


def inline_static_tw(veh: InlineVehicle) -> float:
    pt = inline_point(veh, 0.0)
    return sum(pt.thrust) / (veh.mass_kg * G0)
