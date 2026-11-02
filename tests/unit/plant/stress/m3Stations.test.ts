/**
 * PST-M3 interior stations: an inclined span (30 degrees in plan, 20 in elevation) whose two bending planes peak at different points has the maximum of
 * the resultant moment between the component extrema and inside the ends. The element end forces are built by hand from equilibrium, so the station
 * formulas are tested against an independent scan of the resultant moment. (Supports that carry no end moment cannot be built from the restraints a
 * model offers: a pinned span rolls about its axis, so the hand-built forces are the oracle.)
 */

import { describe, expect, it } from 'vitest';
import { localAxes } from '@lib/frame3d/element';
import { codeStresses } from '@aec/plant/stress/code/codeStress';
import { ruleSetOf } from '@aec/plant/stress/code/ruleSets';
import type { BuiltModel } from '@aec/plant/stress/model/build';
import type { OperatingConditions } from '@aec/plant/stress/model/schema';
import type { CaseState } from '@aec/plant/stress/solve/run';
import { DN100 } from './m3Fixtures';

const LENGTH = 6000;
const DEG = Math.PI / 180;
/** Local uniform load (N/mm) perpendicular to the axis, in both bending planes. */
const WY = 0.4;
const WZ = 0.4;
/** Moments of the two bending planes at the ends a and b (N.mm, station-formula sign). */
const MZ_A = 2e6;
const MZ_B = -2e6;
const MY_A = -1e6;
const MY_B = 1e6;
const VY = (MZ_B - MZ_A) / LENGTH - (LENGTH * WY) / 2;
const VZ = -(MY_B - MY_A) / LENGTH - (LENGTH * WZ) / 2;

const conditions: OperatingConditions = {
  installTempC: 20,
  temperatures: [],
  pressures: [],
  fluidDensityKgM3: 0,
  corrosionAllowanceMm: 0,
  cycles: 7000,
  poissonPressure: false,
  material: {
    youngsModulusMPa: 200000,
    poisson: 0.3,
    densityKgM3: 7850,
    thermal: { meanCtePerK: 1.2e-5 },
    ShMPa: 138,
    ScMPa: 138,
    ferrousLowStrength: false,
  },
  defaulted: [],
};

function span(): { built: BuiltModel; state: CaseState } {
  const axis = [Math.cos(20 * DEG) * Math.cos(30 * DEG), Math.cos(20 * DEG) * Math.sin(30 * DEG), Math.sin(20 * DEG)] as const;
  const nodes = [
    [0, 0, 0],
    [axis[0] * LENGTH, axis[1] * LENGTH, axis[2] * LENGTH],
  ] as const;
  const frame = localAxes([0, 0, 0], nodes[1]);
  if (frame === null) throw new Error('no axes');
  const R = frame.rotation;
  const local = [0, WY, WZ];
  const uniform = Float64Array.from([0, 1, 2].map((k) => local.reduce((sum, value, r) => sum + (R[r * 3 + k] as number) * value, 0)));
  // end forces applied by the nodes: no tension, no torque, the moments above
  const elementForces = Float64Array.from([0, VY, VZ, 0, -MY_A, -MZ_A, 0, 0, 0, 0, 0, 0]);
  const built = {
    layout: { nodes, elements: [{ id: 'E1', a: 0, b: 1, pipeId: 'p', kind: 'straight', odMm: DN100.odMm, wallMm: DN100.wallMm }] },
    set: ruleSetOf('B31.3-2018'),
  } as unknown as BuiltModel;
  const state: CaseState = {
    name: 'SUS',
    type: 'SUS',
    displacements: new Float64Array(12),
    reactions: new Float64Array(12),
    elementForces,
    uniform,
    pressureBar: 0,
    maxTempC: null,
    residual: 0,
    iterations: 1,
    contacts: [],
  };
  return { built, state };
}

describe('interior maximum of the resultant moment', () => {
  const { built, state } = span();
  const rows = codeStresses({ built, conditions, states: [state] }).rows;
  const inner = DN100.odMm - 2 * DN100.wallMm;
  const Z = ((Math.PI / 32) * (DN100.odMm ** 4 - inner ** 4)) / DN100.odMm;
  // independent scan of |M(x)| from the closed forms of the two planes
  const my = (x: number): number => MY_A + ((MY_B - MY_A) * x) / LENGTH + (WZ * x * (LENGTH - x)) / 2;
  const mz = (x: number): number => MZ_A + ((MZ_B - MZ_A) * x) / LENGTH - (WY * x * (LENGTH - x)) / 2;
  let scanMax = 0;
  let scanAt = 0;
  for (let i = 0; i <= 60000; i++) {
    const x = (LENGTH * i) / 60000;
    const m = Math.hypot(my(x), mz(x));
    if (m > scanMax) [scanMax, scanAt] = [m, x];
  }

  it('the maximum is interior and exceeds the resultant at each plane own peak by more than 5 %', () => {
    expect(scanAt).toBeGreaterThan(1000);
    expect(scanAt).toBeLessThan(5000);
    const peakY = LENGTH / 2 + (MZ_B - MZ_A) / (WY * LENGTH);
    const peakZ = LENGTH / 2 - (MY_B - MY_A) / (WZ * LENGTH);
    const componentPeaks = [peakY, peakZ].map((x) => Math.hypot(my(x), mz(x)));
    expect(scanMax / Math.max(...componentPeaks)).toBeGreaterThan(1.05);
  });

  it('the interior station reports the maximum of the resultant moment to 1e-3 (S_L = M / Z) and it governs over both ends', () => {
    const best = Math.max(...rows.filter((row) => row.node === null).map((row) => row.stressMPa));
    expect(Math.abs(best / (scanMax / Z) - 1)).toBeLessThan(1e-3);
    const ends = rows.filter((row) => row.node !== null).map((row) => row.stressMPa);
    expect(best).toBeGreaterThan(Math.max(...ends));
  });
});
