/**
 * Aero surfaces in the flight run (13 FLT M4) on MuJoCo: the table force against the vortex-lattice query (VC-FLT-12), 1-cosine gust load factor,
 * pivot servo rate and limits, table range warning, stale tables, turbulence through run_flight, simulate_motion at the neutral pivot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import type { AeroSurface } from '@dynamics/flight/aeroModel';
import type { FlightMetrics } from '@dynamics/flight/flightMetrics';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { expectNoOp } from '../../helpers/expectNoOp';
import { airframe, flightData, G, step } from './flightFixture';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

const RHO = 1.225;
const S = 6;
const rel = (value: number, expected: number): number => Math.abs(value - expected) / Math.abs(expected);

/** A heavy free body (so its velocity hardly changes in a short run), zero gravity, carrying a 6 m x 1 m wing of the flow frame x = -x_body. */
function winged(massKg: number, extra: Record<string, unknown> = {}): CadDocument {
  const doc = airframe(massKg, [massKg, massKg, massKg], [0, 0, 0]);
  const wing = {
    name: 'wing',
    sections: [
      { leadingEdge: [250, 0, 0], chord: 1000 },
      { leadingEdge: [250, 3000, 0], chord: 1000 },
    ],
    spanwisePanels: 16,
    chordwisePanels: 4,
    ...(extra['pivots'] === true ? { pivots: true } : {}),
  };
  return step(doc, 'generate_aero_table', {
    body: 'frame',
    surfaces: [wing],
    momentCentre: [0, 0, 0],
    id: 'w',
    ...(extra['sweep'] === true ? { pivotsDeg: [-10, 10], pivotPoint: [250, 0, 0], servo: { rateDegS: 10 } } : {}),
  }).doc;
}

const surfaceOf = (doc: CadDocument): AeroSurface => doc.flight?.aeroSurfaces?.['w'] as AeroSurface;
const fly = (doc: CadDocument, scenario: Record<string, unknown>, params: Record<string, unknown> = {}): FlightMetrics => {
  const defined = step(doc, 'define_flight_scenario', { body: 'frame', id: 's', ...scenario }).doc;
  return flightData(defined, 'run_flight', { scenario: 's', ...params }) as unknown as FlightMetrics;
};
const clAt = (w: AeroSurface, alphaDeg: number, pivotIndex = 0): number =>
  w.table.cl[w.table.alphaDeg.indexOf(alphaDeg)]?.[pivotIndex] as number;

describe('aero surface in run_flight (FLT-M4)', () => {
  it('VC-FLT-12: the force of the table at alpha = 4° is ½ρV²S·CL of analyze_vortex_lattice at the same condition (1e-5)', () => {
    const doc = winged(1e5);
    const vz = -20 * Math.tan((4 * Math.PI) / 180);
    const metrics = fly(doc, { durationS: 0.0005, initialVelocity: [20, 0, vz] }, { timestep: 0.0005 });
    const direct = execute(doc, 'analyze_vortex_lattice', {
      surfaces: [
        {
          name: 'wing',
          sections: [
            { leadingEdge: [-250, 0, 0], chord: 1000 },
            { leadingEdge: [-250, 3000, 0], chord: 1000 },
          ],
          spanwisePanels: 16,
          chordwisePanels: 4,
        },
      ],
      alphasDeg: [4],
      referencePoint: [0, 0, 0],
    }).data as { polar: { cl: number }[]; reference: { area: number } };
    const q = 0.5 * RHO * (20 ** 2 + vz ** 2);
    expect(direct.reference.area).toBeCloseTo(6e6, 6);
    const lift = metrics.aero['w']?.finalLiftN as number;
    expect(rel(lift, q * S * (direct.polar[0]?.cl as number))).toBeLessThan(1e-5);
    expect(metrics.aero['w']?.alphaDeg.final).toBeCloseTo(4, 3);
    expect(metrics.aero['w']?.bodyId).toBe('frame');
    expect(metrics.aero['w']?.outsideFraction).toBe(0);
    expect(metrics.unverified).toBe(true);
    expect(metrics.defaulted).toContain('aero.w.profileDrag');
  });

  it('lift pushes the body up and drag slows it by the table numbers (quasi-steady, heavy body)', () => {
    const doc = winged(5e3);
    const w = surfaceOf(doc);
    const vz = -20 * Math.tan((4 * Math.PI) / 180);
    const metrics = fly(doc, { durationS: 0.2, initialVelocity: [20, 0, vz] }, { detail: 'series', sampleRate: 1000 });
    const series = (metrics as unknown as { series: { times: number[]; velocityMps: number[][] } }).series;
    const last = series.velocityMps.at(-1) as number[];
    const q = 0.5 * RHO * (20 ** 2 + vz ** 2);
    const alpha = (4 * Math.PI) / 180;
    const cd = w.table.cd[w.table.alphaDeg.indexOf(4)]?.[0] as number;
    const cl = clAt(w, 4);
    const t = series.times.at(-1) as number;
    // flow frame x = -x_body: drag acts along -x_body on a body moving +x; lift along +z
    expect(rel((last[2] as number) - vz, (q * S * (cd * Math.sin(alpha) + cl * Math.cos(alpha)) * t) / 5e3)).toBeLessThan(0.03);
    expect(rel(20 - (last[0] as number), (q * S * (cd * Math.cos(alpha) - cl * Math.sin(alpha)) * t) / 5e3)).toBeLessThan(0.03);
    expect(last[1]).toBeCloseTo(0, 9);
  });

  it('a 1-cosine vertical gust gives the peak load factor ρ·V·CLα·Ug / (2 W/S) at the gust midpoint (heavy body, within 3 %)', () => {
    const massKg = 2e4;
    const doc = winged(massKg);
    const w = surfaceOf(doc);
    const metrics = fly(doc, {
      durationS: 4,
      initialVelocity: [20, 0, 0],
      wind: { gusts: [{ startS: 1, durationS: 2, peak: [0, 0, 1] }] },
    });
    const slope = (clAt(w, 2) - clAt(w, -2)) / ((4 * Math.PI) / 180);
    const expected = (RHO * 20 * slope * 1) / (2 * ((massKg * G) / S));
    const measured = (metrics.aero['w']?.peakLiftN as number) / (massKg * G);
    expect(rel(measured, expected)).toBeLessThan(0.03);
    expect(metrics.aero['w']?.peakLiftTimeS).toBeCloseTo(2, 1);
    // no gust: no lift at zero alpha
    const calm = fly(doc, { durationS: 1, initialVelocity: [20, 0, 0] });
    expect(calm.aero['w']?.peakLiftN).toBeLessThan(1e-6);
  });

  it('a steady updraft equals the same alpha by body velocity (the wind enters the relative flow)', () => {
    const doc = winged(1e5);
    const vz = -20 * Math.tan((4 * Math.PI) / 180);
    const byVelocity = fly(doc, { durationS: 0.0005, initialVelocity: [20, 0, vz] }, { timestep: 0.0005 });
    const byWind = fly(doc, { durationS: 0.0005, initialVelocity: [20, 0, 0], wind: { steady: [0, 0, -vz] } }, { timestep: 0.0005 });
    expect(rel(byWind.aero['w']?.finalLiftN as number, byVelocity.aero['w']?.finalLiftN as number)).toBeLessThan(1e-6);
    expect(byWind.aero['w']?.alphaDeg.final).toBeCloseTo(4, 3);
  });

  it('warns and holds the coefficients at the table edge outside the table, and counts the steps', () => {
    const doc = winged(1e5);
    const w = surfaceOf(doc);
    const vz = -20 * Math.tan((15 * Math.PI) / 180);
    const metrics = fly(doc, { durationS: 0.0005, initialVelocity: [20, 0, vz] }, { timestep: 0.0005 });
    const surface = metrics.aero['w'];
    expect(surface?.outsideFraction).toBe(1);
    expect(metrics.warnings.join(' ')).toContain("FLT_AERO_OUTSIDE_TABLE: surface 'w' flew at α");
    const q = 0.5 * RHO * (20 ** 2 + vz ** 2);
    expect(rel(surface?.finalLiftN as number, q * S * clAt(w, 10))).toBeLessThan(1e-5);
    expect(surface?.validAlphaDeg).toEqual([-10, 10]);
  });

  it('flags a table made on another design of the body as stale (FLT_AERO_TABLE_STALE, unverified) and a fresh one with a stated polar as verified', () => {
    const doc = step(winged(1e5), 'generate_aero_table', {
      body: 'frame',
      surfaces: [
        {
          name: 'wing',
          sections: [
            { leadingEdge: [250, 0, 0], chord: 1000 },
            { leadingEdge: [250, 3000, 0], chord: 1000 },
          ],
        },
      ],
      momentCentre: [0, 0, 0],
      id: 'sourced',
      profileDrag: { cd0: 0.01, source: 'test polar' },
    }).doc;
    const scenario = { durationS: 0.01, initialVelocity: [20, 0, 0], settleBandM: 0.1 };
    const without = execute(doc, 'delete_dynamics_item', { id: 'w' }).document;
    const fresh = fly(without, scenario);
    expect(fresh.unverified).toBe(false);
    expect(fresh.aero['sourced']?.stale).toBe(false);
    expect(fresh.warnings).toEqual([]);
    const entity = doc.dynamics?.bodies['frame']?.entityIds[0] as string;
    const moved = execute(without, 'move_entities', { ids: [entity], delta: [5, 0, 0] }).document;
    const stale = fly(moved, scenario);
    expect(stale.aero['sourced']).toMatchObject({ stale: true, unverified: true });
    expect(stale.unverified).toBe(true);
    expect(stale.defaulted).toContain('aero.sourced.stale');
    expect(stale.warnings.join(' ')).toContain("FLT_AERO_TABLE_STALE: the body 'frame'");
  });

  it('the pivot servo slews at its rate limit toward the scenario command, starts at the t = 0 command and holds', () => {
    const doc = winged(1e5, { pivots: true, sweep: true });
    const setpoints = [
      { t: 0, pivotDeg: { w: -10 } },
      { t: 0.5, pivotDeg: { w: 10 } },
    ];
    const at = (durationS: number): number =>
      fly(doc, { durationS, setpoints, initialVelocity: [20, 0, 0] }).aero['w']?.pivotDeg.final as number;
    expect(at(1)).toBeCloseTo(-5, 1);
    expect(at(1.5)).toBeCloseTo(0, 1);
    expect(at(3)).toBeCloseTo(10, 6);
    // starts at the t = 0 command and holds it until the next set-point
    const held = fly(doc, { durationS: 0.4, setpoints: [{ t: 0, pivotDeg: { w: -10 } }], initialVelocity: [20, 0, 0] });
    expect(held.aero['w']?.pivotDeg.final).toBeCloseTo(-10, 9);
  });

  it('the pivot angle is in the table lookup: lift at alpha = 0 follows the table column of the pivot angle, and a hand-edited command is clamped to the servo limits', () => {
    const doc = winged(1e5, { pivots: true, sweep: true });
    const w = surfaceOf(doc);
    const lift = (command: number): number =>
      fly(doc, { durationS: 0.0005, setpoints: [{ t: 0, pivotDeg: { w: command } }], initialVelocity: [20, 0, 0] }, { timestep: 0.0005 })
        .aero['w']?.finalLiftN as number;
    const q = 0.5 * RHO * 400;
    expect(rel(lift(10), q * S * clAt(w, 0, 1))).toBeLessThan(1e-3);
    expect(rel(lift(-10), q * S * clAt(w, 0, 0))).toBeLessThan(1e-3);
    expect(lift(10)).toBeGreaterThan(0);
    expect(lift(-10)).toBeLessThan(0);
    // a document edited past the servo limits: the run holds the limit
    const edited = step(doc, 'define_flight_scenario', {
      body: 'frame',
      id: 's',
      durationS: 0.01,
      setpoints: [{ t: 0, pivotDeg: { w: 5 } }],
    }).doc;
    const flight = edited.flight!;
    const scenario = flight.scenarios!['s']!;
    const beyond = {
      ...edited,
      flight: { ...flight, scenarios: { s: { ...scenario, setpoints: [{ ...scenario.setpoints[0]!, pivotDeg: { w: 45 } }] } } },
    };
    const held = flightData(beyond, 'run_flight', { scenario: 's' }) as unknown as FlightMetrics;
    expect(held.aero['w']?.pivotDeg.final).toBeLessThanOrEqual(10);
    expect(held.aero['w']?.pivotDeg.final).toBeGreaterThan(9.9);
  });

  it('turbulence in a scenario is deterministic through run_flight and shows in the wind series', () => {
    const doc = winged(1e5);
    const scenario = {
      durationS: 2,
      initialVelocity: [20, 0, 0],
      wind: { turbulence: { sigmaMps: [1, 1, 1], airspeedMps: 20, lengthScaleM: [50, 50, 50], seed: 99 } },
    };
    const run = (seed: number): FlightMetrics =>
      fly(doc, { ...scenario, wind: { turbulence: { ...scenario.wind.turbulence, seed } } }, { detail: 'series', sampleRate: 200 });
    const a = run(99);
    expect(run(99)).toEqual(a);
    expect(run(100)).not.toEqual(a);
    const series = (a as unknown as { series: { windMps: number[][] } }).series;
    expect(series.windMps.some((row) => row.some((value) => Math.abs(value) > 0.1))).toBe(true);
    expect(a.aero['w']?.alphaDeg.max).toBeGreaterThan(a.aero['w']?.alphaDeg.min as number);
  });

  it('a steady crosswind drifts a drag body along the analytic ground track x(t) = w·t − ln(1 + k·w·t) / k', () => {
    const massKg = 2;
    const cda = 0.5;
    let doc = airframe(massKg, [0.1, 0.1, 0.1], [0, 0, 0]);
    doc = step(doc, 'set_body_drag', { body: 'frame', cdaM2: [cda, cda, cda] }).doc;
    const wind = 6;
    const defined = step(doc, 'define_flight_scenario', { body: 'frame', id: 's', durationS: 3, wind: { steady: [0, wind, 0] } }).doc;
    const flown = flightData(defined, 'run_flight', { scenario: 's', detail: 'series', sampleRate: 100 }) as unknown as {
      series: { times: number[]; positionM: number[][] };
    };
    const k = (0.5 * RHO * cda) / massKg;
    const track = (t: number): number => wind * t - Math.log(1 + k * wind * t) / k;
    flown.series.times.forEach((t, i) => {
      if (t < 0.5) return;
      const y = flown.series.positionM[i]?.[1] as number;
      expect(rel(y, track(t))).toBeLessThan(5e-3);
      expect(Math.abs(flown.series.positionM[i]?.[0] as number)).toBeLessThan(1e-9);
    });
    expect(track(3)).toBeGreaterThan(9);
  });
});

describe('aero surface in simulate_motion (neutral pivot) and other commands', () => {
  it('simulate_motion applies the table force with the servo at its neutral angle', () => {
    const doc = winged(2e4, { pivots: true, sweep: true });
    const moving = step(doc, 'define_flight_scenario', { body: 'frame', id: 's', durationS: 0.2, initialVelocity: [20, 0, -1.4] }).doc;
    const result = execute(moving, 'simulate_motion', { duration: 0.2, detail: 'poses' });
    expect(result.summary).not.toContain('refused');
    expect(result.data).toBeDefined();
  });

  it('inspect_dynamics lists the aero surfaces', () => {
    const doc = winged(10);
    const listing = execute(doc, 'inspect_dynamics', {});
    expect(JSON.stringify(listing.data)).toContain('"w"');
    expectNoOp(execute(doc, 'generate_aero_table', { body: 'frame' }), doc);
  });
});
