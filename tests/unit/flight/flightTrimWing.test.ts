/**
 * Trim and linearisation of a glider with a vortex-lattice wing and a pivoting tail (13 FLT M4 + M5): the steady glide, the phugoid period against
 * Lanchester's sqrt(2) pi V / g, the short period faster than it, stable lateral modes, and the refusals of an aero vehicle.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { expectNoOp } from '../../helpers/expectNoOp';
import { airframe, G, step } from './flightFixture';

const SPEED = 20;
const MASS = 50;

function glider(forward = '+x'): CadDocument {
  const doc = airframe(MASS, [20, 70, 85], [0, 0, -G]);
  const wing = {
    name: 'wing',
    sections: [
      { leadingEdge: [100, 0, 0], chord: 1000 },
      { leadingEdge: [100, 3000, 0], chord: 1000 },
    ],
    spanwisePanels: 12,
    chordwisePanels: 4,
  };
  const tail = {
    name: 'tail',
    pivots: true,
    sections: [
      { leadingEdge: [-2800, 0, 0], chord: 500 },
      { leadingEdge: [-2800, 1250, 0], chord: 500 },
    ],
    spanwisePanels: 6,
    chordwisePanels: 3,
  };
  const table = step(doc, 'generate_aero_table', {
    body: 'frame',
    surfaces: [wing, tail],
    momentCentre: [0, 0, 0],
    id: 'w',
    forward,
    pivotsDeg: [-8, 0, 8],
    pivotPoint: [-2675, 0, 0],
    servo: { rateDegS: 60 },
    profileDrag: { cd0: 0.01, source: 'test polar' },
  }).doc;
  return step(table, 'define_flight_scenario', { body: 'frame', id: 's', durationS: 1 }).doc;
}

interface Mode {
  label: string;
  kind: string;
  re: number;
  im: number;
  periodS: number | null;
  dampingRatio: number | null;
  stability: string;
}
interface Linear {
  modes: Mode[];
  warnings: string[];
  modeSet: string;
  trim: {
    condition: { flightPathDeg: number };
    angleOfAttackDeg: number;
    controls: { id: string; value: number }[];
    aero: { liftN: number; dragN: number }[];
  };
}

const lin = (doc: CadDocument, params: Record<string, unknown> = {}): Linear => {
  const result = execute(doc, 'linearize_flight', { scenario: 's', airspeedMps: SPEED, freeFlightPath: true, ...params });
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as Linear;
};

describe('glider trim and modes (FLT-M5)', () => {
  const linear = lin(glider());

  it('trims a glide: weight balanced by lift and drag along the path, tail pivot inside its travel', () => {
    const flightPath = linear.trim.condition.flightPathDeg;
    expect(flightPath).toBeLessThan(0);
    expect(flightPath).toBeGreaterThan(-6);
    const [surface] = linear.trim.aero;
    expect(surface?.liftN).toBeCloseTo(MASS * G * Math.cos((flightPath * Math.PI) / 180), 3);
    expect(surface?.dragN).toBeCloseTo(-MASS * G * Math.sin((flightPath * Math.PI) / 180), 3);
    expect(Math.abs(linear.trim.controls[0]?.value ?? 99)).toBeLessThan(8);
  });

  it('the phugoid period is Lanchester sqrt(2) pi V / g within 10 % and the short period is much faster', () => {
    const lanchester = (Math.SQRT2 * Math.PI * SPEED) / G;
    const phugoid = linear.modes.find((mode) => mode.label === 'phugoid');
    const shortPeriod = linear.modes.find((mode) => mode.label === 'short_period');
    expect(phugoid?.periodS).toBeGreaterThan(0.9 * lanchester);
    expect(phugoid?.periodS).toBeLessThan(1.1 * lanchester);
    // the phugoid damping (about 1 / (sqrt(2) L/D) in theory) is read to the accuracy of the table slope: only its smallness is asserted
    expect(Math.abs(phugoid?.dampingRatio ?? 1)).toBeLessThan(0.1);
    expect(shortPeriod?.stability).toBe('stable');
    expect(shortPeriod?.dampingRatio).toBeGreaterThan(0.3);
    expect(shortPeriod?.periodS ?? Infinity).toBeLessThan((phugoid?.periodS ?? 0) / 5);
  });

  it('labels the lateral modes and says they are neutral by construction (no sideslip or rate derivatives in the aero tables)', () => {
    expect(linear.modeSet).toBe('fixed_wing');
    const labels = linear.modes.map((mode) => mode.label);
    expect(labels).toEqual(expect.arrayContaining(['phugoid', 'short_period', 'spiral', 'roll_subsidence']));
    for (const mode of linear.modes.filter((entry) => ['spiral', 'roll_subsidence', 'lateral_real'].includes(entry.label)))
      expect(mode.stability).toBe('neutral');
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

  it('an aero surface that travels along another axis is FLT_TRIM_UNSUPPORTED', () => {
    const doc = glider('-x');
    const result = execute(doc, 'trim_flight', { scenario: 's', airspeedMps: SPEED, freeFlightPath: true });
    expect(result.error?.code).toBe('FLT_TRIM_UNSUPPORTED');
    expectNoOp(result, doc);
  });
});
