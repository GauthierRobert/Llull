/** Pure aero laws (13 FLT M4): table lookup, reverse flow, pivot command and servo step, load-validation bounds. */
import { describe, expect, it } from 'vitest';
import { flowFrame, type AeroSurface, type AeroTable, type ForwardAxis } from '@dynamics/flight/aeroModel';
import { assembleTable, lookupAero } from '@dynamics/flight/aeroTable';
import { AERO, AERO_SLOTS, initialAeroAux, pivotCommand, stepAero } from '@dynamics/flight/aeroBlock';
import { aeroOutput, compileAero } from '@dynamics/flight/aeroSurface';
import type { FlightScenario } from '@dynamics/flight/controlModel';

const table: AeroTable = {
  alphaDeg: [-2, 0, 4],
  pivotDeg: [0, 10],
  cl: [
    [-0.2, 0.6],
    [0, 0.8],
    [0.4, 1.2],
  ],
  cd: [
    [0.02, 0.03],
    [0.01, 0.02],
    [0.03, 0.04],
  ],
  cm: [
    [0, 0],
    [0, 0],
    [0, 0],
  ],
};
const surface = (servo: AeroSurface['servo'], t: AeroTable = table): AeroSurface => ({
  id: 'w',
  bodyId: 'b',
  momentCentre: [0, 0, 0],
  forward: '+x',
  refAreaM2: 2,
  refChordM: 1,
  refSpanM: 2,
  airDensity: 1.2,
  table: t,
  validAlphaDeg: [-2, 4],
  profileDrag: { cd0: 0.01, clMax: null, source: null },
  provenance: 'vlm+polar',
  unverified: true,
  servo,
  inputsHash: 'a',
  designHash: 'b',
  solver: { engine: 'ts', panels: 1, calls: 1 },
  defaulted: [],
});
const scenario = (setpoints: FlightScenario['setpoints']): FlightScenario => ({
  id: 's',
  bodyId: 'b',
  controllerId: null,
  durationS: 5,
  setpoints,
  initialVelocity: [0, 0, 0],
  initialAngularVelocity: [0, 0, 0],
  wind: { steady: [0, 0, 0], gusts: [] },
  settleBandM: 0.1,
  defaulted: [],
});
const still = { position: [0, 0, 0], orientation: [1, 0, 0, 0], angularVelocity: [0, 0, 0] } as const;

describe('flowFrame', () => {
  it('is right-handed with x against the travel direction and z up for each forward axis', () => {
    const expected = {
      '+x': [
        [-1, 0, 0],
        [0, -1, 0],
      ],
      '-x': [
        [1, 0, 0],
        [0, 1, 0],
      ],
      '+y': [
        [0, -1, 0],
        [1, 0, 0],
      ],
      '-y': [
        [0, 1, 0],
        [-1, 0, 0],
      ],
    } as const;
    for (const [forward, [x, y]] of Object.entries(expected)) {
      const frame = flowFrame(forward as ForwardAxis);
      const plain = (v: readonly number[]): number[] => v.map((c) => c + 0);
      expect({ x: plain(frame.x), y: plain(frame.y), z: plain(frame.z) }).toEqual({ x, y, z: [0, 0, 1] });
    }
  });
});

describe('lookupAero', () => {
  it('is exact on nodes, bilinear between them and flags both axes outside', () => {
    expect(lookupAero(table, 0, 0)).toEqual({ cl: 0, cd: 0.01, cm: 0, outside: false });
    expect(lookupAero(table, 2, 5).cl).toBeCloseTo((0 + 0.4) / 2 / 2 + (0.8 + 1.2) / 2 / 2, 12);
    expect(lookupAero(table, 4, 10)).toMatchObject({ cl: 1.2, outside: false });
    expect(lookupAero(table, 9, 0)).toMatchObject({ cl: 0.4, outside: true });
    expect(lookupAero(table, 0, 99)).toMatchObject({ cl: 0.8, outside: true });
    expect(lookupAero(table, -9, 0)).toMatchObject({ cl: -0.2, outside: true });
  });
  it('a one-column table ignores the pivot angle', () => {
    const flat: AeroTable = { ...table, pivotDeg: [0], cl: [[-0.2], [0], [0.4]], cd: [[1], [1], [1]], cm: [[0], [0], [0]] };
    expect(lookupAero(flat, 1, 30)).toMatchObject({ cl: 0.1, outside: false });
    expect(lookupAero(flat, 9, 0).outside).toBe(true);
  });
});

describe('assembleTable', () => {
  const rows = (cls: number[]): { alphaDeg: number; cl: number; cdi: number; cm: number }[] =>
    cls.map((cl, k) => ({ alphaDeg: -2 + 2 * k, cl, cdi: 0.001, cm: 0 }));
  it('keeps everything without a bound and only the run around zero lift with one', () => {
    const all = assembleTable([0], [rows([-0.2, 0, 0.2, 0.4])], 0.01, null);
    expect(all?.table.alphaDeg).toEqual([-2, 0, 2, 4]);
    expect(all?.droppedAlphaDeg).toEqual([]);
    expect(assembleTable([0], [rows([-0.5, -0.1, 0.1, 0.5])], 0.01, 0.2)?.table.alphaDeg).toEqual([0, 2]);
    // one stalled pivot column drops the angle for all
    expect(assembleTable([0, 1], [rows([-0.2, 0, 0.2, 0.4]), rows([-0.2, 0, 0.9, 0.4])], 0.01, 0.5)?.table.alphaDeg).toEqual([-2, 0]);
    expect(assembleTable([0], [rows([-0.5, 0.9, 0.1, 0.5])], 0.01, 0.2)).toBeNull();
    expect(assembleTable([0], [rows([-0.5, 0, 0.9, 0.5])], 0.01, 0.2)).toBeNull();
  });
});

describe('aeroOutput', () => {
  const runtime = compileAero(
    surface(null, { ...table, pivotDeg: [0], cl: [[-0.2], [0], [0.4]], cd: [[0.02], [0.01], [0.03]], cm: [[0], [0], [0]] }),
    [0, 0, 0],
    1,
  );
  it('gives no force and flags outside for flow from the downstream side (a body moving backwards), none at rest', () => {
    // forward +x: the flow frame x is -x_body; the body moving toward -x meets air coming from the downstream side
    const backwards = aeroOutput(runtime, { ...still, linearVelocity: [-20, 0, 0] }, 0);
    expect(backwards.force).toEqual([0, 0, 0]);
    expect(backwards.outside).toBe(true);
    expect(Math.abs(backwards.alphaDeg)).toBeGreaterThan(90);
    const forwards = aeroOutput(runtime, { ...still, linearVelocity: [20, 0, 0] }, 0);
    expect(forwards.outside).toBe(false);
    expect(aeroOutput(runtime, { ...still, linearVelocity: [0, 0, 0] }, 0)).toMatchObject({ liftN: 0, outside: false });
  });
});

describe('pivot command and servo step', () => {
  const sc = scenario([
    { t: 0, position: [0, 0, 0], yawDeg: 0, pivotDeg: { w: 4 } },
    { t: 1, position: [0, 0, 0], yawDeg: 0 },
    { t: 2, position: [0, 0, 0], yawDeg: 0, pivotDeg: { other: 9 } },
    { t: 3, position: [0, 0, 0], yawDeg: 0, pivotDeg: { w: -3 } },
  ]);
  it('holds the last command naming the surface and falls back when none does', () => {
    expect(pivotCommand(sc, 'w', 0, 7)).toBe(4);
    expect(pivotCommand(sc, 'w', 2.5, 7)).toBe(4);
    expect(pivotCommand(sc, 'w', 3, 7)).toBe(-3);
    expect(pivotCommand(scenario([{ t: 0, position: [0, 0, 0], yawDeg: 0 }]), 'w', 1, 7)).toBe(7);
  });
  it('starts clamped inside the limits, slews at the rate and skips a body without state', () => {
    const servo = { rateDegS: 2, minDeg: -5, maxDeg: 5, neutralDeg: 1 };
    const runtime = compileAero(surface(servo), [0, 0, 0], 1);
    const aux = new Float64Array(AERO_SLOTS);
    initialAeroAux([runtime], scenario([{ t: 0, position: [0, 0, 0], yawDeg: 0, pivotDeg: { w: 50 } }]), aux, 0);
    expect(aux[AERO.pivot]).toBe(5);
    const into = { forces: {}, moments: {} };
    stepAero([runtime], scenario([{ t: 0, position: [0, 0, 0], yawDeg: 0, pivotDeg: { w: -5 } }]), aux, 0, 0, 0.5, () => undefined, into);
    expect(aux[AERO.pivot]).toBeCloseTo(4, 12);
    expect(into.forces).toEqual({});
    const fixed = compileAero(surface(null), [0, 0, 0], 1);
    const auxFixed = new Float64Array(AERO_SLOTS);
    initialAeroAux([fixed], sc, auxFixed, 0);
    expect(auxFixed[AERO.pivot]).toBe(0);
  });
});
