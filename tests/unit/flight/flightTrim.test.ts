/**
 * Trim and linearisation of the reference quad (13 FLT M5): the hover rotor speed against the closed form, symmetric solution, the open-loop
 * double integrator, forward flight, refusals and purity. No physics engine is needed.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { G, quadDrone, step } from './flightFixture';

const RHO = 1.225;
const D = 0.254;
const CT = 0.1158;
const K = (CT * RHO * D ** 4) / 3600;
const MASS = 1.115;

function flyable(maxRpm = 8000): CadDocument {
  let doc = step(quadDrone(MASS), 'add_flight_controller', { body: 'frame', maxRpm, id: 'fc' }).doc;
  doc = step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 's', durationS: 1 }).doc;
  return doc;
}

interface Control {
  id: string;
  value: number;
  atLimit: boolean;
}
interface Trim {
  attitude: { rollDeg: number; pitchDeg: number };
  controls: Control[];
  residual: { forceN: number[]; momentNm: number[]; relative: number };
  rotors: { thrustN: number }[];
  iterations: number;
  condition: { flightPathDeg: number };
}
interface Linear {
  a: number[][];
  b: number[][];
  eigenvalues: { re: number; im: number }[];
  modes: { label: string; stability: string }[];
  stable: boolean;
  trim: Trim;
}

const data = <T>(doc: CadDocument, command: string, params: Record<string, unknown>): T => {
  const result = execute(doc, command, params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as T;
};

describe('trim_flight: hover of the reference quad (FLT-M5)', () => {
  it('every rotor turns at sqrt(m g / (4 k)) rpm (closed form), level, with the residual at round-off', () => {
    const trim = data<Trim>(flyable(), 'trim_flight', { scenario: 's' });
    const expected = Math.sqrt((MASS * G) / (4 * K));
    expect(trim.controls).toHaveLength(4);
    for (const control of trim.controls) expect(control.value).toBeCloseTo(expected, 4);
    expect(Math.abs(trim.attitude.rollDeg)).toBeLessThan(1e-7);
    expect(Math.abs(trim.attitude.pitchDeg)).toBeLessThan(1e-7);
    for (const force of trim.residual.forceN) expect(Math.abs(force)).toBeLessThan(1e-7);
    for (const moment of trim.residual.momentNm) expect(Math.abs(moment)).toBeLessThan(1e-8);
    expect(trim.rotors.reduce((sum, rotor) => sum + rotor.thrustN, 0)).toBeCloseTo(MASS * G, 7);
  });

  it('forward flight at 8 m/s with body drag tilts the quad nose down and balances the drag (tan tilt = drag / weight)', () => {
    const drag = step(flyable(), 'set_body_drag', { body: 'frame', cdaM2: [0.01, 0.01, 0.02] }).doc;
    const trim = data<Trim>(drag, 'trim_flight', { scenario: 's', airspeedMps: 8 });
    const dragN = 0.5 * RHO * 0.01 * 8 * 8;
    expect(trim.attitude.pitchDeg).toBeLessThan(0);
    expect(Math.tan((-trim.attitude.pitchDeg * Math.PI) / 180)).toBeCloseTo(dragN / (MASS * G), 2);
    for (const force of trim.residual.forceN) expect(Math.abs(force)).toBeLessThan(1e-7);
  });

  it('a climb needs at least the level-flight thrust and keeps the stated flight-path angle', () => {
    const level = data<Trim>(flyable(), 'trim_flight', { scenario: 's' });
    const climb = data<Trim>(flyable(), 'trim_flight', { scenario: 's', airspeedMps: 2, flightPathDeg: 30 });
    expect(climb.condition.flightPathDeg).toBeCloseTo(30, 9);
    const total = (trim: Trim): number => trim.rotors.reduce((sum, rotor) => sum + rotor.thrustN, 0);
    expect(total(climb)).toBeGreaterThanOrEqual(total(level) - 1e-9);
  });

  it('a controller that cannot lift the weight is untrimmable: FLT_TRIM_SATURATED with the rotor at its limit', () => {
    const weak = flyable(4000);
    const result = execute(weak, 'trim_flight', { scenario: 's' });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FLT_TRIM_SATURATED');
    expect(result.summary).toContain('at its limit');
    expectNoOp(result, weak);
  });

  it('an unflyable condition with no control to move is FLT_TRIM_NOT_CONVERGED', () => {
    const doc = step(quadDrone(MASS), 'define_flight_scenario', { body: 'frame', id: 'open', durationS: 1 }).doc;
    const result = execute(doc, 'trim_flight', { scenario: 'open' });
    expect(result.error?.code).toBe('FLT_TRIM_NOT_CONVERGED');
    expectNoOp(result, doc);
  });

  it('is pure and deterministic; an unknown scenario and an invalid speed are named no-ops', () => {
    const doc = flyable();
    expectPure(doc, () => execute(doc, 'trim_flight', { scenario: 's', airspeedMps: 3 }));
    const first = execute(doc, 'trim_flight', { scenario: 's', airspeedMps: 3 });
    expect(JSON.stringify(execute(doc, 'trim_flight', { scenario: 's', airspeedMps: 3 }).data)).toBe(JSON.stringify(first.data));
    const unknown = execute(doc, 'trim_flight', { scenario: 'nope' });
    expect(unknown.error?.code).toBe('FLT_SCENARIO_UNKNOWN');
    expectNoOp(unknown, doc);
    expectNoOp(execute(doc, 'trim_flight', { scenario: 's', airspeedMps: -1 }), doc);
  });
});

describe('linearize_flight: hover of the reference quad (FLT-M5)', () => {
  const linear = data<Linear>(flyable(), 'linearize_flight', { scenario: 's' });

  it('the rate loop off leaves the double integrator: roll-dot = p, pitch-dot = -q (q is about +y), q-dot = 0, u-dot = -g pitch, v-dot = -g roll (analytic)', () => {
    const { a } = linear;
    const [u, v, w, p, q, r, roll, pitch] = [0, 1, 2, 3, 4, 5, 6, 7] as const;
    expect(a[pitch]?.[q]).toBeCloseTo(-1, 9);
    expect(a[roll]?.[p]).toBeCloseTo(1, 9);
    expect(a[u]?.[pitch]).toBeCloseTo(-G, 5);
    expect(a[v]?.[roll]).toBeCloseTo(-G, 5);
    for (const column of [u, v, w, p, q, r, roll, pitch]) {
      expect(Math.abs(a[q]?.[column] ?? 0)).toBeLessThan(1e-6);
      expect(Math.abs(a[p]?.[column] ?? 0)).toBeLessThan(1e-6);
    }
    expect(a[w]?.[w] ?? 1).toBeCloseTo(0, 6);
  });

  it('every eigenvalue is a (defective) zero, labelled with the hover modes, none growing', () => {
    for (const value of linear.eigenvalues) expect(Math.hypot(value.re, value.im)).toBeLessThan(0.05);
    expect(linear.modes.map((mode) => mode.label)).toEqual(expect.arrayContaining(['heave', 'yaw']));
    expect(linear.modes.every((mode) => mode.stability === 'neutral')).toBe(true);
  });

  it('B carries the rotor thrust: dw/drpm = 2 k rpm / m for every rotor, roll torques cancel in sum', () => {
    const rpm = Math.sqrt((MASS * G) / (4 * K));
    expect(linear.trim.controls).toHaveLength(4);
    linear.b[2]?.forEach((value) => expect(value).toBeCloseTo((2 * K * rpm) / MASS, 6));
    const roll = linear.b[3] ?? [];
    expect(roll.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 9);
    expect(Math.max(...roll.map(Math.abs))).toBeGreaterThan(0);
  });

  it('is pure and refuses what trim refuses', () => {
    const doc = flyable();
    expectPure(doc, () => execute(doc, 'linearize_flight', { scenario: 's' }));
    const weak = flyable(4000);
    const refused = execute(weak, 'linearize_flight', { scenario: 's' });
    expect(refused.error?.code).toBe('FLT_TRIM_SATURATED');
    expectNoOp(refused, weak);
  });
});

describe('trim_flight: conditions around the edges (FLT-M5)', () => {
  const hoverRpm = Math.sqrt((MASS * G) / (4 * K));

  /** The quad flying open loop: the rotors at the hover rpm of their own, no controller, so nothing is left to trim. */
  function openLoop(): CadDocument {
    const doc = step(quadDrone(MASS), 'define_flight_scenario', { body: 'frame', id: 'open', durationS: 1 }).doc;
    const rotors = Object.fromEntries(Object.entries(doc.flight?.rotors ?? {}).map(([id, rotor]) => [id, { ...rotor, rpm: hoverRpm }]));
    return { ...doc, flight: { ...doc.flight, rotors } } as CadDocument;
  }

  it('rotors already at the hover speed need no control: trimmed in zero iterations, a warning says only the attitude was solved, B has no columns', () => {
    const doc = openLoop();
    const trim = data<Trim & { warnings: string[] }>(doc, 'trim_flight', { scenario: 'open' });
    expect(trim.controls).toEqual([]);
    expect(trim.warnings.join(' ')).toContain('no controls');
    const linear = data<Linear>(doc, 'linearize_flight', { scenario: 'open' });
    expect(linear.b.every((row) => row.length === 0)).toBe(true);
    expect(linear.a[7]?.[4]).toBeCloseTo(-1, 9);
  });

  it('a scenario wind is ignored with a warning; a scenario naming a missing controller is FLT_MODEL_INVALID', () => {
    const windy = step(flyable(), 'define_flight_scenario', {
      body: 'frame',
      controller: 'fc',
      id: 'w',
      durationS: 1,
      wind: { steady: [3, 0, 0] },
    }).doc;
    expect(data<Trim & { warnings: string[] }>(windy, 'trim_flight', { scenario: 'w' }).warnings.join(' ')).toContain('wind');
    const doc = flyable();
    const broken = { ...doc, flight: { ...doc.flight, controllers: {} } } as CadDocument;
    const result = execute(broken, 'trim_flight', { scenario: 's' });
    expect(result.error?.code).toBe('FLT_MODEL_INVALID');
    expectNoOp(result, broken);
  });

  it('the mode set follows `modes`: a forced fixed_wing labelling of the hover quad uses the aircraft names', () => {
    const forced = data<Linear & { modeSet: string }>(flyable(), 'linearize_flight', { scenario: 's', modes: 'fixed_wing' });
    expect(forced.modeSet).toBe('fixed_wing');
    expect(forced.modes.map((mode) => mode.label)).not.toContain('heave');
    const auto = data<Linear & { modeSet: string }>(flyable(), 'linearize_flight', { scenario: 's' });
    expect(auto.modeSet).toBe('hover');
  });

  it('a thrust the controller cannot reach at the floor (minRpm above the hover speed) is saturated at the lower limit', () => {
    let doc = step(quadDrone(MASS), 'add_flight_controller', { body: 'frame', minRpm: 6000, maxRpm: 8000, id: 'fc' }).doc;
    doc = step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 's', durationS: 1 }).doc;
    const result = execute(doc, 'trim_flight', { scenario: 's' });
    expect(result.error?.code).toBe('FLT_TRIM_SATURATED');
    expectNoOp(result, doc);
  });
});
