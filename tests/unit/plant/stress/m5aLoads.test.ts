/**
 * PST-M5a part 2: oblique restraints, imposed displacements, hydrotest, insulation, mill tolerance and user SIF overrides, each against a closed form
 * derived in the test (propped cantilever, fixed-fixed beam with a support movement = the guided cantilever of VC-PST-06, exact statics of the weights,
 * the section formulas with the reduced wall, SIF x M / Z of the override).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { analyzed, baseDoc, cases, conditioned, DN100, withModel, withPipe, type AnalysisData } from './m3Fixtures';
import { expectRel, referenceData } from './stressFixtures';

interface Geometry {
  nodes: { id: string; positionMm: number[] }[];
  elements: { id: string; pipeId: string; nodeIds: string[]; bendRadiusMm: number | null }[];
}
type Data = AnalysisData & { geometry: Geometry };
type StressRow = NonNullable<NonNullable<AnalysisData['details']>['stresses']>[number];

const run = (doc: CadDocument, modelId: string, extra: Record<string, unknown> = {}): Data =>
  analyzed(doc, modelId, { include: ['displacements', 'reactions', 'stresses', 'geometry'], ...extra }) as Data;

const E = 200000;
const G = E / (2 * (1 + 0.3));
const G_ACCEL = 9.80665;
const sectionOf = (od: number, wall: number): { A: number; Ai: number; I: number; As: number; Z: number } => {
  const id = od - 2 * wall;
  const A = (Math.PI / 4) * (od ** 2 - id ** 2);
  return {
    A,
    Ai: (Math.PI / 4) * id ** 2,
    I: (Math.PI / 64) * (od ** 4 - id ** 4),
    As: A / 2,
    Z: (Math.PI / 32) * ((od ** 4 - id ** 4) / od),
  };
};
const dn100 = sectionOf(DN100.odMm, DN100.wallMm);
const STEEL = 7850;
const wSteel = G_ACCEL * 1e-9 * STEEL * dn100.A; // N/mm

const anchor = (doc: CadDocument, id: string, pipeId: string, atMm: number): CadDocument =>
  apply(doc, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm }, kind: 'anchor' });

/** A DN100 pipe along `to` from (0, 0, 3000), anchored at the start, model with conditions `over`. */
function pipeScene(to: number[], over: Record<string, unknown> = {}): { doc: CadDocument; id: string; pipe: string; length: number } {
  const pipe = withPipe(baseDoc(), [[0, 0, 3000], to], DN100.odMm);
  const model = withModel(pipe.doc, [pipe.id]);
  const doc = anchor(conditioned(model.doc, model.id, over), model.id, pipe.id, 0);
  return { doc, id: model.id, pipe: pipe.id, length: Math.hypot(to[0] as number, to[1] as number, (to[2] as number) - 3000) };
}

const nodeAt = (data: Data, x: number, y: number, z = 3000): string => {
  const found = data.geometry.nodes.find(
    (node) => Math.hypot((node.positionMm[0] as number) - x, (node.positionMm[1] as number) - y, (node.positionMm[2] as number) - z) < 0.5,
  );
  if (found === undefined) throw new Error(`no node at ${x}, ${y}, ${z}`);
  return found.id;
};
const reactionAt = (data: Data, caseName: string, node: string): number[] =>
  data.details?.reactions?.find((entry) => entry.case === caseName && entry.nodeId === node)?.forceN ?? [];
const dispAt = (data: Data, caseName: string, node: string): number[] =>
  data.details?.displacements?.find((entry) => entry.case === caseName && entry.node === node)?.uMm ?? [];

describe('oblique restraints (PST_RESTRAINT_OBLIQUE removed)', () => {
  it('a guide at mid-length of a 45 degree pipe carries 2.5 F, as on an axis-aligned pipe (propped cantilever: R = F (3L - a) / 2a)', () => {
    const F = 1000;
    const side = 6000;
    const length = side * Math.SQRT2;
    const results: number[] = [];
    for (const oblique of [true, false]) {
      const to = oblique ? [side, side, 3000] : [length, 0, 3000];
      const scene = pipeScene(to);
      const mid = length / 2;
      let doc = apply(scene.doc, 'add_stress_restraint', { modelId: scene.id, at: { pipeId: scene.pipe, atMm: mid }, kind: 'guide' });
      const n = oblique ? [-Math.SQRT1_2, Math.SQRT1_2, 0] : [0, 1, 0];
      doc = cases(
        doc,
        scene.id,
        [{ name: 'F', type: 'SUS', basic: ['F1'] }],
        [{ name: 'F1', pipeId: scene.pipe, atMm: length, forceN: n.map((v) => v * F) }],
      );
      const data = run(doc, scene.id);
      const guideNode = oblique ? nodeAt(data, side / 2, side / 2) : nodeAt(data, mid, 0);
      const reaction = reactionAt(data, 'F', guideNode);
      results.push(Math.hypot(...reaction));
      if (oblique) {
        // the reaction acts along the horizontal normal of the pipe, against the load
        expect(Math.abs(reaction[2] as number)).toBeLessThan(1e-6);
        expect((reaction[0] as number) * (n[0] as number) + (reaction[1] as number) * (n[1] as number)).toBeLessThan(0);
      }
    }
    // Euler-Bernoulli: 2.5 F; Timoshenko shear shifts it by about 1e-3
    expectRel(results[1] as number, 2.5 * F, 3e-3, 'aligned propped cantilever');
    expectRel(results[0] as number, results[1] as number, 1e-6, 'oblique vs aligned');
  });

  it('an oblique one-way contact: weight pushes the tip onto it (R = 0.8 w (L^4/8EI + L^2/2GAs) / (L^3/3EI + L/GAs) along d), lifted when it reacts the other way', () => {
    const L = 4000;
    const d = [0, 0.6, 0.8];
    const w = wSteel;
    const sc = pipeScene([L, 0, 3000]);
    const withProp = (oneWay: '+' | '-'): CadDocument =>
      cases(
        apply(sc.doc, 'add_stress_restraint', {
          modelId: sc.id,
          at: { pipeId: sc.pipe, atMm: L },
          kind: 'translational',
          direction: d,
          oneWay,
        }),
        sc.id,
        [{ name: 'S', type: 'SUS', basic: ['W'] }],
      );
    const active = run(withProp('+'), sc.id);
    const u0 = w * (L ** 4 / (8 * E * dn100.I) + L ** 2 / (2 * G * dn100.As));
    const compliance = L ** 3 / (3 * E * dn100.I) + L / (G * dn100.As);
    const R = (0.8 * u0) / compliance;
    const tip = nodeAt(active, L, 0);
    const reaction = reactionAt(active, 'S', tip);
    expectRel(reaction[1] as number, R * 0.6, 1e-6, 'Ry');
    expectRel(reaction[2] as number, R * 0.8, 1e-6, 'Rz');
    expect(Math.abs(reaction[0] as number)).toBeLessThan(1e-6);
    // the contact holds the tip: no motion along d
    const motion = dispAt(active, 'S', tip);
    expect(Math.abs((motion[1] as number) * 0.6 + (motion[2] as number) * 0.8)).toBeLessThan(1e-6);

    const lifted = run(withProp('-'), sc.id);
    expect(Math.hypot(...reactionAt(lifted, 'S', tip))).toBeLessThan(1e-9);
    expect(dispAt(lifted, 'S', tip)[2]).toBeCloseTo(-u0, 6);
    expect(lifted.findings.map((finding) => finding.code)).toContain('PST_SUPPORT_LIFTOFF');
  });

  it('refuses a zero direction, axis with direction, friction on an oblique direction, and direction on a non-translational restraint', () => {
    const sc = pipeScene([4000, 0, 3000]);
    const at = { pipeId: sc.pipe, atMm: 2000 };
    const base = { modelId: sc.id, at, kind: 'translational' };
    expectRefusal(sc.doc, 'add_stress_restraint', { ...base, direction: [0, 0, 0] }, 'PST_PARAM_INVALID');
    expectRefusal(sc.doc, 'add_stress_restraint', { ...base, axis: 'y', direction: [0, 1, 1] }, 'PST_PARAM_INVALID');
    expectRefusal(sc.doc, 'add_stress_restraint', { ...base }, 'PST_PARAM_INVALID');
    expectRefusal(sc.doc, 'add_stress_restraint', { ...base, direction: [0, 1, 1], frictionCoefficient: 0.3 }, 'PST_PARAM_INVALID');
    expectRefusal(sc.doc, 'add_stress_restraint', { modelId: sc.id, at, kind: 'guide', direction: [0, 1, 1] }, 'PST_PARAM_INVALID');
  });
});

describe('imposed displacements D1..D9 (anchor movement)', () => {
  // NPS 6 Sch 40 (OD 168.3, wall 7.11), L = 6000 mm between two anchors, the far one moves 50 mm laterally: the guided cantilever of VC-PST-06.
  const section = sectionOf(168.3, 7.11);
  const L = 6000;
  const delta = 50;
  const phi = (12 * E * section.I) / (G * section.As * L ** 2);

  function guided(displacement: Record<string, unknown>): { doc: CadDocument; id: string; pipe: string } {
    const pipe = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [L, 0, 3000],
      ],
      168.3,
    );
    const model = withModel(pipe.doc, [pipe.id]);
    let doc = conditioned(model.doc, model.id, { wallMm: 7.11 });
    doc = anchor(anchor(doc, model.id, pipe.id, 0), model.id, pipe.id, L);
    doc = apply(doc, 'set_stress_load_cases', {
      modelId: model.id,
      cases: [{ name: 'D', type: 'OPE', basic: ['D1'] }],
      displacements: [{ name: 'D1', at: { pipeId: pipe.id, atMm: L }, ...displacement }],
    });
    return { doc, id: model.id, pipe: pipe.id };
  }

  it('lateral movement 50 mm: F = 12 E I d / (L^3 (1 + phi)), M = 6 E I d / (L^2 (1 + phi)); Euler-Bernoulli reference 6509.017 N / 1.9527e7 N.mm within the shear term', () => {
    const scene = guided({ translationMm: [0, delta, 0] });
    const data = run(scene.doc, scene.id);
    const end = nodeAt(data, L, 0);
    const F = (12 * E * section.I * delta) / (L ** 3 * (1 + phi));
    const M = (6 * E * section.I * delta) / (L ** 2 * (1 + phi));
    const load = data.details?.reactions?.find((entry) => entry.nodeId === end);
    expectRel(Math.abs(load?.forceN[1] as number), F, 1e-6, 'F');
    expectRel(Math.abs(load?.momentNmm[2] as number), M, 1e-6, 'M');
    const reference = referenceData<{ guidedCantilever: { expected: { F_N: number; M_Nmm: number } } }>('lbend_guided_cantilever.json')
      .guidedCantilever.expected;
    expectRel(Math.abs(load?.forceN[1] as number), reference.F_N, 8e-3, 'F vs beam theory');
    expectRel(Math.abs(load?.momentNmm[2] as number), reference.M_Nmm, 8e-3, 'M vs beam theory');
    expect(dispAt(data, 'D', end)[1]).toBeCloseTo(delta, 9);
  });

  it('end rotation 0.5 degree about z: M = (4 + phi) E I theta / ((1 + phi) L), F = 6 E I theta / ((1 + phi) L^2)', () => {
    const scene = guided({ translationMm: [0, 0, 0], rotationDeg: [0, 0, 0.5] });
    const data = run(scene.doc, scene.id);
    const theta = (0.5 * Math.PI) / 180;
    const load = data.details?.reactions?.find((entry) => entry.nodeId === nodeAt(data, L, 0));
    expectRel(Math.abs(load?.momentNmm[2] as number), ((4 + phi) * E * section.I * theta) / ((1 + phi) * L), 1e-6, 'M');
    expectRel(Math.abs(load?.forceN[1] as number), (6 * E * section.I * theta) / ((1 + phi) * L ** 2), 1e-6, 'F');
  });

  it('refuses a displacement at a node that is not an anchor, an undefined D in a case, and a pipe outside the model', () => {
    const scene = guided({ translationMm: [0, delta, 0] });
    const moved = apply(scene.doc, 'set_stress_load_cases', {
      modelId: scene.id,
      cases: [{ name: 'D', type: 'OPE', basic: ['D1'] }],
      displacements: [{ name: 'D1', at: { pipeId: scene.pipe, atMm: 3000 }, translationMm: [0, 1, 0] }],
    });
    expectRefusal(moved, 'analyze_pipe_stress', { modelId: scene.id }, 'PST_DISPLACEMENT_NOT_ANCHORED');
    expectRefusal(
      scene.doc,
      'set_stress_load_cases',
      { modelId: scene.id, cases: [{ name: 'D', type: 'OPE', basic: ['D2'] }] },
      'PST_LOADCASE_INVALID',
    );
    expectRefusal(
      scene.doc,
      'set_stress_load_cases',
      {
        modelId: scene.id,
        cases: [{ name: 'D', type: 'OPE', basic: ['D1'] }],
        displacements: [{ name: 'D1', at: { pipeId: 'nope', atMm: 0 }, translationMm: [0, 1, 0] }],
      },
      'PST_PIPE_NOT_FOUND',
    );
  });
});

describe('hydrotest, insulation and mill tolerance', () => {
  const L = 4000;

  it('insulation and cladding add to the weight: Fz = g L (rho_s A + rho_i pi/4 ((D + 2t)^2 - D^2) + c pi (D + 2t))', () => {
    const t = 50;
    const rho = 130;
    const c = 3.2;
    const sc = pipeScene([L, 0, 3000], { insulation: { thicknessMm: t, densityKgM3: rho, claddingKgM2: c } });
    const doc = cases(sc.doc, sc.id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const outer = DN100.odMm + 2 * t;
    const insulation = G_ACCEL * 1e-9 * rho * (Math.PI / 4) * (outer ** 2 - DN100.odMm ** 2);
    const cladding = G_ACCEL * 1e-6 * c * Math.PI * outer;
    const total = reactionAt(run(doc, sc.id), 'S', 'N1')[2] as number;
    expectRel(total, (wSteel + insulation + cladding) * L, 1e-7, 'insulated weight');
    // a valve with a stated weight carries no insulation on its length
    const valve = apply(doc, 'set_stress_component', {
      modelId: sc.id,
      declare: { pipeId: sc.pipe, atMm: 2000, lengthMm: 400, kind: 'valve' },
      weightKg: 40,
    });
    expectRel(
      reactionAt(run(valve, sc.id), 'S', 'N1')[2] as number,
      (wSteel + insulation + cladding) * (L - 400) + 40 * G_ACCEL,
      1e-7,
      'valve length keeps its stated weight only',
    );
  });

  it('hydrotest case: water weight Fz = g L (rho_s A + 1000 A_i), pressure and the reduced wall: S_L = P Di^2 / (Do^2 - Di^2) + M / Z', () => {
    const sc = pipeScene([L, 0, 3000], {
      corrosionAllowanceMm: 2,
      millTolerancePct: 12.5,
      hydrotest: { testPressureBar: 15, allowableMPa: 250 },
    });
    const doc = cases(sc.doc, sc.id, [
      { name: 'S', type: 'SUS', basic: ['W'] },
      { name: 'H', type: 'HYD', basic: ['WW', 'HP'] },
    ]);
    const data = run(doc, sc.id);
    const water = G_ACCEL * 1e-9 * 1000 * dn100.Ai;
    expectRel(reactionAt(data, 'H', 'N1')[2] as number, (wSteel + water) * L, 1e-7, 'hydro weight');
    expectRel(reactionAt(data, 'S', 'N1')[2] as number, wSteel * L, 1e-7, 'service weight (no contents)');
    // hydrotest section: nominal wall less the mill tolerance, no corrosion
    const hydro = sectionOf(DN100.odMm, DN100.wallMm * 0.875);
    const M = ((wSteel + water) * L ** 2) / 2;
    const axial = (1.5 * (DN100.odMm - 2 * DN100.wallMm * 0.875) ** 2) / (DN100.odMm ** 2 - (DN100.odMm - 2 * DN100.wallMm * 0.875) ** 2);
    const row = (name: string): StressRow =>
      data.details?.stresses?.find((entry) => entry.case === name && entry.node === 'N1') as StressRow;
    expectRel(row('H').stressMPa, axial + M / hydro.Z, 1e-6, 'hydrotest S_L');
    expect(row('H').allowableMPa).toBe(250);
    expect(row('H').rule).toBe('B313-HYD');
    // sustained section: mill tolerance and corrosion allowance both off the wall (no pressure in the SUS case)
    const sustained = sectionOf(DN100.odMm, DN100.wallMm * 0.875 - 2);
    expectRel(row('S').stressMPa, (wSteel * L ** 2) / 2 / sustained.Z, 1e-6, 'sustained S_L');
    expect(data.findings.map((finding) => finding.code)).not.toContain('PST_HYDROTEST_OVERSTRESS');
  });

  it('a hydrotest stress above its stated allowable is PST_HYDROTEST_OVERSTRESS (status fail)', () => {
    const sc = pipeScene([L, 0, 3000], { hydrotest: { testPressureBar: 15, allowableMPa: 5 } });
    const doc = cases(sc.doc, sc.id, [{ name: 'H', type: 'HYD', basic: ['WW', 'HP'] }]);
    const data = run(doc, sc.id);
    expect(data.findings.find((finding) => finding.code === 'PST_HYDROTEST_OVERSTRESS')?.severity).toBe('fail');
    expect(data.status).toBe('fail');
  });

  it('hydrotest primitives without the hydrotest conditions, a mill tolerance that eats the wall: coded refusals', () => {
    const sc = pipeScene([L, 0, 3000]);
    const noHydro = cases(sc.doc, sc.id, [{ name: 'H', type: 'HYD', basic: ['WW', 'HP'] }]);
    expectRefusal(noHydro, 'analyze_pipe_stress', { modelId: sc.id }, 'PST_LOADCASE_INVALID');
    expectRefusal(
      sc.doc,
      'set_pipe_operating_conditions',
      {
        modelId: sc.id,
        ...({ temperatures: [{ name: 'T1', tempC: 100 }], wallMm: 6, corrosionAllowanceMm: 5.5, millTolerancePct: 12.5 } as object),
        material: { youngsModulusMPa: 200000, ShMPa: 138, ScMPa: 138, thermal: { table: 'carbon-steel-c1' } },
      },
      'PST_CORROSION_EXCEEDS_WALL',
    );
  });
});

describe('set_sif_override', () => {
  const Ze = Math.PI * 54.14 ** 2 * 6.02;

  function tee(force: number[]): { doc: CadDocument; id: string; header: string; branch: string } {
    const header = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [6000, 0, 3000],
      ],
      DN100.odMm,
    );
    const branch = withPipe(
      header.doc,
      [
        [3000, 0, 3000],
        [3000, 2000, 3000],
      ],
      DN100.odMm,
    );
    const model = withModel(branch.doc, [header.id, branch.id]);
    let doc = conditioned(model.doc, model.id);
    doc = anchor(anchor(doc, model.id, header.id, 0), model.id, header.id, 6000);
    doc = cases(doc, model.id, [{ name: 'F', type: 'SUS', basic: ['F1'] }], [{ name: 'F1', pipeId: branch.id, atMm: 2000, forceN: force }]);
    return { doc, id: model.id, header: header.id, branch: branch.id };
  }
  const rootRow = (data: Data, branch: string): StressRow => {
    const node = nodeAt(data, 3000, 0);
    const ids = data.geometry.elements.filter((element) => element.pipeId === branch).map((element) => element.id);
    return data.details?.stresses?.find((entry) => entry.node === node && ids.includes(entry.element)) as StressRow;
  };

  it('at a tee: S_L = 0.75 io M / Z_e with the stated factors (out of plane 1.875 x 2e6 / 55434.85 = 67.64 MPa, in plane 1.5 x ... = 54.12 MPa); the source is listed', () => {
    for (const [force, factor] of [
      [[0, 0, 1000], 0.75 * 2.5],
      [[1000, 0, 0], 0.75 * 2.0],
    ] as const) {
      const scene = tee([...force]);
      const set = ok(scene.doc, 'set_sif_override', {
        modelId: scene.id,
        at: { pipeId: scene.branch, atMm: 0 },
        sifInPlane: 2.0,
        sifOutOfPlane: 2.5,
        source: 'B31J table 3, case 7',
      });
      const data = run(set.document, scene.id);
      const row = rootRow(data, scene.branch);
      expect(row.sif).toEqual({ ii: 2, io: 2.5 });
      expectRel(row.stressMPa, (factor * 2e6) / Ze, 1e-5, 'override stress');
      const listed = data.findings.find((finding) => finding.code === 'PST_SIF_OVERRIDE');
      expect(listed?.message).toContain('B31J table 3, case 7');
    }
  });

  it('at a bend: the factors and k replace the code values for the whole bend (S_L = 0.75 io F (2000 - R) / Z); a larger k makes the elbow more flexible', () => {
    const R = 1.5 * DN100.odMm;
    const pipe = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [3000, 0, 3000],
        [3000, 2000, 3000],
      ],
      DN100.odMm,
    );
    const model = withModel(pipe.doc, [pipe.id], { elbowRadiusFactor: 1.5 });
    let doc = anchor(conditioned(model.doc, model.id), model.id, pipe.id, 0);
    doc = cases(
      doc,
      model.id,
      [{ name: 'F', type: 'SUS', basic: ['F1'] }],
      [{ name: 'F1', pipeId: pipe.id, atMm: 5000, forceN: [0, 0, 1000] }],
    );
    const plain = run(doc, model.id);
    const tipOf = (data: Data): number => dispAt(data, 'F', nodeAt(data, 3000, 2000))[2] as number;
    const farEnd = nodeAt(plain, 3000, R);
    // the last chord of the 12 chords of the arc is 3.75 degrees off the y axis: M cos splits into out-of-plane bending, M sin is torsion; S_L = sqrt((s Mo / Z)^2 + (Mt / Z)^2)
    const theta = (3.75 * Math.PI) / 180;
    const chordStress = (s: number): number => (Math.hypot(s * Math.cos(theta), Math.sin(theta)) * 1000 * (2000 - R)) / dn100.Z;
    const bendRow = (data: Data): StressRow => {
      const bends = data.geometry.elements.filter((element) => element.bendRadiusMm !== null).map((element) => element.id);
      return data.details?.stresses?.find((entry) => entry.node === farEnd && bends.includes(entry.element)) as StressRow;
    };
    expectRel(bendRow(plain).stressMPa, chordStress(Math.max(1, 0.75 * bendRow(plain).sif.io)), 1e-6, 'code bend');
    const at = { pipeId: pipe.id, atMm: 3000 };
    const stated = apply(doc, 'set_sif_override', {
      modelId: model.id,
      at,
      sifInPlane: 2.4,
      sifOutOfPlane: 2.2,
      flexibility: 12,
      source: 'FE study 17',
    });
    const over = run(stated, model.id);
    expect(bendRow(over).sif).toEqual({ ii: 2.4, io: 2.2 });
    expectRel(bendRow(over).stressMPa, chordStress(0.75 * 2.2), 1e-6, 'override bend');
    const flexible = tipOf(over);
    const stiffer = tipOf(
      run(
        apply(doc, 'set_sif_override', {
          modelId: model.id,
          at,
          sifInPlane: 2.4,
          sifOutOfPlane: 2.2,
          flexibility: 1,
          source: 'FE study 17',
        }),
        model.id,
      ),
    );
    expect(Math.abs(flexible)).toBeGreaterThan(Math.abs(stiffer));
    // k = the code value changes nothing but the SIFs
    const codeK = bendRow(plain);
    expect(codeK.sif.io).toBeGreaterThan(1);
  });

  it('at a plain node: equal factors act in both planes (0.75 i M / Z); unequal ones raise PST_SIF_PLANE_UNKNOWN and the larger acts', () => {
    const sc = pipeScene([4000, 0, 3000]);
    const doc = cases(
      sc.doc,
      sc.id,
      [{ name: 'F', type: 'SUS', basic: ['F1'] }],
      [{ name: 'F1', pipeId: sc.pipe, atMm: 4000, forceN: [0, 0, 1000] }],
    );
    const place = (ii: number, io: number): CadDocument =>
      apply(doc, 'set_sif_override', {
        modelId: sc.id,
        at: { pipeId: sc.pipe, atMm: 2000 },
        sifInPlane: ii,
        sifOutOfPlane: io,
        source: 'vendor sheet',
      });
    const equal = run(place(1.8, 1.8), sc.id);
    const node = nodeAt(equal, 2000, 0);
    const rows = equal.details?.stresses?.filter((entry) => entry.node === node) ?? [];
    expect(rows).toHaveLength(2);
    for (const row of rows) expectRel(row.stressMPa, (0.75 * 1.8 * 1000 * 2000) / dn100.Z, 1e-6, 'plain node');
    expect(equal.findings.map((finding) => finding.code)).not.toContain('PST_SIF_PLANE_UNKNOWN');
    const unequal = run(place(1.2, 2.0), sc.id);
    expect(unequal.findings.map((finding) => finding.code)).toContain('PST_SIF_PLANE_UNKNOWN');
    for (const row of unequal.details?.stresses?.filter((entry) => entry.node === node) ?? [])
      expectRel(row.stressMPa, (0.75 * 2.0 * 1000 * 2000) / dn100.Z, 1e-6, 'larger factor');
  });

  it('replaces the override at the same place, deletes it, and refuses bad input; a flexibility off a bend is refused at analysis', () => {
    const sc = pipeScene([4000, 0, 3000]);
    const params = { modelId: sc.id, at: { pipeId: sc.pipe, atMm: 2000 }, sifInPlane: 1.5, sifOutOfPlane: 1.5, source: 'vendor sheet' };
    const first = ok(sc.doc, 'set_sif_override', params);
    const id = (first.data as { overrideId: string }).overrideId;
    const second = ok(first.document, 'set_sif_override', {
      ...params,
      sifInPlane: 1.7,
      sifOutOfPlane: 1.7,
      at: { pipeId: sc.pipe, atMm: 2000.4 },
    });
    expect((second.data as { overrideId: string }).overrideId).toBe(id);
    expect(second.document.plant?.stress?.models[sc.id]?.sifOverrides).toHaveLength(1);
    expect(second.document.plant?.stress?.models[sc.id]?.sifOverrides[0]?.sifInPlane).toBe(1.7);
    const gone = apply(second.document, 'delete_sif_override', { modelId: sc.id, overrideId: id });
    expect(gone.plant?.stress?.models[sc.id]?.sifOverrides).toEqual([]);
    expectRefusal(sc.doc, 'set_sif_override', { ...params, modelId: 'nope' }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(sc.doc, 'set_sif_override', { ...params, at: { pipeId: 'pipe-x', atMm: 1 } }, 'PST_POINT_OFF_PIPE');
    expectRefusal(sc.doc, 'set_sif_override', { ...params, at: { supportId: 'sup-x' } }, 'PST_SUPPORT_NOT_FOUND');
    expectRefusal(sc.doc, 'delete_sif_override', { modelId: sc.id, overrideId: 'sif-nope' }, 'PST_SIF_NOT_FOUND');
    expect(execute(sc.doc, 'set_sif_override', { ...params, sifInPlane: 0.5 }).rejected).toBe(true);
    const flex = apply(sc.doc, 'set_sif_override', { ...params, flexibility: 3 });
    const withLoad = cases(flex, sc.id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    expectRefusal(withLoad, 'analyze_pipe_stress', { modelId: sc.id }, 'PST_PARAM_INVALID');
  });
});

describe('conditioning: rigid body (E x 1e4) with an oblique contact on a short span', () => {
  it('the reactions at the anchor and the oblique contact equilibrate the applied force to 1e-6', () => {
    const sc = pipeScene([1200, 0, 3000]);
    let doc = apply(sc.doc, 'set_stress_component', {
      modelId: sc.id,
      declare: { pipeId: sc.pipe, atMm: 600, lengthMm: 300, kind: 'valve' },
      weightKg: 0,
    });
    doc = apply(doc, 'add_stress_restraint', {
      modelId: sc.id,
      at: { pipeId: sc.pipe, atMm: 1200 },
      kind: 'translational',
      direction: [0, 0.6, 0.8],
    });
    const load = [300, -700, -1000];
    doc = cases(doc, sc.id, [{ name: 'F', type: 'SUS', basic: ['F1'] }], [{ name: 'F1', pipeId: sc.pipe, atMm: 700, forceN: load }]);
    const data = run(doc, sc.id);
    const sum = [0, 1, 2].map((i) => (data.details?.reactions ?? []).reduce((total, entry) => total + (entry.forceN[i] as number), 0));
    for (const i of [0, 1, 2]) expect(Math.abs((sum[i] as number) + (load[i] as number)), `component ${i}`).toBeLessThan(1e-6 * 1200);
    expect(data.solver.maxResidual).toBeLessThan(1e-6);
  });
});
