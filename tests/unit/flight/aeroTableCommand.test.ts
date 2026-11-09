/** generate_aero_table (13 FLT M4): the vortex-lattice sweep stored as document data, the lift-slope oracle, the polar, pivots, refusals, load validation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { generateAeroTable } from '@dynamics/commands/flightAero';
import { flightDocument } from '@dynamics/flight/document';
import type { AeroSurface } from '@dynamics/flight/aeroModel';
import { expectNoOp } from '../../helpers/expectNoOp';
import { airframe, G, step } from './flightFixture';

const vehicle = (): CadDocument => airframe(2, [0.1, 0.1, 0.1], [0, 0, -G]);

/** Half wing root to tip, document units mm (mirrored about y = 0): leading edge at x = `x`, constant chord. */
const rectangle = (spanMm: number, chordMm: number, x = -250, panels = 16): Record<string, unknown> => ({
  name: 'wing',
  sections: [
    { leadingEdge: [x, 0, 0], chord: chordMm },
    { leadingEdge: [x, spanMm / 2, 0], chord: chordMm },
  ],
  spanwisePanels: panels,
  chordwisePanels: 4,
});

/** Elliptic planform of aspect ratio `ar`, root chord 1 m, straight quarter-chord line on x = 0. */
const elliptic = (ar: number): Record<string, unknown> => {
  const half = (ar * Math.PI * 1000) / 8;
  const sections = Array.from({ length: 25 }, (_, k) => {
    const theta = ((k / 24) * Math.PI) / 2;
    const chord = 1000 * Math.cos(theta);
    return { leadingEdge: [-chord / 4, half * Math.sin(theta), 0], chord };
  });
  return { name: 'wing', sections, spanwisePanels: 40, chordwisePanels: 2 };
};

const base = (surface: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  body: 'frame',
  surfaces: [surface],
  momentCentre: [0, 0, 0],
  forward: '-x',
  id: 'w',
  ...extra,
});

const generate = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'generate_aero_table', params);
const surfaceOf = (doc: CadDocument): AeroSurface => doc.flight?.aeroSurfaces?.['w'] as AeroSurface;
/** `params` as the command receives them after validation. */
const parsed = (params: Record<string, unknown>): Parameters<typeof generateAeroTable.run>[1] =>
  generateAeroTable.paramsValidator!.parse(params) as Parameters<typeof generateAeroTable.run>[1];
const pivotingWing = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  base({ ...rectangle(6000, 1000), pivots: true }, { pivotsDeg: [-10, 10], pivotPoint: [-250, 0, 0], servo: { rateDegS: 20 }, ...extra });

describe('generate_aero_table (FLT-M4)', () => {
  it('stores the table with its reference, provenance, hash and a polar; the lift slope of an elliptic wing follows 2πA/(A+2)', () => {
    const before = vehicle();
    const snapshot = structuredClone(before);
    const result = generate(before, base(elliptic(20), { forward: '-x' }));
    expect(result.affected).toEqual(['w']);
    expect(before).toEqual(snapshot);
    const w = surfaceOf(result.document);
    const data = result.data as { liftSlopePerRad: number; polar: { alphaDeg: number[]; cl: number[]; cd: number[] } };
    const aspect = w.refSpanM ** 2 / w.refAreaM2;
    expect(aspect).toBeCloseTo(20, 0);
    const lifting = (2 * Math.PI * aspect) / (aspect + 2);
    expect(Math.abs(data.liftSlopePerRad - lifting) / lifting).toBeLessThan(0.03);
    const table = w.table;
    const at = (deg: number): number => table.cl[table.alphaDeg.indexOf(deg)]?.[0] as number;
    expect((at(2) - at(-2)) / ((4 * Math.PI) / 180)).toBeCloseTo(data.liftSlopePerRad, 1);
    expect(w).toMatchObject({ provenance: 'vlm+polar', unverified: true, defaulted: ['profileDrag'], bodyId: 'frame', forward: '-x' });
    expect(w.designHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.summary).toContain('unverified: profile drag defaulted');
    // CD = cd0 + CDi with CDi = CL² / (π A e), e close to 1 for an elliptic wing
    const k = data.polar.alphaDeg.indexOf(8);
    const cl = data.polar.cl[k] as number;
    expect((data.polar.cd[k] as number) - 0.01).toBeCloseTo((cl * cl) / (Math.PI * aspect), 3);
    expect(data.polar.cd[data.polar.alphaDeg.indexOf(0)]).toBeCloseTo(0.01, 12);
  });

  it('a rectangular wing sits a few percent below the lifting-line slope (AR 20)', () => {
    const result = generate(vehicle(), base(rectangle(20000, 1000, -250, 40)));
    const slope = (result.data as { liftSlopePerRad: number }).liftSlopePerRad;
    const lifting = (2 * Math.PI * 20) / 22;
    expect(slope).toBeLessThan(lifting);
    expect(slope).toBeGreaterThan(0.93 * lifting);
  });

  it('converts the reference to SI (mm document), CL is odd in alpha, a given polar is graded, Cm is nose-up ahead of the neutral point', () => {
    const result = generate(
      vehicle(),
      base(rectangle(6000, 1000), { profileDrag: { cd0: 0.012, source: 'XFOIL NACA 0012 Re 3e5 (test)' } }),
    );
    const w = surfaceOf(result.document);
    expect([w.refAreaM2, w.refChordM, w.refSpanM]).toEqual([6, 1, 6]);
    expect(w).toMatchObject({ unverified: false, defaulted: [], profileDrag: { cd0: 0.012, clMax: null } });
    const { alphaDeg, cl, cm } = w.table;
    alphaDeg.forEach((deg, i) => expect(cl[i]?.[0]).toBeCloseTo(-(cl[alphaDeg.indexOf(-deg)]?.[0] as number), 8));
    // the moment centre (x = 0) is at the neutral point of a wing whose leading edge is at x = -250 and 150 mm behind it for one at x = -400
    const behind = surfaceOf(generate(vehicle(), base(rectangle(6000, 1000, -400))).document);
    expect(behind.table.cm[alphaDeg.indexOf(4)]?.[0]).toBeGreaterThan(0.01);
    expect(Math.abs(cm[alphaDeg.indexOf(4)]?.[0] as number)).toBeLessThan(0.005);
    expect(result.summary).toContain('profile drag from XFOIL NACA 0012');
  });

  it('forward "+x" / "+y" with the geometry placed to match give the identical table (flow-frame transform)', () => {
    const minus = surfaceOf(generate(vehicle(), base(rectangle(6000, 1000, -250), { forward: '-x' })).document);
    const plus = surfaceOf(generate(vehicle(), base(rectangle(6000, 1000, 250), { forward: '+x' })).document);
    expect(plus.table.cl).toEqual(minus.table.cl);
    expect(plus.table.cm).toEqual(minus.table.cm);
    const sideways = {
      ...rectangle(6000, 1000),
      sections: [
        { leadingEdge: [0, 250, 0], chord: 1000 },
        { leadingEdge: [3000, 250, 0], chord: 1000 },
      ],
    };
    const along = surfaceOf(generate(vehicle(), base(sideways, { forward: '+y' })).document);
    expect(along.table.cl).toEqual(minus.table.cl);
  });

  it('the flow-frame transform keeps incidence, camber and pivot signs whichever way the half wing runs (+x: tip toward -y of the flow frame)', () => {
    const pivoting = (forward: string, x: number): Record<string, unknown> =>
      base(
        { ...rectangle(6000, 1000, x), pivots: true, naca: '4412' },
        { forward, pivotsDeg: [-10, 10], pivotPoint: [x, 0, 0], servo: { rateDegS: 30 }, alphasDeg: [-10, 0, 10] },
      );
    const minus = surfaceOf(generate(vehicle(), pivoting('-x', -250)).document);
    const plus = surfaceOf(generate(vehicle(), pivoting('+x', 250)).document);
    expect(plus.table.cl).toEqual(minus.table.cl);
    expect(plus.table.cm).toEqual(minus.table.cm);
    // at alpha = 0 a +10° pivot gives the flat-plate 0.79 plus the camber lift, and -10° the flat-plate -0.79 plus the same camber lift
    const zero = minus.table.cl[1] as number[];
    expect(zero[1]).toBeGreaterThan(1);
    expect((zero[1] as number) + (zero[0] as number)).toBeGreaterThan(0.4);
  });

  it('a pivot sweep turns the pivoting surface: CL(alpha, pivot) close to CL(alpha + pivot) of the flat wing, with a servo', () => {
    const result = generate(
      vehicle(),
      base(
        { ...rectangle(6000, 1000), pivots: true },
        { pivotsDeg: [-10, 0, 10], pivotPoint: [-250, 0, 0], servo: { rateDegS: 30 }, alphasDeg: [-10, -5, 0, 5, 10] },
      ),
    );
    const w = surfaceOf(result.document);
    expect(w.table.pivotDeg).toEqual([-10, 0, 10]);
    expect(w.servo).toEqual({ rateDegS: 30, minDeg: -10, maxDeg: 10, neutralDeg: 0 });
    expect(w.solver.calls).toBe(3);
    const cl = (alpha: number, pivot: number): number =>
      w.table.cl[w.table.alphaDeg.indexOf(alpha)]?.[w.table.pivotDeg.indexOf(pivot)] as number;
    // the lattice keeps the trailing legs along the free stream, so a turned wing is not exactly the flat wing at alpha + pivot (about 5 % at 10 degrees)
    expect(Math.abs(cl(0, 10) - cl(10, 0)) / cl(10, 0)).toBeLessThan(0.08);
    expect(cl(0, 10)).toBeGreaterThan(cl(10, 0));
    expect(cl(0, -10)).toBeCloseTo(-cl(0, 10), 8);
    expect((result.data as { polar: { pivotDeg: number } }).polar.pivotDeg).toBe(0);
    expect(result.summary).toContain('pivot servo 30 deg/s in [-10, 10]');
  });

  it('clMax drops the angles of attack past stall and refuses a sweep that leaves fewer than two', () => {
    const result = generate(vehicle(), base(rectangle(6000, 1000), { profileDrag: { cd0: 0.01, clMax: 0.3 } }));
    const w = surfaceOf(result.document);
    expect(w.table.alphaDeg).toEqual([-4, -2, 0, 2, 4]);
    expect(w.validAlphaDeg).toEqual([-4, 4]);
    expect((result.data as { droppedAlphaDeg: number[] }).droppedAlphaDeg).toEqual([-10, -8, -6, 6, 8, 10]);
    const doc = vehicle();
    const empty = generate(doc, base(rectangle(6000, 1000), { profileDrag: { cd0: 0.01, clMax: 0.001 } }));
    expectNoOp(empty, doc, 'leaves fewer than 2 angles');
    expect(empty.error?.code).toBe('FLT_AERO_TABLE_EMPTY');
    // a cambered wing already over clMax at zero alpha has no valid range around zero lift
    const cambered = generate(doc, base({ ...rectangle(6000, 1000), naca: '4412' }, { profileDrag: { cd0: 0.01, clMax: 0.1 } }));
    expectNoOp(cambered, doc, 'leaves fewer than 2 angles');
  });

  it('refuses bad input without changing the document', () => {
    const doc = vehicle();
    const good = base(rectangle(6000, 1000));
    expectNoOp(generate(doc, { ...good, body: 'ghost' }), doc, "body 'ghost' is not a rigid body");
    const fixed = { ...doc, dynamics: { ...doc.dynamics!, bodies: { frame: { ...doc.dynamics!.bodies['frame']!, fixed: true } } } };
    expectNoOp(generate(fixed, good), fixed, 'is fixed to the ground');
    expectNoOp(generate(doc, { ...good, alphasDeg: [0, 25] }), doc, 'within -20..20');
    expectNoOp(generate(doc, { ...good, alphasDeg: [5, 0] }), doc, 'strictly increase');
    expectNoOp(
      generate(doc, { ...good, pivotsDeg: [5, 0], pivotPoint: [0, 0, 0], servo: { rateDegS: 1 } }),
      doc,
      'pivotsDeg must strictly increase',
    );
    expectNoOp(
      generate(doc, { ...good, pivotsDeg: [-5, 5], pivotPoint: [0, 0, 0], servo: { rateDegS: 1 } }),
      doc,
      'at least one surface with pivots: true',
    );
    const pivoting = { ...rectangle(6000, 1000), pivots: true };
    expectNoOp(generate(doc, base(pivoting, { pivotsDeg: [-5, 5], servo: { rateDegS: 1 } })), doc, 'needs pivotPoint and servo');
    expectNoOp(generate(doc, base(pivoting, { pivotsDeg: [-5, 5], pivotPoint: [0, 0, 0] })), doc, 'needs pivotPoint and servo');
    expectNoOp(
      generate(doc, base(pivoting, { pivotsDeg: [-5, 5], pivotPoint: [0, 0, 0], servo: { rateDegS: 1, maxDeg: 9 } })),
      doc,
      'servo limits [-5, 9]',
    );
    expectNoOp(generate(doc, { ...good, servo: { rateDegS: 1 } }), doc, 'servo needs pivotsDeg');
    const noSpan = {
      ...good,
      surfaces: [
        {
          name: 'w',
          sections: [
            { leadingEdge: [0, 0, 0], chord: 1 },
            { leadingEdge: [10, 0, 0], chord: 1 },
          ],
        },
      ],
    };
    expectNoOp(generate(doc, noSpan), doc, 'the vortex-lattice query refused');
    const made = generate(doc, good).document;
    expectNoOp(generate(made, good), made, "id 'w' is already used");
  });

  it('refuses at the second pivot call when the lattice query refuses there, and without the aerodynamics command in the registry', () => {
    const doc = vehicle();
    // a 1-panel-per-side pivoting surface whose rotation by 90 degrees leaves no spanwise extent in y-z is still fine: use an impossible panel count at the pivot
    const params = parsed(base(rectangle(6000, 1000)));
    const bare = { ...defaultContext(), registry: () => undefined };
    expectNoOp(generateAeroTable.run(doc, params, bare), doc, 'analyze_vortex_lattice is not registered');
    expectNoOp(generateAeroTable.run(doc, params), doc, 'analyze_vortex_lattice is not registered');
    let calls = 0;
    const flaky = {
      ...defaultContext(),
      registry: (name: string) => {
        const command = defaultContext().registry(name);
        if (command === undefined) return command;
        return {
          ...command,
          run: (d: CadDocument, p: unknown, c?: ExecutionContext) =>
            ++calls === 2 ? { document: d, summary: 'second call refused', affected: [] } : command.run(d, p, c),
        };
      },
    };
    const sweep = parsed(pivotingWing());
    expectNoOp(generateAeroTable.run(doc, sweep, flaky), doc, 'refused at pivot');
  });

  it('delete_dynamics_item removes the surface with its body and strips its pivot commands from scenarios', () => {
    let doc = generate(vehicle(), pivotingWing()).document;
    doc = step(doc, 'define_flight_scenario', { body: 'frame', durationS: 2, id: 's', setpoints: [{ t: 0, pivotDeg: { w: 5 } }] }).doc;
    const removed = execute(doc, 'delete_dynamics_item', { id: 'w' }).document;
    expect(removed.flight?.aeroSurfaces).toEqual({});
    expect(removed.flight?.scenarios?.['s']?.setpoints[0]).toEqual({ t: 0, position: [0, 0, 0], yawDeg: 0 });
    const gone = execute(doc, 'delete_dynamics_item', { id: 'frame' }).document;
    expect(gone.flight?.aeroSurfaces ?? {}).toEqual({});
  });

  it('scenario pivot commands are refused for a missing surface, one without a servo, another body or a value outside the servo limits', () => {
    const fixedSurface = generate(vehicle(), base(rectangle(6000, 1000))).document;
    const doc = generate(fixedSurface, pivotingWing({ id: 'p' })).document;
    const scenario = (pivotDeg: Record<string, number>): ReturnType<typeof execute> =>
      execute(doc, 'define_flight_scenario', { body: 'frame', durationS: 2, setpoints: [{ t: 0, pivotDeg }] });
    expectNoOp(scenario({ ghost: 1 }), doc, "'ghost' is not an aero surface with a pivot servo");
    expectNoOp(scenario({ w: 1 }), doc, "'w' is not an aero surface with a pivot servo");
    expectNoOp(scenario({ p: 11 }), doc, 'outside its servo limits [-10, 10]');
    expect(scenario({ p: 10 }).affected).toHaveLength(1);
    const box = step(doc, 'add_box', { size: [10, 10, 10], position: [900, 0, 0] });
    const other = step(box.doc, 'add_rigid_body', { entityIds: [box.id], id: 'other', massKg: 1 }).doc;
    expectNoOp(
      execute(other, 'define_flight_scenario', { body: 'other', durationS: 2, setpoints: [{ t: 0, pivotDeg: { p: 1 } }] }),
      other,
      "is on body 'frame', not 'other'",
    );
  });
});

describe('aero surfaces in the document slice', () => {
  const made = (): CadDocument => generate(vehicle(), pivotingWing()).document;
  const raw = (doc: CadDocument): Record<string, unknown> => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;

  it('a generated surface, a pivot command and a turbulence field round-trip load validation', () => {
    expect(flightDocument.validate(raw(made()))).toEqual([]);
    const withScenario = step(made(), 'define_flight_scenario', {
      body: 'frame',
      durationS: 2,
      id: 's',
      setpoints: [{ t: 0, pivotDeg: { w: 5 } }],
      wind: { turbulence: { sigmaMps: [1, 1, 0.5], seed: 7 } },
    }).doc;
    expect(flightDocument.validate(raw(withScenario))).toEqual([]);
  });

  it('rejects hand-edited records: bad ids, grids, axes, servo limits and pivot commands', () => {
    const edit = (patch: (surface: Record<string, unknown>) => void): string => {
      const copy = raw(made());
      const surfaces = (copy['flight'] as { aeroSurfaces: Record<string, Record<string, unknown>> }).aeroSurfaces;
      patch(surfaces['w'] as Record<string, unknown>);
      return flightDocument.validate(copy).join(' | ');
    };
    expect(edit((s) => (s['id'] = 'other'))).toContain('flight.aeroSurfaces.w.id must equal its key');
    expect(edit((s) => (s['bodyId'] = 'ghost'))).toContain("'ghost' is not a rigid body");
    expect(edit((s) => ((s['table'] as { pivotDeg: number[] }).pivotDeg = [10, -10]))).toContain('must strictly increase');
    expect(edit((s) => ((s['table'] as { cl: number[][] }).cl = (s['table'] as { cl: number[][] }).cl.slice(1)))).toContain(
      'table.cl: needs one row per angle',
    );
    expect(edit((s) => (s['servo'] = null))).toContain('servo: present exactly when');
    expect(edit((s) => (s['servo'] = { rateDegS: 1, minDeg: -20, maxDeg: 10, neutralDeg: 0 }))).toContain(
      "lie inside the table's pivot range",
    );
    expect(edit((s) => (s['validAlphaDeg'] = [5, -5]))).toContain('must be ascending');
    const clash = raw(made());
    const slice = clash['flight'] as { aeroSurfaces: Record<string, Record<string, unknown>> };
    slice.aeroSurfaces = { frame: { ...(slice.aeroSurfaces['w'] as Record<string, unknown>), id: 'frame' } };
    expect(flightDocument.validate(clash).join()).toContain("id 'frame' is also a dynamics record or another flight record");
    const scenarioDoc = raw(
      step(made(), 'define_flight_scenario', { body: 'frame', durationS: 2, id: 's', setpoints: [{ t: 0, pivotDeg: { w: 5 } }] }).doc,
    );
    const scenarios = (scenarioDoc['flight'] as { scenarios: Record<string, { setpoints: { pivotDeg: Record<string, number> }[] }> })
      .scenarios;
    (scenarios['s']?.setpoints[0] as { pivotDeg: Record<string, number> }).pivotDeg = { ghost: 1 };
    expect(flightDocument.validate(scenarioDoc).join()).toContain("'ghost' is not an aero surface with a pivot servo");
  });
});
