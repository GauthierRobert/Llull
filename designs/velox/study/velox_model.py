"""VELOX-Q speed quadcopter: first-principles performance model (design study, not a llull command).

Pieces, each a standard method with its source named:
  * ISA atmosphere.
  * Propeller: blade-element momentum (BEMT) with Prandtl tip loss, swirl, a thin cambered section with
    Prandtl-Glauert lift slope, stall, Korn-equation drag divergence (Mason, "Configuration Aerodynamics" ch. 7;
    Lock's 20(M-Mcr)^4 wave drag) and simple-sweep theory for a swept tip.
  * Motor: DC equivalent of a BLDC (Kv, phase-phase R hot, speed-proportional no-load current).
  * ESC + battery: duty <= 0.97, constant ESC efficiency, pack OCV - R_int * I.
  * Airframe drag: component build-up (Raymer, "Aircraft Design" 6th ed. ch. 12: turbulent flat-plate Cf with the
    compressibility term, form factors, interference), Prandtl-Glauert on the pressure part, cooling / misc adders.
Every number is SI unless the name says otherwise (mm, inch, g).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

import numpy as np

G0 = 9.80665
INCH = 0.0254


# ----------------------------------------------------------------------------- atmosphere
def isa(altitude_m: float, delta_t: float = 0.0) -> tuple[float, float, float]:
    """Return (density kg/m3, speed of sound m/s, dynamic viscosity Pa s) of ISA + delta_t at altitude."""
    t = 288.15 - 0.0065 * altitude_m + delta_t
    p = 101325.0 * pow(1 - 0.0065 * altitude_m / 288.15, 5.25588)
    rho = p / (287.053 * t)
    a = math.sqrt(1.4 * 287.053 * t)
    mu = 1.458e-6 * t**1.5 / (t + 110.4)
    return rho, a, mu


# ----------------------------------------------------------------------------- propeller
@dataclass(frozen=True)
class Prop:
    diameter_in: float = 6.5
    pitch_ratio: float = 1.6  # geometric pitch / diameter at 0.75 R (constant-pitch helix)
    blades: int = 2
    chord_75_over_r: float = 0.15  # chord / tip radius at 0.75 R
    hub_ratio: float = 0.24  # spinner radius / tip radius (blade root)
    tc_root: float = 0.12
    tc_tip: float = 0.055
    tip_sweep_deg: float = 30.0  # scimitar sweep at the tip (quadratic from 0.55 R)
    korn_kappa: float = 0.90  # 0.87 conventional NACA 6-series, 0.95 supercritical
    cl_max: float = 1.15
    alpha0_deg: float = -2.5  # zero-lift angle of the cambered section
    stations: int = 40

    @property
    def radius(self) -> float:
        return self.diameter_in * INCH / 2


@dataclass
class PropResult:
    thrust: float
    torque: float
    power: float
    efficiency: float
    tip_helical_mach: float
    max_section_mach: float
    induced_axial: np.ndarray | None = None  # vi per (rpm, station), m/s, at the disk
    induced_swirl: np.ndarray | None = None  # vt per (rpm, station), m/s, at the disk (half the far-wake swirl)
    stations: np.ndarray | None = None  # x = r / R


def _section(alpha, mach_n, cos_sweep, tc, reynolds, prop: Prop):
    """Lift / drag coefficients of the section, normal-Mach (simple-sweep) form."""
    beta_pg = np.sqrt(np.maximum(1 - np.minimum(mach_n, 0.92) ** 2, 0.15))
    a0 = math.radians(prop.alpha0_deg)
    slope = 2 * math.pi * 0.92 / beta_pg * cos_sweep
    cl_lin = slope * (alpha - a0)
    cl_max = prop.cl_max * np.clip(1 - 0.9 * np.maximum(mach_n - 0.35, 0), 0.45, 1)
    stalled = np.abs(cl_lin) > cl_max
    cl = np.where(stalled, np.sign(cl_lin) * cl_max * 0.75, cl_lin)
    cf = 0.074 / np.maximum(reynolds, 2e4) ** 0.2
    cd0 = 2 * cf * (1 + 2 * tc + 60 * tc**4)
    cd = cd0 + 0.012 * (cl - 0.45) ** 2
    excess = np.where(stalled, np.abs(alpha - a0) - cl_max / slope, 0.0)
    cd = cd + np.where(stalled, 1.6 * np.sin(np.minimum(excess, 1.2)) ** 2 + 0.03, 0.0)
    # Korn: M_dd = kappa/cosL - (t/c)/cos^2L - cl/(10 cos^3L); critical = M_dd - (0.1/80)^(1/3); Lock 20(M-Mcr)^4
    m_dd = prop.korn_kappa / cos_sweep - tc / cos_sweep**2 - np.abs(cl) / (10 * cos_sweep**3)
    m_cr = m_dd - (0.1 / 80) ** (1 / 3)
    mach = mach_n / cos_sweep
    over = np.maximum(mach - m_cr, 0)
    cd = cd + 20 * over**4 + np.where(mach > m_dd + 0.15, 0.6 * (mach - m_dd - 0.15), 0)
    # Beyond drag divergence the lift slope collapses (shock-induced separation).
    cl = cl * np.clip(1 - 2.0 * np.maximum(mach - m_dd - 0.05, 0), 0.4, 1)
    return cl, cd


def prop_performance(
    prop: Prop, v_axial: float, rpm, rho: float, a_sound: float, mu: float, axial_add=0.0, swirl_add=0.0
) -> PropResult:
    """BEMT, vectorised over rpm: induced axial velocity per annulus by bisection (blade = momentum thrust), swirl by fixed point.

    `rpm` may be a scalar or a 1-D array; the PropResult fields are then floats or arrays of the same length.
    axial_add / swirl_add: extra inflow per station (an upstream rotor's slipstream; swirl_add > 0 = counter-swirl that
    the blade meets head-on, i.e. a contra-rotating aft rotor), scalar or shape (stations,).
    """
    scalar = np.ndim(rpm) == 0
    rpm_arr = np.atleast_1d(np.asarray(rpm, dtype=float))[:, None]
    radius = prop.radius
    x = np.linspace(prop.hub_ratio, 0.995, prop.stations)[None, :]
    r = x * radius
    dr = np.gradient(r[0])[None, :]
    omega = rpm_arr * 2 * math.pi / 60
    pitch = prop.pitch_ratio * 2 * radius
    beta = np.arctan(pitch / (2 * math.pi * r))
    taper = (1.25 - 0.55 * x) * np.sqrt(np.clip(1 - x**10, 0.05, 1))
    taper_75 = (1.25 - 0.55 * 0.75) * math.sqrt(1 - 0.75**10)
    chord = prop.chord_75_over_r * radius * taper / taper_75
    tc = prop.tc_root + (prop.tc_tip - prop.tc_root) * (x - x[0, 0]) / (1 - x[0, 0])
    sweep = np.radians(prop.tip_sweep_deg) * np.clip((x - 0.55) / 0.45, 0, 1) ** 2
    cos_sweep = np.cos(sweep)
    blades = prop.blades
    shape = (rpm_arr.shape[0], x.shape[1])

    axial_add = np.broadcast_to(np.asarray(axial_add, dtype=float), (x.shape[1],))[None, :]
    swirl_add = np.broadcast_to(np.asarray(swirl_add, dtype=float), (x.shape[1],))[None, :]

    def aero(vi, vt):
        ua = v_axial + axial_add + vi
        ut = omega * r - vt + swirl_add
        phi = np.arctan2(ua, ut)
        w = np.hypot(ua, ut)
        cl, cd = _section(beta - phi, w * cos_sweep / a_sound, cos_sweep, tc, rho * w * chord / mu, prop)
        sphi = np.maximum(np.abs(np.sin(phi)), 1e-4)
        f_tip = np.maximum(2 / math.pi * np.arccos(np.clip(np.exp(-blades / 2 * (radius - r) / (r * sphi)), 0, 1)), 0.02)
        return ua, phi, w, cl, cd, f_tip

    vt = np.zeros(shape)
    for _ in range(6):
        lo = np.full(shape, -0.45 * max(v_axial, 1e-6))
        hi = 3.0 * (v_axial + 0.35 * omega * radius) + 5 + np.zeros(shape)
        for _ in range(34):
            mid = 0.5 * (lo + hi)
            ua, phi, w, cl, cd, f_tip = aero(mid, vt)
            cn = cl * np.cos(phi) - cd * np.sin(phi)
            positive = blades * 0.5 * w**2 * chord * cn - 4 * math.pi * r * f_tip * np.abs(ua) * mid > 0
            lo = np.where(positive, mid, lo)
            hi = np.where(positive, hi, mid)
        vi = 0.5 * (lo + hi)
        ua, phi, w, cl, cd, f_tip = aero(vi, vt)
        ct = cl * np.sin(phi) + cd * np.cos(phi)
        vt_new = blades * 0.5 * w**2 * chord * ct / (4 * math.pi * r * f_tip * np.maximum(np.abs(ua), 1.0) * 2)
        vt = 0.5 * vt + 0.5 * np.minimum(vt_new, 0.3 * omega * r)

    cn = cl * np.cos(phi) - cd * np.sin(phi)
    thrust = (blades * 0.5 * rho * w**2 * chord * cn * dr).sum(axis=1)
    torque = (blades * 0.5 * rho * w**2 * chord * ct * r * dr).sum(axis=1)
    om = omega[:, 0]
    power = torque * om
    eff = np.where(power > 0, thrust * v_axial / np.maximum(power, 1e-9), 0.0)
    tip = np.hypot(om * radius, v_axial) / a_sound
    max_mach = (w / a_sound).max(axis=1)
    if scalar:
        return PropResult(float(thrust[0]), float(torque[0]), float(power[0]), float(eff[0]), float(tip[0]), float(max_mach[0]), vi, vt, x[0])
    return PropResult(thrust, torque, power, eff, tip, max_mach, vi, vt, x[0])


# ----------------------------------------------------------------------------- powertrain
@dataclass(frozen=True)
class Motor:
    """Inrunner BLDC class. Copper loss = (torque / Km)^2 whatever the winding; Km grows with active mass.

    Reference: a 205 g, 36 mm can, 4-pole inrunner of the F5D pylon-racing class, Km = 0.063 N m / sqrt(W) with the
    winding hot (95 C). Km ~ mass^1.25 (same length/diameter ratio). Grade C until the bench test (README section 9, T-03).
    """

    kv: float = 1000.0  # rpm / V
    mass_kg: float = 0.205
    km_ref: float = 0.0631
    mass_ref_kg: float = 0.205
    i0_a_per_krpm: float = 0.085  # at Kv 1000; scales with Kv (same iron loss at the same speed)
    i_max: float = 220.0  # ESC phase-current limit (burst)

    @property
    def kt(self) -> float:
        return 60 / (2 * math.pi * self.kv)

    @property
    def km(self) -> float:
        return self.km_ref * (self.mass_kg / self.mass_ref_kg) ** 1.25

    @property
    def r_hot(self) -> float:
        return (self.kt / self.km) ** 2

    @property
    def i0_per_krpm(self) -> float:
        return self.i0_a_per_krpm * self.kv / 1000


@dataclass(frozen=True)
class Cell:
    name: str
    capacity_ah: float
    mass_kg: float
    dcir_ohm: float  # warm (40 C), 10 s pulse
    i_burst: float  # 10 s
    volume_cm3: float


CELLS = {
    "1050": Cell("1050 mAh 150C-class LiPo pouch", 1.05, 0.0245, 0.0030, 140.0, 14.5),
    "1300": Cell("1300 mAh 150C-class LiPo pouch", 1.30, 0.0300, 0.0025, 169.0, 17.6),
    "1550": Cell("1550 mAh 150C-class LiPo pouch", 1.55, 0.0355, 0.0022, 190.0, 21.0),
}


@dataclass(frozen=True)
class Pack:
    series: int = 16
    parallel: int = 2
    cell_key: str = "1300"
    harness_ohm: float = 0.0035  # connectors + bus bars + wires to the 4 pods (one-way + return)
    ocv_cell_at_run: float = 4.05  # mid-run open-circuit volts per cell (fresh 4.20 V, run uses < 40 % SoC)

    @property
    def cell(self) -> Cell:
        return CELLS[self.cell_key]

    @property
    def r_int(self) -> float:
        return self.series * self.cell.dcir_ohm / self.parallel + self.harness_ohm

    @property
    def mass_kg(self) -> float:
        return self.series * self.parallel * self.cell.mass_kg * 1.12  # tabs, bus bars, wrap, balance leads

    @property
    def i_max(self) -> float:
        return self.parallel * self.cell.i_burst

    @property
    def energy_wh(self) -> float:
        return self.series * 3.7 * self.parallel * self.cell.capacity_ah


# ----------------------------------------------------------------------------- airframe
@dataclass(frozen=True)
class Airframe:
    fuselage_length_mm: float = 520.0
    fuselage_diameter_mm: float = 74.0
    pod_length_mm: float = 150.0
    pod_diameter_mm: float = 38.0
    pylon_chord_mm: float = 46.0
    pylon_span_mm: float = 70.0
    pylon_tc: float = 0.12
    fin_chord_mm: float = 60.0
    fin_span_mm: float = 48.0
    fin_tc: float = 0.08
    interference: float = 1.15
    cooling_cda_m2: float = 4 * 0.00006 + 0.00008  # motor ram-air ducts + battery plenum
    misc_factor: float = 1.06  # antennas, panel gaps, leakage
    structure_mass_kg: float = 0.62  # shell, pylons, pods, fins, frames, fasteners (mass budget, README §6)
    avionics_mass_kg: float = 0.30  # 4 ESCs, FC + GNSS + RX + telemetry, wiring


def _cf(re: float, mach: float) -> float:
    return 0.455 / (math.log10(re) ** 2.58 * (1 + 0.144 * mach**2) ** 0.65)


def _body_cda(length, diameter, v, rho, mu, mach) -> float:
    f = length / diameter
    ff = 1 + 60 / f**3 + f / 400
    ff = 1 + (ff - 1) / math.sqrt(max(1 - mach**2, 0.2))
    s_wet = math.pi * diameter * length * 0.78
    return _cf(rho * v * length / mu, mach) * ff * s_wet


def _surface_cda(chord, span, tc, v, rho, mu, mach) -> float:
    ff = (1 + 0.6 / 0.3 * tc + 100 * tc**4) * 1.34 * mach**0.18
    return _cf(rho * v * chord / mu, mach) * ff * 2.04 * chord * span


def airframe_cda(af: Airframe, v: float, rho: float, a: float, mu: float) -> dict[str, float]:
    mach = max(v / a, 0.05)
    v = max(v, 5.0)
    mm = 1e-3
    parts = {
        "fuselage": _body_cda(af.fuselage_length_mm * mm, af.fuselage_diameter_mm * mm, v, rho, mu, mach),
        "pods x4": 4 * _body_cda(af.pod_length_mm * mm, af.pod_diameter_mm * mm, v, rho, mu, mach),
        "pylons x4": 4 * _surface_cda(af.pylon_chord_mm * mm, af.pylon_span_mm * mm, af.pylon_tc, v, rho, mu, mach),
        "fins x4": 4 * _surface_cda(af.fin_chord_mm * mm, af.fin_span_mm * mm, af.fin_tc, v, rho, mu, mach),
    }
    clean = sum(parts.values())
    parts["interference"] = clean * (af.interference - 1)
    parts["cooling"] = af.cooling_cda_m2
    parts["misc"] = (clean * af.interference + af.cooling_cda_m2) * (af.misc_factor - 1)
    parts["total"] = sum(parts.values())
    return parts


# ----------------------------------------------------------------------------- vehicle
@dataclass(frozen=True)
class Vehicle:
    prop: Prop = field(default_factory=Prop)
    motor: Motor = field(default_factory=Motor)
    pack: Pack = field(default_factory=Pack)
    airframe: Airframe = field(default_factory=Airframe)
    esc_efficiency: float = 0.97
    max_duty: float = 0.97
    prop_mass_ref_kg: float = 0.020  # CFRP 2-blade at 6.5 in, scales with D^3
    altitude_m: float = 0.0
    delta_t: float = 0.0
    lifting_pylons: bool = True  # X pylons with incidence carry the weight at speed (invention 2, README section 3)
    pylon_cl_max_use: float = 0.6  # largest pylon lift coefficient used (margin to the section stall, ~1.1)
    pylon_oswald: float = 0.95  # pods act as end plates

    @property
    def prop_mass_kg(self) -> float:
        return self.prop_mass_ref_kg * (self.prop.diameter_in / 6.5) ** 3

    @property
    def mass_kg(self) -> float:
        return (
            self.pack.mass_kg + 4 * (self.motor.mass_kg + self.prop_mass_kg) + self.airframe.structure_mass_kg + self.airframe.avionics_mass_kg
        )


@dataclass
class OperatingPoint:
    rpm: float
    thrust_per_rotor: float
    shaft_power_per_rotor: float
    motor_current: float
    bus_voltage: float
    pack_current: float
    electrical_power: float
    prop: PropResult
    limited_by: str


RPM_GRID = np.linspace(2000.0, 110000.0, 109)


def operating_point(veh: Vehicle, v_axial: float, throttle: float = 1.0) -> OperatingPoint:
    """Equilibrium of prop + motor + ESC + pack at a throttle (all 4 rotors identical); ESC limiter on pack current."""
    rho, a, mu = isa(veh.altitude_m, veh.delta_t)
    m = veh.motor
    kt = 60 / (2 * math.pi * m.kv)
    r_m = m.r_hot
    pack = veh.pack
    curve = prop_performance(veh.prop, v_axial, RPM_GRID, rho, a, mu)
    current = np.maximum(curve.torque, 0) / kt + m.i0_per_krpm * RPM_GRID / 1000
    v_needed = current * r_m + RPM_GRID * 2 * math.pi / 60 * kt
    p_motor = v_needed * current

    def settle(v_limit: float, i_motor_limit: float) -> float:
        feasible = (v_needed <= v_limit) & (current <= i_motor_limit)
        if not feasible[0]:
            return float(RPM_GRID[0])
        k = int(np.argmin(feasible)) - 1 if not feasible.all() else len(RPM_GRID) - 1
        if k >= len(RPM_GRID) - 1:
            return float(RPM_GRID[-1])
        # linear interpolation of the binding constraint between grid k and k+1
        g0 = max((v_needed[k] - v_limit) / v_limit, (current[k] - i_motor_limit) / i_motor_limit)
        g1 = max((v_needed[k + 1] - v_limit) / v_limit, (current[k + 1] - i_motor_limit) / i_motor_limit)
        f = g0 / (g0 - g1) if g1 != g0 else 0.0
        return float(RPM_GRID[k] + f * (RPM_GRID[k + 1] - RPM_GRID[k]))

    v_bus = pack.series * pack.ocv_cell_at_run
    i_motor_cap = m.i_max
    limited = "voltage"
    rpm = RPM_GRID[0]
    for _ in range(40):
        rpm = settle(v_bus * veh.max_duty * throttle, i_motor_cap)
        p_el = 4 * float(np.interp(rpm, RPM_GRID, p_motor)) / veh.esc_efficiency
        i_pack = p_el / v_bus
        if i_pack > pack.i_max * 1.001:
            throttle *= (pack.i_max / i_pack) ** 0.5
            limited = "pack current"
            continue
        v_bus_new = pack.series * pack.ocv_cell_at_run - pack.r_int * i_pack
        if abs(v_bus_new - v_bus) < 0.005:
            v_bus = v_bus_new
            break
        v_bus = 0.5 * v_bus + 0.5 * v_bus_new
    i_m = float(np.interp(rpm, RPM_GRID, current))
    if limited != "pack current":
        limited = "motor current" if i_m >= 0.99 * m.i_max else "voltage"
    pr = prop_performance(veh.prop, v_axial, rpm, rho, a, mu)
    p_el = 4 * float(np.interp(rpm, RPM_GRID, p_motor)) / veh.esc_efficiency
    return OperatingPoint(rpm, pr.thrust, pr.power, i_m, v_bus, p_el / v_bus, p_el, pr, limited)


def pylon_lift(veh: Vehicle, v: float) -> tuple[float, float]:
    """(lift N, induced drag N) of the four X pylons at v, lift capped at pylon_cl_max_use and at the weight."""
    if not veh.lifting_pylons:
        return 0.0, 0.0
    rho, _, _ = isa(veh.altitude_m, veh.delta_t)
    af = veh.airframe
    q = 0.5 * rho * v**2
    area = 4 * af.pylon_chord_mm * af.pylon_span_mm * 1e-6
    weight = veh.mass_kg * G0
    lift = min(weight, q * area * veh.pylon_cl_max_use * math.cos(math.pi / 4))
    span = 2 * (af.fuselage_diameter_mm / 2 + af.pylon_span_mm + af.pod_diameter_mm / 2) * 1e-3 * math.cos(math.pi / 4)
    induced = lift**2 / (q * math.pi * span**2 * veh.pylon_oswald) if q > 0 else 0.0
    return lift, induced


def required_thrust(veh: Vehicle, v: float) -> tuple[float, float, float]:
    """(total thrust N, rotor-axis angle above the flight path rad, drag N) for level flight at v."""
    rho, a, mu = isa(veh.altitude_m, veh.delta_t)
    lift, induced = pylon_lift(veh, v)
    drag = 0.5 * rho * v**2 * airframe_cda(veh.airframe, v, rho, a, mu)["total"] + induced
    lift_needed = veh.mass_kg * G0 - lift
    return math.hypot(drag, lift_needed), math.atan2(lift_needed, drag), drag


def excess_thrust(veh: Vehicle, v: float) -> tuple[float, OperatingPoint, float]:
    t_req, eps, _ = required_thrust(veh, v)
    op = operating_point(veh, v * math.cos(eps))
    return 4 * op.thrust_per_rotor - t_req, op, eps


def top_speed(veh: Vehicle, v_lo: float = 60.0, v_hi: float = 320.0) -> tuple[float, OperatingPoint, float]:
    if excess_thrust(veh, v_lo)[0] <= 0:
        return v_lo, excess_thrust(veh, v_lo)[1], 0.0
    for _ in range(16):
        mid = 0.5 * (v_lo + v_hi)
        if excess_thrust(veh, mid)[0] > 0:
            v_lo = mid
        else:
            v_hi = mid
    ex, op, eps = excess_thrust(veh, v_lo)
    return v_lo, op, eps


def acceleration_run(veh: Vehicle, v_end_fraction: float = 0.98, dt: float = 0.05) -> dict[str, float]:
    """Level acceleration from 20 m/s (after the vertical launch + pitch-over) to v_end_fraction * top speed."""
    v_top, _, _ = top_speed(veh)
    v, x, t, energy, heat_pack = 20.0, 0.0, 0.0, 0.0, 0.0
    m = veh.mass_kg
    while v < v_end_fraction * v_top and t < 60:
        ex, op, _ = excess_thrust(veh, v)
        acc = max(ex, 0.5) / m
        v += acc * dt
        x += v * dt
        t += dt
        energy += op.electrical_power * dt
        heat_pack += op.pack_current**2 * veh.pack.r_int * dt
    return {"time_s": t, "distance_m": x, "energy_wh": energy / 3600, "pack_heat_j": heat_pack, "v_top": v_top}


def thermal_check(veh: Vehicle, op: OperatingPoint, full_power_s: float = 14.0) -> dict[str, float]:
    """Temperature rise of motor and pack over a full-power segment at the operating point (lumped, conservative).

    Motor: copper I^2 R + iron/bearing loss (I0 * V), ram-air cooled at h_A = 18 W/K, cp_eff 520 J/(kg K).
    Pack: I^2 R_cells, adiabatic (the plenum flow is a margin), cp 1000 J/(kg K).
    """
    m = veh.motor
    loss_cu = op.motor_current**2 * m.r_hot
    loss_fe = m.i0_per_krpm * op.rpm / 1000 * op.bus_voltage * 0.9
    loss = loss_cu + loss_fe
    capacity = m.mass_kg * 520
    h_a = 18.0
    tau = capacity / h_a
    dt_motor = loss / h_a * (1 - math.exp(-full_power_s / tau))
    cells = veh.pack.series * veh.pack.parallel * veh.pack.cell.mass_kg
    r_cells = veh.pack.series * veh.pack.cell.dcir_ohm / veh.pack.parallel
    dt_pack = op.pack_current**2 * r_cells * full_power_s / (cells * 1000)
    eta_motor = op.shaft_power_per_rotor / (op.shaft_power_per_rotor + loss)
    return {"motor_loss_w": loss, "motor_eff": eta_motor, "dt_motor_k": dt_motor, "dt_pack_k": dt_pack}
