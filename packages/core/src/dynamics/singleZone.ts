/**
 * Single-zone cylinder pressure (FR-FPR-72, TR-FPR-16): first law for the trapped charge with a Wiebe heat release and Woschni wall heat
 * transfer, RK4 on the 0.1 deg grid, evaluated for one operating speed. Gas exchange (180..540 deg of a four-stroke cycle) is prescribed
 * at ambient / intake pressure like the Wiebe model. Heat release is given per cycle or per rpm; calibration to a brake target needs the
 * engine-loss model of a later slice and is not offered.
 *
 *   dp/dpsi = -k (p / V) dV/dpsi + ((k - 1) / V) (dQin/dpsi - dQloss/dpsi),   dQloss/dpsi = h A_w (T - T_w) / omega
 *   h = c1 B^-0.2 (p / kPa)^0.8 T^tempExponent w^0.8,   w = c2 S_p + c3 (V_d T_r / (p_r V_r)) (p - p_motored)
 */

import type { CylinderPressure } from '../model/dynamics';
import {
  STEP_DEG,
  burnFraction,
  cycleLength,
  finishCurve,
  gridIndex,
  volumeAt,
  type CurveRefusal,
  type CylinderGeometry,
  type PressureCurve,
} from './pressureCurve';
import { sliderRate } from './slider';

/** Heat-capacity ratio of the trapped charge (named, FR-FPR-72). */
const SPECIFIC_HEAT_RATIO = 1.35;
/** Speed (rpm) at which `burn.durationDeg` is given; the duration scales with (rpm / this)^rpmExponent [E-R12]. */
const BURN_REFERENCE_RPM = 3000;
/** Speeds below this are evaluated at this value (the heat-loss term divides by omega). */
const MIN_RPM = 100;

type SingleZoneModel = Extract<CylinderPressure['model'], { kind: 'single_zone' }>;

const RADIANS_PER_DEG = Math.PI / 180;

/** Heat released per cycle at `rpm` (J): the constant, or linear interpolation of the table clamped at its ends. */
function heatPerCycle(model: SingleZoneModel, rpm: number): number {
  if (model.heat.kind === 'per_cycle_J') return model.heat.value;
  const points = [...model.heat.points].sort((a, b) => a[0] - b[0]);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (rpm <= first[0]) return first[1];
  if (rpm >= last[0]) return last[1];
  const upper = points.findIndex((p) => p[0] >= rpm);
  const [a, b] = [points[upper - 1] ?? first, points[upper] ?? last];
  return a[1] + ((b[1] - a[1]) * (rpm - a[0])) / (b[0] - a[0]);
}

/** Wiebe parameters at `rpm`: duration scaled by speed, start from the CA50 phasing or the fixed spark angle. */
function burnAt(model: SingleZoneModel, rpm: number): { startDeg: number; durationDeg: number; a: number; m: number } {
  const { burn } = model;
  const durationDeg = burn.durationDeg * (Math.max(rpm, MIN_RPM) / BURN_REFERENCE_RPM) ** burn.rpmExponent;
  const startDeg = 'ca50Deg' in burn ? burn.ca50Deg - durationDeg * (Math.LN2 / burn.a) ** (1 / (burn.m + 1)) : burn.startDeg;
  return { startDeg, durationDeg, a: burn.a, m: burn.m };
}

export function singleZoneCurve(
  cylinder: CylinderPressure,
  geometry: CylinderGeometry,
  model: SingleZoneModel,
  rpm: number,
): PressureCurve | CurveRefusal {
  const cycleDeg = cycleLength(cylinder.cycle);
  const cells = Math.round(cycleDeg / STEP_DEG);
  const burn = burnAt(model, rpm);
  if (burn.startDeg < -180 || burn.startDeg + burn.durationDeg > 180)
    return {
      code: 'FPR_PRESSURE_MODEL_INVALID',
      error:
        `at ${Math.round(rpm)} rpm the burn runs ${burn.startDeg.toFixed(1)}..${(burn.startDeg + burn.durationDeg).toFixed(1)} deg, outside the ` +
        `compression-expansion stroke (-180..180): change ca50Deg / startDeg or durationDeg`,
    };
  const { woschni: w, intakePressurePa: pIn, intakeTempK: tIn } = model;
  const heat = heatPerCycle(model, rpm);
  const omega = (Math.max(rpm, MIN_RPM) * 2 * Math.PI) / 60;
  const boreM = cylinder.boreMm / 1000;
  const strokeM = geometry.displacementM3 / geometry.pistonAreaM2;
  const meanPistonSpeed = (2 * strokeM * Math.max(rpm, MIN_RPM)) / 60;
  const bdcVolume = volumeAt(geometry, 180);
  const area = geometry.pistonAreaM2;
  const volumeRate = (psi: number): number => area * sliderRate(geometry.slider, psi * RADIANS_PER_DEG) * RADIANS_PER_DEG;
  const slope = (psi: number, p: number): number => {
    const volume = volumeAt(geometry, psi);
    const temperature = (tIn * p * volume) / (pIn * bdcVolume);
    const motored = pIn * (bdcVolume / volume) ** SPECIFIC_HEAT_RATIO;
    const burning = psi >= burn.startDeg;
    const velocity =
      w.c2Closed * meanPistonSpeed + (burning ? w.c3 * ((geometry.displacementM3 * tIn) / (pIn * bdcVolume)) * (p - motored) : 0);
    const coefficient =
      w.c1 * boreM ** -0.2 * (Math.max(p, 1) / 1000) ** 0.8 * temperature ** w.tempExponent * Math.max(velocity, 0) ** 0.8;
    const wallArea = 2 * area + (Math.PI * boreM * volume) / area;
    const lossPerDeg = ((coefficient * wallArea * (temperature - w.wallTempK)) / omega) * RADIANS_PER_DEG;
    const released = heat * burnFraction(burn, psi).rate;
    return -SPECIFIC_HEAT_RATIO * ((p * volumeRate(psi)) / volume) + ((SPECIFIC_HEAT_RATIO - 1) / volume) * (released - lossPerDeg);
  };
  const absolute = new Float64Array(cells + 1);
  const gauge = new Float64Array(cells + 1);
  const ambient = cylinder.ambientPressurePa;
  let p = pIn;
  const closedSteps = Math.round(360 / STEP_DEG);
  for (let i = 0; i < cells; i++) {
    const psi = -180 + i * STEP_DEG;
    if (i <= closedSteps) {
      absolute[i] = p;
      const [k1, k2] = [slope(psi, p), slope(psi + STEP_DEG / 2, p + (STEP_DEG / 2) * slope(psi, p))];
      const k3 = slope(psi + STEP_DEG / 2, p + (STEP_DEG / 2) * k2);
      const k4 = slope(psi + STEP_DEG, p + STEP_DEG * k3);
      p += (STEP_DEG / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      if (!(p > 0) || !Number.isFinite(p))
        return {
          code: 'FPR_PRESSURE_MODEL_INVALID',
          error: `the single-zone integration left the physical range at ${psi.toFixed(1)} deg (check heat release and Woschni constants)`,
        };
    } else {
      absolute[i] = psi <= 360 + 1e-9 ? ambient : pIn;
    }
    gauge[gridIndex(psi, cycleDeg)] = (absolute[i] ?? 0) - ambient;
  }
  gauge[cells] = gauge[0] ?? 0;
  return finishCurve(gauge, geometry, ambient, cycleDeg, heat);
}

/** Woschni constants and burn-duration speed exponent applied when a call leaves them out; stored in the document and reported (FR-FPR-72). */
export const WOSCHNI_DEFAULTS = { c1: 3.26, c2Closed: 2.28, c2Exchange: 6.18, c3: 0.00324, tempExponent: -0.53, wallTempK: 450 } as const;
export const DEFAULT_RPM_EXPONENT = 0.2;
