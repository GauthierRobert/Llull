/**
 * Trim and linearisation of a glider with a vortex-lattice wing and a pivoting tail (13 FLT M4 + M5): the steady glide, the phugoid period against
 * Lanchester's sqrt(2) pi V / g, the short period faster than it, stable lateral modes, and the refusals of an aero vehicle.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { expectNoOp } from '../../helpers/expectNoOp';
import { G, glider } from './flightFixture';

const SPEED = 20;
const MASS = 50;

interface Mode {
  label: string;
  kind: string;
  re: number;
  im: number;
  periodS: number | null;
  dampingRatio: number | null;
  stability: string;
  participation: Record<string, number> | null;
  longitudinalShare: number;
  labelBasis: string;
}
interface Linear {
  a: number[][];
  modes: Mode[];
  warnings: string[];
  modeSet: string;
  trim: {
    condition: { flightPathDeg: number };
    attitude: { pitchDeg: number };
    angleOfAttackDeg: number;
    controls: { id: string; value: number }[];
    aero: { alphaDeg: number; liftN: number; dragN: number }[];
  };
}

const lin = (doc: CadDocument, params: Record<string, unknown> = {}): Linear => {
  const result = execute(doc, 'linearize_flight', { scenario: 's', airspeedMps: SPEED, freeFlightPath: true, ...params });
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as Linear;
};

describe('glider trim and modes (FLT-M5)', () => {
  const linear = lin(glider());
  const lumped = lin(glider(), { rateDamping: 'none' });

  it('trims a glide: weight balanced by lift and drag along the path, tail pivot inside its travel', () => {
    const flightPath = linear.trim.condition.flightPathDeg;
    expect(flightPath).toBeLessThan(0);
    expect(flightPath).toBeGreaterThan(-6);
    const [surface] = linear.trim.aero;
    expect(surface?.liftN).toBeCloseTo(MASS * G * Math.cos((flightPath * Math.PI) / 180), 3);
    expect(surface?.dragN).toBeCloseTo(-MASS * G * Math.sin((flightPath * Math.PI) / 180), 3);
    expect(Math.abs(linear.trim.controls[0]?.value ?? 99)).toBeLessThan(8);
  });

  it('reports the angle of attack with z up (= surface alpha = pitch - flight path); the path speed derivative is -2 D / (m V) within 1 %', () => {
    const { trim, a } = lumped;
    const alpha = (trim.angleOfAttackDeg * Math.PI) / 180;
    expect(trim.angleOfAttackDeg).toBeCloseTo(trim.aero[0]?.alphaDeg ?? Number.NaN, 6);
    expect(trim.angleOfAttackDeg).toBeCloseTo(trim.attitude.pitchDeg - trim.condition.flightPathDeg, 3);
    // body velocity (u, w) = V (cos alpha, -sin alpha) with z up: d(V-dot)/dV at constant alpha
    const du = Math.cos(alpha);
    const dw = -Math.sin(alpha);
    const accelerationU = (a[0]?.[0] ?? 0) * du + (a[0]?.[2] ?? 0) * dw;
    const accelerationW = (a[2]?.[0] ?? 0) * du + (a[2]?.[2] ?? 0) * dw;
    const pathXu = du * accelerationU + dw * accelerationW;
    const expected = (-2 * (trim.aero[0]?.dragN ?? Number.NaN)) / (MASS * SPEED);
    expect(Math.abs(pathXu / expected - 1)).toBeLessThan(0.01);
  });

  it('the lumped tables alone (rateDamping none): the phugoid period is Lanchester sqrt(2) pi V / g within 10 % and the short period is much faster', () => {
    const lanchester = (Math.SQRT2 * Math.PI * SPEED) / G;
    const phugoid = lumped.modes.find((mode) => mode.label === 'phugoid');
    const shortPeriod = lumped.modes.find((mode) => mode.label === 'short_period');
    expect(phugoid?.periodS).toBeGreaterThan(0.9 * lanchester);
    expect(phugoid?.periodS).toBeLessThan(1.1 * lanchester);
    // the phugoid damping (about 1 / (sqrt(2) L/D) in theory) is read to the accuracy of the table slope: only its smallness is asserted
    expect(Math.abs(phugoid?.dampingRatio ?? 1)).toBeLessThan(0.1);
    expect(shortPeriod?.stability).toBe('stable');
    expect(shortPeriod?.dampingRatio).toBeGreaterThan(0.3);
    expect(shortPeriod?.periodS ?? Infinity).toBeLessThan((phugoid?.periodS ?? 0) / 5);
  });

  it('labels the modes from their participation: the lateral roots are lateral_neutral (no sideslip or rate derivatives in the aero tables)', () => {
    expect(linear.modeSet).toBe('fixed_wing');
    const labels = linear.modes.map((mode) => mode.label);
    expect(labels.filter((label) => label === 'phugoid')).toHaveLength(1);
    expect(labels.filter((label) => label === 'short_period')).toHaveLength(1);
    const lateral = linear.modes.filter((mode) => mode.label === 'lateral_neutral');
    expect(lateral.length).toBeGreaterThan(0);
    expect(labels.every((label) => ['phugoid', 'short_period', 'lateral_neutral'].includes(label))).toBe(true);
    for (const mode of lateral) expect(mode.stability).toBe('neutral');
    // the participations that name them: speed + attitude for the phugoid, incidence + pitch rate for the short period
    const share = (label: string, states: readonly string[]): number =>
      states.reduce((sum, state) => sum + (linear.modes.find((mode) => mode.label === label)?.participation?.[state] ?? 0), 0);
    expect(share('phugoid', ['u', 'pitch'])).toBeGreaterThan(0.8);
    expect(share('short_period', ['w', 'q'])).toBeGreaterThan(0.9);
    expect(lumped.modes.map((mode) => mode.label).sort()).toEqual(labels.sort());
    expect(linear.warnings.join(' ')).toContain('FLT-D30');
  });
});

describe('glider refusals (FLT-M5)', () => {
  it('a level flight with no thrust cannot be balanced: FLT_TRIM_NOT_CONVERGED or SATURATED, never a result', () => {
    const doc = glider();
    const result = execute(doc, 'trim_flight', { scenario: 's', airspeedMps: SPEED, flightPathDeg: 0 });
    expect(result.rejected).toBe(true);
    expect(['FLT_TRIM_NOT_CONVERGED', 'FLT_TRIM_SATURATED']).toContain(result.error?.code);
    expectNoOp(result, doc);
  });

  it('a singular inertia from a loaded file (add_rigid_body refuses it, the file reader only checks 6 finite numbers) is FLT_MODEL_INVALID', () => {
    const json = JSON.parse(serializeDocument(glider())) as { document: { dynamics: { bodies: { frame: { inertiaKgM2: number[] } } } } };
    json.document.dynamics.bodies.frame.inertiaKgM2 = [0, 0, 0, 0, 0, 0];
    const doc = deserializeDocument(JSON.stringify(json));
    expect(doc.dynamics?.bodies['frame']?.inertiaKgM2).toEqual([0, 0, 0, 0, 0, 0]);
    for (const command of ['trim_flight', 'linearize_flight']) {
      const result = execute(doc, command, { scenario: 's', airspeedMps: SPEED, freeFlightPath: true });
      expect(result.error?.code).toBe('FLT_MODEL_INVALID');
      expect(result.summary).toContain('singular inertia');
      expectNoOp(result, doc);
    }
  });

  it('an aero surface that travels along another axis is FLT_TRIM_UNSUPPORTED', () => {
    const doc = glider('-x');
    const result = execute(doc, 'trim_flight', { scenario: 's', airspeedMps: SPEED, freeFlightPath: true });
    expect(result.error?.code).toBe('FLT_TRIM_UNSUPPORTED');
    expectNoOp(result, doc);
  });
});
