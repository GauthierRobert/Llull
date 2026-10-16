/**
 * Pressure models of a cylinder (TR-FPR §5.4): `table` (periodic gauge-pressure table), `wiebe` (polytropic compression and expansion with
 * a Wiebe heat release, exact linear calibration to an IMEP) and `single_zone` (heat loss, `singleZone.ts`). Each gives a `PressureCurve`.
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
import { singleZoneCurve } from './singleZone';
import { sliderRate } from './slider';

const RADIANS_PER_DEG = Math.PI / 180;

/** The problem with a pressure model's own numbers (independent of the geometry), or null. */
export function modelProblem(cylinder: CylinderPressure): string | null {
  const { model } = cylinder;
  if (Math.abs(cylinder.firingOffsetDeg - 360 * Math.round(cylinder.firingOffsetDeg / 360)) > 1e-9)
    return 'firingOffsetDeg must put the firing TDC on a TDC crossing of this piston: 0 or 360 (a multiple of 360)';
  if (model.kind === 'table') return null;
  const burn = model.kind === 'wiebe' ? model : model.burn;
  const start = 'startDeg' in burn ? burn.startDeg : null;
  if (start !== null && (start < -180 || start + burn.durationDeg > 180))
    return `combustion must lie inside the compression-expansion stroke: startDeg >= -180 and startDeg + durationDeg <= 180 (got ${start} + ${burn.durationDeg})`;
  if (model.kind === 'wiebe' && (model.compressionIndex <= 1 || model.expansionIndex <= 1))
    return 'compressionIndex and expansionIndex must be > 1';
  return null;
}

/** Table: gauge pressure by linear interpolation of `points` (cycle deg, Pa), which must cover 0 .. cycle. */
function tableCurve(
  cylinder: CylinderPressure,
  geometry: CylinderGeometry,
  points: readonly (readonly [number, number])[],
): PressureCurve | CurveRefusal {
  const cycleDeg = cycleLength(cylinder.cycle);
  const gap = tableCoverageProblem(points, cylinder.cycle);
  if (gap !== null) return { code: 'FPR_PRESSURE_TABLE_GAP', error: gap };
  const sorted = [...points].sort((x, y) => x[0] - y[0]);
  const cells = Math.round(cycleDeg / STEP_DEG);
  const gauge = new Float64Array(cells + 1);
  let segment = 0;
  for (let k = 0; k <= cells; k++) {
    const phi = k * STEP_DEG;
    while (segment < sorted.length - 2 && phi > (sorted[segment + 1]?.[0] ?? Infinity)) segment++;
    const [a, b] = [sorted[segment], sorted[segment + 1]];
    if (a === undefined || b === undefined) continue;
    gauge[k] = a[1] + ((b[1] - a[1]) * (phi - a[0])) / (b[0] - a[0]);
  }
  return finishCurve(gauge, geometry, cylinder.ambientPressurePa, cycleDeg, null);
}

type WiebeModel = Extract<CylinderPressure['model'], { kind: 'wiebe' }>;

/** Absolute pressure grids (indexed by cycle angle) of the motored loop and of the unit-heat contribution. */
function wiebeGrids(
  cylinder: CylinderPressure,
  geometry: CylinderGeometry,
  model: WiebeModel,
): { motored: Float64Array; perJoule: Float64Array } {
  const cycleDeg = cycleLength(cylinder.cycle);
  const cells = Math.round(cycleDeg / STEP_DEG);
  const ambient = cylinder.ambientPressurePa;
  const [pIn, nc, ne] = [model.intakePressurePa, model.compressionIndex, model.expansionIndex];
  const bdcVolume = volumeAt(geometry, 180);
  const end = model.startDeg + model.durationDeg;
  const endVolume = volumeAt(geometry, end);
  const volumeRate = (psi: number): number => geometry.pistonAreaM2 * sliderRate(geometry.slider, psi * RADIANS_PER_DEG) * RADIANS_PER_DEG;
  const burn = { startDeg: model.startDeg, durationDeg: model.durationDeg, a: model.a, m: model.m };
  // g' = [(gamma - 1) x_b' - gamma g V'] / V, g(start) = 0, per degree; RK4 from the start to the end of the burn
  const slope = (psi: number, g: number): number =>
    ((nc - 1) * burnFraction(burn, psi).rate - nc * g * volumeRate(psi)) / volumeAt(geometry, psi);
  const atNode = new Map<number, number>();
  let [psi, g] = [model.startDeg, 0];
  while (psi < end - 1e-9) {
    const nextNode = Math.floor((psi + 180) / STEP_DEG + 1e-9) + 1;
    const next = Math.min(-180 + nextNode * STEP_DEG, end);
    const h = next - psi;
    const [k1, k2] = [slope(psi, g), slope(psi + h / 2, g + (h / 2) * slope(psi, g))];
    const k3 = slope(psi + h / 2, g + (h / 2) * k2);
    const k4 = slope(psi + h, g + h * k3);
    g += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    psi = next;
    if (Math.abs(psi - (-180 + nextNode * STEP_DEG)) < 1e-9) atNode.set(nextNode, g);
  }
  const gEnd = g;
  const pEndMotored = pIn * (bdcVolume / endVolume) ** nc;
  const motored = new Float64Array(cells + 1);
  const perJoule = new Float64Array(cells + 1);
  for (let i = 0; i < cells; i++) {
    const psiDeg = -180 + i * STEP_DEG;
    const index = gridIndex(psiDeg, cycleDeg);
    const volume = volumeAt(geometry, psiDeg);
    if (psiDeg <= 180 + 1e-9) {
      if (psiDeg <= end + 1e-9) {
        motored[index] = pIn * (bdcVolume / volume) ** nc;
        perJoule[index] = psiDeg <= model.startDeg ? 0 : (atNode.get(i) ?? gEnd);
      } else {
        motored[index] = pEndMotored * (endVolume / volume) ** ne;
        perJoule[index] = gEnd * (endVolume / volume) ** ne;
      }
    } else {
      motored[index] = psiDeg <= 360 + 1e-9 ? ambient : pIn;
    }
  }
  return { motored, perJoule };
}

/** Subtract `offset` from every element and close the periodic grid. */
function closeGrid(values: Float64Array, offset: number): Float64Array {
  const out = values.map((v) => v - offset);
  out[out.length - 1] = out[0] ?? 0;
  return out;
}

function wiebeCurve(cylinder: CylinderPressure, geometry: CylinderGeometry, model: WiebeModel): PressureCurve | CurveRefusal {
  const cycleDeg = cycleLength(cylinder.cycle);
  const ambient = cylinder.ambientPressurePa;
  const { motored, perJoule } = wiebeGrids(cylinder, geometry, model);
  const motoredGauge = closeGrid(motored, ambient);
  const heatGauge = closeGrid(perJoule, 0);
  const motoredWork = finishCurve(motoredGauge, geometry, ambient, cycleDeg, null).workJ;
  const heatWork = finishCurve(heatGauge, geometry, ambient, cycleDeg, null).workJ;
  const heat = model.heat;
  const joules = heat.kind === 'per_cycle_J' ? heat.value : (heat.value * geometry.displacementM3 - motoredWork) / heatWork;
  if (!(joules >= 0))
    return {
      code: 'FPR_IMEP_UNREACHABLE',
      error:
        `target IMEP ${(heat.value / 1e5).toPrecision(4)} bar is below the motored loop of this cylinder ` +
        `(${(motoredWork / geometry.displacementM3 / 1e5).toPrecision(4)} bar with these indices and intake pressure): raise the target or change the indices`,
    };
  const gauge = motoredGauge.map((p, k) => p + joules * (heatGauge[k] ?? 0));
  return finishCurve(gauge, geometry, ambient, cycleDeg, joules);
}

/** The pressure curve of `cylinder` on `geometry`; `rpm` matters only for single_zone (heat loss and burn scaling). */
export function pressureCurve(cylinder: CylinderPressure, geometry: CylinderGeometry, rpm: number): PressureCurve | CurveRefusal {
  const { model } = cylinder;
  if (model.kind === 'table') return tableCurve(cylinder, geometry, model.points);
  if (model.kind === 'wiebe') return wiebeCurve(cylinder, geometry, model);
  return singleZoneCurve(cylinder, geometry, model, rpm);
}

/** The problem with the coverage of a pressure table for `cycle`, or null (FPR_PRESSURE_TABLE_GAP). */
export function tableCoverageProblem(points: readonly (readonly [number, number])[], cycle: CylinderPressure['cycle']): string | null {
  const cycleDeg = cycleLength(cycle);
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const first = sorted[0]?.[0] ?? Infinity;
  const last = sorted[sorted.length - 1]?.[0] ?? -Infinity;
  if (first > 1e-9 || last < cycleDeg - 1e-9 || sorted.some((p, i) => i > 0 && p[0] <= (sorted[i - 1]?.[0] ?? -Infinity)))
    return `the pressure table covers ${first}..${last} deg; a ${cycle} cycle needs strictly increasing angles from 0 to ${cycleDeg}`;
  return null;
}
