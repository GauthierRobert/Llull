/**
 * Longitudinal rate damping by the tail-arm estimate (13 FLT M5b): the exact derivatives of a linear table (Nelson's C_mq = −2 η a_t V_H l_t / c̄),
 * the A-matrix increment in closed form, the vortex-lattice glider against its geometry, the modes with and without it, and the branches.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { AeroSurface, AeroTable } from '@dynamics/flight/aeroModel';
import { flightOf } from '@dynamics/flight/model';
import { prepareVehicle } from '@dynamics/flight/flightRun';
import { dampedDerivative, rateDampingTerms, type RateDampingTerm } from '@dynamics/flight/rateDamping';
import { stateDerivative, trimVehicle, type TrimVehicle } from '@dynamics/flight/trimModel';
import { expectNoOp } from '../../helpers/expectNoOp';
import { G, glider, quadDrone, step } from './flightFixture';

const SPEED = 20;
const RAD = Math.PI / 180;
/** Linear table: CL = a α + b δ, Cm = m0 + mα α − b (l / c̄) δ (rad), CD constant; c̄ = 1 m on the glider. */
const [A_SLOPE, B_SLOPE, ARM_CHORDS, M0, M_ALPHA] = [4.5, 0.8, 3, 0.05, -1];

function linearTable(b = B_SLOPE, arm = ARM_CHORDS): AeroTable {
  const alphaDeg = [-10, -5, 0, 5, 10, 15];
  const pivotDeg = [-8, 0, 8];
  const grid = (f: (alpha: number, delta: number) => number): number[][] => alphaDeg.map((a) => pivotDeg.map((d) => f(a * RAD, d * RAD)));
  return {
    alphaDeg,
    pivotDeg,
    cl: grid((a, d) => A_SLOPE * a + b * d),
    cd: grid(() => 0.03),
    cm: grid((a, d) => M0 + M_ALPHA * a - b * arm * d),
  };
}

/** The glider with its lattice table replaced by `table` (same reference: S 6 m², c̄ 1 m, b 6 m). */
function withTable(table: AeroTable): CadDocument {
  const doc = glider();
  const flight = flightOf(doc);
  const surface = flight.aeroSurfaces?.['w'] as AeroSurface;
  return { ...doc, flight: { ...flight, aeroSurfaces: { w: { ...surface, table } } } } as CadDocument;
}

interface Linear {
  a: number[][];
  modes: { label: string; re: number; im: number; periodS: number | null; dampingRatio: number | null; stability: string }[];
  warnings: string[];
  rateDamping: { method: string; terms: RateDampingTerm[] };
  trim: Record<string, unknown> & { angleOfAttackDeg: number };
}

const lin = (doc: CadDocument, params: Record<string, unknown> = {}): Linear => {
  const result = execute(doc, 'linearize_flight', { scenario: 's', airspeedMps: SPEED, freeFlightPath: true, ...params });
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as Linear;
};

/** The trim vehicle of `doc`'s scenario `s` (what the command linearises). */
function vehicleOf(doc: CadDocument): TrimVehicle {
  const scenario = flightOf(doc).scenarios?.['s'];
  if (scenario === undefined) throw new Error('no scenario');
  const prepared = prepareVehicle(doc, scenario, null, null, 0.0005);
  if ('code' in prepared) throw new Error(prepared.message);
  const vehicle = trimVehicle(prepared);
  if (vehicle === null) throw new Error('singular');
  return vehicle;
}

/** Period of the phugoid of the residualised longitudinal model (w, q quasi-steady: ẇ = q̇ = 0), s. */
function residualisedPhugoidPeriod(a: number[][]): number {
  const at = (i: number, j: number): number => a[i]?.[j] ?? 0;
  const [slow, fast] = [
    [0, 7],
    [2, 4],
  ];
  const [f00, f01, f10, f11] = [at(2, 2), at(2, 4), at(4, 2), at(4, 4)];
  const det = f00 * f11 - f01 * f10;
  const inverse = [
    [f11 / det, -f01 / det],
    [-f10 / det, f00 / det],
  ];
  const reduced = slow.map((i) =>
    slow.map(
      (j) =>
        at(i, j) -
        fast.reduce((sum, k, r) => sum + at(i, k) * fast.reduce((inner, l, c) => inner + (inverse[r]?.[c] ?? 0) * at(l, j), 0), 0),
    ),
  );
  const [[p, q], [r, s]] = reduced as [[number, number], [number, number]];
  const discriminant = (p - s) * (p - s) + 4 * q * r;
  return (2 * Math.PI) / (Math.sqrt(-discriminant) / 2);
}

describe('tail-arm rate damping: exact derivatives of a linear table (FLT-M5b)', () => {
  const doc = withTable(linearTable());
  const damped = lin(doc);
  const lumped = lin(doc, { rateDamping: 'none' });
  const [term] = damped.rateDamping.terms;

  it('recovers the tail arm and lift slope from the pivot derivatives; C_mq is Nelson -2 η a_t V_H l_t / c̄', () => {
    expect(damped.rateDamping.method).toBe('tail_arm');
    expect(term?.tailArmM).toBeCloseTo(ARM_CHORDS, 9);
    expect(term?.tailLiftSlopePerRad).toBeCloseTo(B_SLOPE, 9);
    expect(term?.liftSlopePerRad).toBeCloseTo(A_SLOPE, 9);
    // η a_t = 4.0 /rad on S_t / S = 0.2 gives CL_δ = 0.8; V_H = (S_t / S)(l_t / c̄) = 0.6
    const [etaAt, areaRatio] = [4, 0.2];
    const volume = areaRatio * ARM_CHORDS;
    expect(term?.cmq).toBeCloseTo(-2 * etaAt * volume * ARM_CHORDS, 9);
    expect(term?.clq).toBeCloseTo(2 * etaAt * volume, 9);
    // dε/dα = 2 CL_αw / (π A), A = 6, CL_αw from CL_α = CL_αw + CL_δ (1 − dε/dα)
    const aspect = 6;
    const wing = (A_SLOPE - B_SLOPE) / (1 - (2 * B_SLOPE) / (Math.PI * aspect));
    expect(term?.downwashSlope).toBeCloseTo((2 * wing) / (Math.PI * aspect), 9);
    expect(term?.cmAlphaDot).toBeCloseTo((term?.cmq ?? 0) * (term?.downwashSlope ?? 0), 12);
  });

  it('adds M_q + M_α̇ (and Z_q) to A in closed form and leaves the trim unchanged', () => {
    expect(damped.trim).toEqual(lumped.trim);
    const alpha = damped.trim.angleOfAttackDeg * RAD;
    const [u, w] = [SPEED * Math.cos(alpha), -SPEED * Math.sin(alpha)];
    const base = lumped.a;
    const alphaDotPerQ = (-u * (base[2]?.[4] ?? 0) + w * (base[0]?.[4] ?? 0)) / (SPEED * SPEED);
    const tailAlphaPerQ = (ARM_CHORDS / SPEED) * (-1 + (term?.downwashSlope ?? 0) * alphaDotPerQ);
    const qs = 0.5 * 1.225 * SPEED * SPEED * 6;
    const liftPerQ = qs * B_SLOPE * tailAlphaPerQ;
    const deltaQ = (damped.a[4]?.[4] ?? 0) - (base[4]?.[4] ?? 0);
    const deltaW = (damped.a[2]?.[4] ?? 0) - (base[2]?.[4] ?? 0);
    expect(Math.abs(deltaQ / ((ARM_CHORDS * Math.cos(alpha) * liftPerQ) / 70) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(deltaW / ((Math.cos(alpha) * liftPerQ) / 50) - 1)).toBeLessThan(1e-6);
    expect(deltaQ).toBeLessThan(0);
    expect(damped.warnings.join(' ')).toContain('tail-arm estimate');
  });

  it('rateDamping none linearises the lumped table alone and says the damping is absent', () => {
    expect(lumped.rateDamping).toEqual({ method: 'none', terms: [] });
    expect(lumped.warnings.join(' ')).toContain('rate damping (Mq, Zq, Malpha-dot) is absent');
  });
});

describe('tail-arm rate damping: the vortex-lattice glider (FLT-M5b)', () => {
  const damped = lin(glider());
  const lumped = lin(glider(), { rateDamping: 'none' });
  const [term] = damped.rateDamping.terms;

  it('the tail arm and lift slope from the lattice table match the geometry: quarter chord 2.925 m, Helmbold a_t S_t / S', () => {
    // tail leading edge 2.8 m behind the moment centre, chord 0.5 m; the induced wing load of a tail incidence pulls the arm forward a little
    expect(Math.abs((term?.tailArmM ?? 0) / 2.925 - 1)).toBeLessThan(0.1);
    // Helmbold lift slope of the AR 5 tail, 2πA / (2 + sqrt(A² + 4)), on S_t / S = 1.25 / 6 (η = 1)
    const helmbold = (2 * Math.PI * 5) / (2 + Math.sqrt(29));
    expect(Math.abs((term?.tailLiftSlopePerRad ?? 0) / ((helmbold * 1.25) / 6) - 1)).toBeLessThan(0.15);
    expect(term?.cmq).toBeLessThan(-5);
  });

  it('damps the short period and the phugoid; the phugoid period follows the residualised model, Lanchester only without the pitch damping', () => {
    const mode = (linear: Linear, label: string): Linear['modes'][number] | undefined =>
      linear.modes.find((entry) => entry.label === label);
    expect(mode(damped, 'short_period')?.dampingRatio ?? 0).toBeGreaterThan((mode(lumped, 'short_period')?.dampingRatio ?? 1) + 0.2);
    expect(mode(damped, 'phugoid')?.stability).toBe('stable');
    for (const linear of [damped, lumped])
      expect(Math.abs((mode(linear, 'phugoid')?.periodS ?? 0) / residualisedPhugoidPeriod(linear.a) - 1)).toBeLessThan(0.02);
    // the light wing loading makes Z_w M_q comparable to M_α, which lengthens the phugoid beyond sqrt(2) π V / g
    expect(mode(damped, 'phugoid')?.periodS ?? 0).toBeGreaterThan((1.2 * Math.SQRT2 * Math.PI * SPEED) / G);
  });

  it('is pure; the hover quad has no aero table, so no damping and no aero warning', () => {
    const doc = glider();
    const result = execute(doc, 'linearize_flight', { scenario: 's', airspeedMps: SPEED, freeFlightPath: true });
    expect(result.document).toBe(doc);
    const quad = step(quadDrone(), 'add_flight_controller', { body: 'frame', maxRpm: 8000, id: 'fc' }).doc;
    const flyable = step(quad, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 's', durationS: 1 }).doc;
    const hover = execute(flyable, 'linearize_flight', { scenario: 's' });
    expect((hover.data as Linear).rateDamping).toEqual({ method: 'none', terms: [] });
    const bad = execute(doc, 'linearize_flight', { scenario: 's', rateDamping: 'vlm' });
    expect(bad.summary).toContain('invalid params');
    expectNoOp(bad, doc);
  });
});

describe('rate damping helpers (FLT-M5b)', () => {
  const vehicle = vehicleOf(withTable(linearTable()));

  it('a surface without a servo or whose pivot carries no lift, a canard (arm ahead: no downwash) and a pivot at its travel limit', () => {
    const runtime = vehicle.aero[0];
    if (runtime === undefined) throw new Error('no surface');
    const withSurface = (surface: AeroSurface): TrimVehicle => ({ ...vehicle, aero: [{ ...runtime, surface }] });
    expect(rateDampingTerms(withSurface({ ...runtime.surface, servo: null }), [4], [0])).toEqual([]);
    // a pivot that carries no lift: no tail to estimate from
    expect(rateDampingTerms(withSurface({ ...runtime.surface, table: linearTable(0, 0) }), [4], [0])).toEqual([]);
    const [canard] = rateDampingTerms(withSurface({ ...runtime.surface, table: linearTable(B_SLOPE, -2) }), [4], [0]);
    expect(canard?.tailArmM).toBeCloseTo(-2, 9);
    expect(canard?.downwashSlope).toBe(0);
    expect(canard?.cmq).toBeLessThan(0);
    const [edge] = rateDampingTerms(vehicle, [4], [8]);
    expect(edge?.tailLiftSlopePerRad).toBeCloseTo(B_SLOPE, 9);
  });

  it('without terms the damped derivative is the airframe one; flow from behind adds nothing', () => {
    const x = [SPEED, 0, -1, 0, 0.1, 0, 0, 0.05];
    expect(dampedDerivative(vehicle, [], x, [0])).toEqual(stateDerivative(vehicle, x, [0]));
    const terms = rateDampingTerms(vehicle, [4], [0]);
    const reversed = [-SPEED, 0, 0, 0, 0.1, 0, 0, 0];
    expect(dampedDerivative(vehicle, terms, reversed, [0])).toEqual(stateDerivative(vehicle, reversed, [0]));
    expect(dampedDerivative(vehicle, terms, x, [0])).not.toEqual(stateDerivative(vehicle, x, [0]));
  });
});
