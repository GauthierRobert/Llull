/**
 * PST-M5a part 1: tees / olets, valves, flanges and reducers as stress elements, against closed forms derived in the test:
 *  - a T of known geometry (header fixed at both ends, branch cantilever): tip deflection from beam theory (bending + torsion + Timoshenko shear),
 *    branch-root stress = SIF x M / Z_e with the SIF formulas of ASME B31.3 App. D evaluated by hand (and the published NPS 3 values of VC-PST-02);
 *  - a cantilever with a declared rigid valve: the exact statics of the stated weight, and the tip deflection with a rigid length;
 *  - a DN150 x DN100 concentric reducer: tip deflection with the stepped section (mean section in the reducer).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, valveScene, routedPumpToVesselWithTee } from '../piping/rteFixtures';
import { analyzed, baseDoc, cases, conditioned, DN100, withModel, withPipe, type AnalysisData } from './m3Fixtures';
import { expectRel } from './stressFixtures';

interface Geometry {
  nodes: { id: string; positionMm: number[] }[];
  elements: {
    id: string;
    pipeId: string;
    nodeIds: string[];
    pointsMm: number[][];
    odMm: number;
    wallMm: number;
    componentKey: string | null;
  }[];
  junctions: { nodeId: string; headerPipeId: string; branchPipeId: string; fitting: string; h: number | null; ii: number; io: number }[];
}
type Data = AnalysisData & { geometry: Geometry };

const run = (doc: CadDocument, modelId: string, extra: Record<string, unknown> = {}): Data =>
  analyzed(doc, modelId, { include: ['displacements', 'reactions', 'stresses', 'geometry'], ...extra }) as Data;

const E = 200000;
const NU = 0.3;
const G = E / (2 * (1 + NU));
const section = (od: number, wall: number): { A: number; I: number; J: number; As: number } => {
  const id = od - 2 * wall;
  const A = (Math.PI / 4) * (od ** 2 - id ** 2);
  const I = (Math.PI / 64) * (od ** 4 - id ** 4);
  return { A, I, J: 2 * I, As: A / 2 };
};
const dn100 = section(DN100.odMm, DN100.wallMm);

/** Header 0..6000 along X at z 3000 and a branch +Y from its midpoint (2000 long), fixed at both header ends; force F1 at the branch tip. */
function teeScene(force: number[], od = DN100.odMm, wall = DN100.wallMm): { doc: CadDocument; id: string; header: string; branch: string } {
  const header = withPipe(
    baseDoc(),
    [
      [0, 0, 3000],
      [6000, 0, 3000],
    ],
    od,
  );
  const branch = withPipe(
    header.doc,
    [
      [3000, 0, 3000],
      [3000, 2000, 3000],
    ],
    od,
  );
  const model = withModel(branch.doc, [header.id, branch.id]);
  let doc = conditioned(model.doc, model.id, { wallMm: wall });
  doc = apply(doc, 'add_stress_restraint', { modelId: model.id, at: { pipeId: header.id, atMm: 0 }, kind: 'anchor' });
  doc = apply(doc, 'add_stress_restraint', { modelId: model.id, at: { pipeId: header.id, atMm: 6000 }, kind: 'anchor' });
  doc = cases(doc, model.id, [{ name: 'F', type: 'SUS', basic: ['F1'] }], [{ name: 'F1', pipeId: branch.id, atMm: 2000, forceN: force }]);
  return { doc, id: model.id, header: header.id, branch: branch.id };
}

/** The stress row of the branch element at the junction node. */
type StressRow = NonNullable<NonNullable<AnalysisData['details']>['stresses']>[number];
function branchRoot(data: Data, branchPipeId: string): StressRow {
  const junction = data.geometry.junctions[0];
  const elements = data.geometry.elements.filter((element) => element.pipeId === branchPipeId).map((element) => element.id);
  const row = data.details?.stresses?.find((entry) => entry.node === junction?.nodeId && elements.includes(entry.element));
  if (row === undefined) throw new Error('no branch root row');
  return row;
}

describe('tee stiffness: a T with a fixed header and a branch cantilever (closed form)', () => {
  it('tip deflection = F a^3 / 24EI + F b^2 a / 2GJ + F b^3 / 3EI + shear terms (header 2a = 6000, branch b = 2000, F = 1000 N)', () => {
    const scene = teeScene([0, 0, 1000]);
    const data = run(scene.doc, scene.id, { nodes: ['N1', 'N2', 'N3', 'N4'] });
    const tip = data.geometry.nodes.find((node) => node.positionMm[1] === 2000);
    const a = 3000;
    const b = 2000;
    const F = 1000;
    const expected =
      (F * a ** 3) / (24 * E * dn100.I) +
      (F * b * b * a) / (2 * G * dn100.J) +
      (F * b ** 3) / (3 * E * dn100.I) +
      (F * b) / (G * dn100.As) +
      (F * a) / (2 * G * dn100.As);
    expect(expected).toBeCloseTo(19.2964, 3);
    const rows = data.details?.displacements?.filter((entry) => entry.node === tip?.id) ?? [];
    expect(rows).toHaveLength(1);
    expectRel(rows[0]?.uMm[2] as number, expected, 1e-6, 'tip uz');
    expect(data.geometry.junctions).toHaveLength(1);
    expect(data.model.elements).toBe(3);
  });
});

describe('SIF at the tee node: branch root stress = SIF x M / Z_e (B31.3 App. D, hand computed)', () => {
  // DN100: T = 6.02, r2 = (114.3 - 6.02) / 2 = 54.14, h = T / r2 = 0.111193 (unreinforced); Z_e = pi r2^2 T = 55434.85 mm3; M = F b = 2e6 N.mm.
  // unreinforced: io = 0.9 / h^(2/3) = 3.892157, ii = 0.75 io + 0.25 = 3.169118; sustained: max(1, 0.75 i) M / Z_e.
  const Ze = Math.PI * 54.14 ** 2 * 6.02;
  const M = 2e6;

  it('out-of-plane load (force normal to the plane of header and branch): S_L = 0.75 io M / Z_e = 105.317 MPa', () => {
    const scene = teeScene([0, 0, 1000]);
    const data = run(scene.doc, scene.id);
    const row = branchRoot(data, scene.branch);
    expect(row.sif.io).toBeCloseTo(3.892157, 5);
    expect(row.sif.ii).toBeCloseTo(3.169118, 5);
    expectRel(row.stressMPa, (0.75 * 3.892157 * M) / Ze, 1e-5, 'out-of-plane S_L');
    expect(data.findings.map((finding) => finding.code)).toContain('PST_TEE_FITTING_ASSUMED');
  });

  it('in-plane load (force along the header): S_L = 0.75 ii M / Z_e = 85.752 MPa', () => {
    const scene = teeScene([1000, 0, 0]);
    const row = branchRoot(run(scene.doc, scene.id), scene.branch);
    expectRel(row.stressMPa, (0.75 * 3.169118 * M) / Ze, 1e-5, 'in-plane S_L');
  });

  it('welding tee (h = 3.1 T / r2) and weldolet (h = 3.3 T / r2) through set_stress_component: 49.536 / 47.514 MPa out of plane', () => {
    for (const [fitting, io, stress] of [
      ['welding_tee', 1.830695, 49.536381],
      ['weldolet', 1.755959, 47.51413],
    ] as const) {
      const scene = teeScene([0, 0, 1000]);
      const set = apply(scene.doc, 'set_stress_component', { modelId: scene.id, branchPipeId: scene.branch, fitting });
      const data = run(set, scene.id);
      const row = branchRoot(data, scene.branch);
      expect(row.sif.io).toBeCloseTo(io, 5);
      expectRel(row.stressMPa, stress, 1e-5, fitting);
      expect(data.geometry.junctions[0]).toMatchObject({ fitting, branchPipeId: scene.branch });
      expect(data.findings.map((finding) => finding.code)).not.toContain('PST_TEE_FITTING_ASSUMED');
    }
  });

  it('the header side of the junction carries the same SIFs (i x M / Z of the header pipe)', () => {
    const scene = teeScene([0, 0, 1000]);
    const data = run(scene.doc, scene.id);
    const junction = data.geometry.junctions[0];
    const headerElements = data.geometry.elements.filter((element) => element.pipeId === scene.header).map((element) => element.id);
    const rows = data.details?.stresses?.filter((entry) => entry.node === junction?.nodeId && headerElements.includes(entry.element)) ?? [];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.sif.io).toBeCloseTo(3.892157, 5);
  });

  it('published values: NPS 3 Sch 40 (T 0.216 in) unreinforced io 3.4795, welding tee 1.6366, weldolet 1.5698 (VC-PST-02, PSI test_sifs)', () => {
    for (const [fitting, io] of [
      ['unreinforced_tee', 3.4795],
      ['welding_tee', 1.6366],
      ['weldolet', 1.5698],
    ] as const) {
      const scene = teeScene([0, 0, 100], 3.5 * 25.4, 0.216 * 25.4);
      const set = apply(scene.doc, 'set_stress_component', { modelId: scene.id, branchPipeId: scene.branch, fitting });
      expectRel(branchRoot(run(set, scene.id), scene.branch).sif.io, io, 1e-4, fitting);
    }
  });

  it('a reinforced tee uses h = (T + tr/2)^2.5 / (T^1.5 r2) with the pad thickness', () => {
    const scene = teeScene([0, 0, 1000]);
    const set = apply(scene.doc, 'set_stress_component', {
      modelId: scene.id,
      branchPipeId: scene.branch,
      fitting: 'reinforced_tee',
      padMm: 6,
    });
    const h = (6.02 + 3) ** 2.5 / (6.02 ** 1.5 * 54.14);
    expectRel(branchRoot(run(set, scene.id), scene.branch).sif.io, Math.max(1, 0.9 / h ** (2 / 3)), 1e-6, 'reinforced io');
  });

  it('a tee weight acts as a point load at the junction (vertical reactions sum to pipe weight + tee weight)', () => {
    const scene = teeScene([0, 0, 0]);
    const plain = cases(scene.doc, scene.id, [{ name: 'W', type: 'SUS', basic: ['W'] }]);
    const weighed = apply(plain, 'set_stress_component', { modelId: scene.id, branchPipeId: scene.branch, weightKg: 30 });
    const total = (doc: CadDocument): number =>
      (run(doc, scene.id).details?.reactions ?? []).reduce((sum, entry) => sum + (entry.forceN[2] as number), 0);
    expect(total(weighed) - total(plain)).toBeCloseTo(30 * 9.80665, 6);
  });
});

describe('junction refusals and component data validation', () => {
  it('a branch more than 15 degrees off perpendicular, a cross and a Y are PST_BRANCH_UNSUPPORTED', () => {
    const header = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [6000, 0, 3000],
      ],
      DN100.odMm,
    );
    const skew = withPipe(
      header.doc,
      [
        [3000, 0, 3000],
        [4500, 1000, 3000],
      ],
      DN100.odMm,
    );
    const m1 = withModel(skew.doc, [header.id, skew.id]);
    const skewed = cases(conditioned(m1.doc, m1.id), m1.id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    expectRefusal(skewed, 'analyze_pipe_stress', { modelId: m1.id }, 'PST_BRANCH_UNSUPPORTED');
    const left = withPipe(
      header.doc,
      [
        [3000, 0, 3000],
        [3000, 2000, 3000],
      ],
      DN100.odMm,
    );
    const right = withPipe(
      left.doc,
      [
        [3000, 0, 3000],
        [3000, -2000, 3000],
      ],
      DN100.odMm,
    );
    const m2 = withModel(right.doc, [header.id, left.id, right.id]);
    const cross = cases(conditioned(m2.doc, m2.id), m2.id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const refusal = expectRefusal(cross, 'analyze_pipe_stress', { modelId: m2.id }, 'PST_BRANCH_UNSUPPORTED');
    expect(refusal.summary).toContain('only tees');
  });

  it('a branch that ends on a bend of the header is refused (the stub ends on the 45 degree vertex of the R = 1.5 OD bend)', () => {
    const header = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [3000, 0, 3000],
        [3000, 3000, 3000],
      ],
      DN100.odMm,
    );
    const radius = 1.5 * DN100.odMm;
    const onArc = [3000 - radius + radius * Math.sin(Math.PI / 4), radius - radius * Math.cos(Math.PI / 4), 3000];
    const stub = withPipe(header.doc, [onArc, [onArc[0] as number, onArc[1] as number, 5000]], DN100.odMm);
    const model = withModel(stub.doc, [header.id, stub.id], { elbowRadiusFactor: 1.5 });
    const ready = cases(conditioned(model.doc, model.id), model.id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const refusal = expectRefusal(ready, 'analyze_pipe_stress', { modelId: model.id }, 'PST_BRANCH_UNSUPPORTED');
    expect(refusal.summary).toContain('bend');
  });

  it('set_stress_component refuses bad input and leaves the document unchanged', () => {
    const scene = teeScene([0, 0, 1000]);
    const base = { modelId: scene.id };
    expectRefusal(scene.doc, 'set_stress_component', { modelId: 'nope', branchPipeId: scene.branch, weightKg: 1 }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(scene.doc, 'set_stress_component', { ...base, weightKg: 1 }, 'PST_PARAM_INVALID');
    expectRefusal(scene.doc, 'set_stress_component', { ...base, branchPipeId: scene.branch }, 'PST_PARAM_INVALID');
    expectRefusal(scene.doc, 'set_stress_component', { ...base, branchPipeId: 'pipe-x', weightKg: 1 }, 'PST_PIPE_NOT_FOUND');
    expectRefusal(scene.doc, 'set_stress_component', { ...base, componentId: 'valve-x', weightKg: 1 }, 'PST_COMPONENT_NOT_FOUND');
    expectRefusal(scene.doc, 'set_stress_component', { ...base, branchPipeId: scene.branch, rigid: true }, 'PST_PARAM_INVALID');
    expectRefusal(
      scene.doc,
      'set_stress_component',
      { ...base, branchPipeId: scene.branch, fitting: 'reinforced_tee' },
      'PST_PARAM_INVALID',
    );
    expectRefusal(
      scene.doc,
      'set_stress_component',
      { ...base, declare: { pipeId: scene.header, atMm: 99999, lengthMm: 300, kind: 'valve' }, weightKg: 1 },
      'PST_POINT_OFF_PIPE',
    );
    expectRefusal(
      scene.doc,
      'set_stress_component',
      { ...base, declare: { pipeId: scene.header, atMm: 100, lengthMm: 300, kind: 'valve' }, rigid: true, stiffnessFactor: 2 },
      'PST_PARAM_INVALID',
    );
    expectRefusal(
      scene.doc,
      'set_stress_component',
      { ...base, declare: { pipeId: scene.header, atMm: 1, lengthMm: 3, kind: 'valve', id: 'cmp-9' }, weightKg: 1 },
      'PST_COMPONENT_NOT_FOUND',
    );
    expectRefusal(scene.doc, 'delete_stress_component', { modelId: scene.id, componentRecordId: 'cmp-nope' }, 'PST_COMPONENT_NOT_FOUND');
  });

  it('set_stress_component is an upsert on the same target and delete_stress_component removes it; both drop the approval path via edited()', () => {
    const scene = teeScene([0, 0, 1000]);
    const first = ok(scene.doc, 'set_stress_component', { modelId: scene.id, branchPipeId: scene.branch, weightKg: 5 });
    const id = (first.data as { componentRecordId: string }).componentRecordId;
    const second = ok(first.document, 'set_stress_component', { modelId: scene.id, branchPipeId: scene.branch, fitting: 'weldolet' });
    expect((second.data as { componentRecordId: string }).componentRecordId).toBe(id);
    const stored = second.document.plant?.stress?.models[scene.id]?.components ?? [];
    expect(stored).toEqual([{ id, target: { branchPipeId: scene.branch }, weightKg: 5, fitting: 'weldolet' }]);
    const gone = apply(second.document, 'delete_stress_component', { modelId: scene.id, componentRecordId: id });
    expect(gone.plant?.stress?.models[scene.id]?.components).toEqual([]);
  });
});

describe('valves and flanges: stated weight and rigidity (declared on a building pipe)', () => {
  const L = 4000;
  const valve = { atMm: 2500, lengthMm: 500 };
  function cantilever(componentData: Record<string, unknown>, loads: 'W' | 'F'): { doc: CadDocument; id: string; pipe: string } {
    const pipe = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [L, 0, 3000],
      ],
      DN100.odMm,
    );
    const model = withModel(pipe.doc, [pipe.id]);
    let doc = conditioned(model.doc, model.id);
    doc = apply(doc, 'add_stress_restraint', { modelId: model.id, at: { pipeId: pipe.id, atMm: 0 }, kind: 'anchor' });
    doc = apply(doc, 'set_stress_component', {
      modelId: model.id,
      declare: { pipeId: pipe.id, ...valve, kind: 'valve' },
      ...componentData,
    });
    doc =
      loads === 'W'
        ? cases(doc, model.id, [{ name: 'S', type: 'SUS', basic: ['W'] }])
        : cases(
            doc,
            model.id,
            [{ name: 'S', type: 'SUS', basic: ['F1'] }],
            [{ name: 'F1', pipeId: pipe.id, atMm: L, forceN: [0, 0, 1000] }],
          );
    return { doc, id: model.id, pipe: pipe.id };
  }

  it('weight statics: anchor reaction Fz = w (L - 500) + 100 kg x g and My = w (2250^2/2 + (4000^2 - 2750^2)/2) + 100 g x 2500', () => {
    const scene = cantilever({ weightKg: 100 }, 'W');
    const data = run(scene.doc, scene.id);
    const w = 9.80665e-9 * 7850 * dn100.A; // N/mm of steel
    const wv = 100 * 9.80665;
    const fz = w * (L - 500) + wv;
    const my = (w * (2250 ** 2 + (L ** 2 - 2750 ** 2))) / 2 + wv * 2500;
    const r = data.details?.reactions?.[0];
    expectRel(r?.forceN[2] as number, fz, 1e-7, 'Fz');
    expectRel(Math.abs(r?.momentNmm[1] as number), my, 1e-7, 'My');
    expect(data.geometry.elements.filter((element) => element.componentKey !== null)).toHaveLength(1);
    expect(data.findings.map((finding) => finding.code)).not.toContain('PST_COMPONENT_WEIGHT_MISSING');
  });

  it('without a stated weight the body keeps the pipe weight and PST_COMPONENT_WEIGHT_MISSING is raised', () => {
    const scene = cantilever({ rigid: true }, 'W');
    const data = run(scene.doc, scene.id);
    const w = 9.80665e-9 * 7850 * dn100.A;
    expectRel(data.details?.reactions?.[0]?.forceN[2] as number, w * L, 1e-7, 'Fz');
    expect(data.findings.map((finding) => finding.code)).toContain('PST_COMPONENT_WEIGHT_MISSING');
  });

  it('rigid length: tip deflection = F/(3EI) [L^3 - (L - 2250)^3 + (L - 2750)^3] + F (L - 500) / G A_s (rigid part adds < 1e-3)', () => {
    const scene = cantilever({ weightKg: 0 }, 'F');
    const data = run(scene.doc, scene.id);
    const F = 1000;
    const flexible = (F / (3 * E * dn100.I)) * (L ** 3 - (L - 2250) ** 3 + (L - 2750) ** 3) + (F * (L - 500)) / (G * dn100.As);
    const tip = data.geometry.nodes.find((node) => node.positionMm[0] === L);
    const uz = data.details?.displacements?.find((entry) => entry.node === tip?.id)?.uMm[2] as number;
    expectRel(uz, flexible, 1e-3, 'tip with rigid valve');
    // and it is stiffer than the full pipe (the rigid length contributes nothing but 1e-4 of its flexibility)
    const full = (F * L ** 3) / (3 * E * dn100.I) + (F * L) / (G * dn100.As);
    expect(uz).toBeLessThan(full);
  });

  it('an elastic body (rigid false, stiffnessFactor 1) is the plain pipe; its stress is checked', () => {
    const scene = cantilever({ weightKg: 0, rigid: false }, 'F');
    const data = run(scene.doc, scene.id);
    const F = 1000;
    const full = (F * L ** 3) / (3 * E * dn100.I) + (F * L) / (G * dn100.As);
    const tip = data.geometry.nodes.find((node) => node.positionMm[0] === L);
    expectRel(data.details?.displacements?.find((entry) => entry.node === tip?.id)?.uMm[2] as number, full, 1e-6, 'tip');
    const rows = data.details?.stresses?.filter(
      (entry) => data.geometry.elements.find((element) => element.id === entry.element)?.componentKey !== null,
    );
    expect(rows?.length).toBeGreaterThan(0);
  });

  it('a rigid body has no code stress rows', () => {
    const scene = cantilever({ weightKg: 0 }, 'F');
    const data = run(scene.doc, scene.id);
    const bodies = data.geometry.elements.filter((element) => element.componentKey !== null).map((element) => element.id);
    expect(data.details?.stresses?.some((entry) => bodies.includes(entry.element))).toBe(false);
  });
});

describe('RTE valves and reducers', () => {
  it('an RTE inline valve becomes a rigid body; its weight is set through componentId', () => {
    const scene = valveScene();
    const created = ok(scene.doc, 'create_stress_model', { name: 'v', pipeIds: [scene.runId], rule: 'B31.3-2018' });
    const id = (created.data as { modelId: string }).modelId;
    let doc = conditioned(created.document, id, { wallMm: undefined });
    doc = apply(doc, 'add_stress_restraint', { modelId: id, at: { pipeId: scene.runId, atMm: 0 }, kind: 'anchor' });
    doc = apply(doc, 'add_stress_restraint', { modelId: id, at: { pipeId: scene.runId, atMm: 1e7 }, kind: 'anchor' });
    doc = cases(doc, id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const before = run(doc, id);
    expect(before.findings.map((finding) => finding.code)).toContain('PST_COMPONENT_WEIGHT_MISSING');
    expect(before.findings.map((finding) => finding.code)).not.toContain('PST_COMPONENT_AS_PIPE');
    const bodies = before.geometry.elements.filter((element) => element.componentKey === scene.valveId);
    expect(bodies.length).toBeGreaterThan(0);
    const weighed = apply(doc, 'set_stress_component', { modelId: id, componentId: scene.valveId, weightKg: 60 });
    const after = run(weighed, id);
    expect(after.findings.map((finding) => finding.code)).not.toContain('PST_COMPONENT_WEIGHT_MISSING');
    const total = (data: Data): number => (data.details?.reactions ?? []).reduce((sum, entry) => sum + (entry.forceN[2] as number), 0);
    const bodyLength = bodies.reduce(
      (sum, element) => sum + Math.hypot(...(element.pointsMm[1] as number[]).map((v, i) => v - (element.pointsMm[0]?.[i] as number))),
      0,
    );
    const section0 = section(bodies[0]?.odMm as number, bodies[0]?.wallMm as number);
    const removed = 9.80665e-9 * 7850 * section0.A * bodyLength;
    expectRel(total(after) - total(before), 60 * 9.80665 - removed, 1e-6, 'valve weight');
  });

  it('a concentric reducer DN150 x DN100: elements take the stepped section and the mean section in the reducer; tip deflection matches the stepped beam', () => {
    const line = cs150Line(150, '2001');
    const a = addTie(line.doc, 'RA', [0, 0, 3000], [1, 0, 0], { dn: 150 });
    const b = addTie(a.doc, 'RB', [6000, 0, 3000], [-1, 0, 0], { dn: 100 });
    const routed = apply(b.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: a.id },
      to: { portId: b.id },
      inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
    });
    const runId = routed.plant?.piping?.runOrder[0] as string;
    const created = ok(routed, 'create_stress_model', { name: 'r', pipeIds: [runId], rule: 'B31.3-2018' });
    const id = (created.data as { modelId: string }).modelId;
    let doc = conditioned(created.document, id, { wallMm: undefined });
    doc = apply(doc, 'add_stress_restraint', { modelId: id, at: { pipeId: runId, atMm: 0 }, kind: 'anchor' });
    doc = cases(doc, id, [{ name: 'S', type: 'SUS', basic: ['F1'] }], [{ name: 'F1', pipeId: runId, atMm: 1e7, forceN: [0, 0, 1000] }]);
    const data = run(doc, id);
    const elements = data.geometry.elements;
    const reducerElements = elements.filter((element) => element.componentKey !== null);
    expect(reducerElements).toHaveLength(1);
    const sizes = elements.map((element) => [element.odMm, element.wallMm]);
    expect(sizes[0]).toEqual([168.3, 7.11]);
    expect(sizes.at(-1)).toEqual([114.3, 6.02]);
    expect(reducerElements[0]?.odMm).toBeCloseTo((168.3 + 114.3) / 2, 9);
    expect(reducerElements[0]?.wallMm).toBeCloseTo((7.11 + 6.02) / 2, 9);
    expect(data.findings.map((finding) => finding.code)).toContain('PST_REDUCER_SIF');
    // closed form on the model's own element sections: delta = sum over elements of the exact cantilever tip contribution
    const tipX = 6000;
    const xs = elements.map((element) => [element.pointsMm[0]?.[0] as number, element.pointsMm[1]?.[0] as number]);
    let expected = 0;
    elements.forEach((element, i) => {
      const s = section(element.odMm, element.wallMm);
      const [x0, x1] = xs[i] as number[];
      const F = 1000;
      expected +=
        (F / (3 * E * s.I)) * ((tipX - (x0 as number)) ** 3 - (tipX - (x1 as number)) ** 3) +
        (F * ((x1 as number) - (x0 as number))) / (G * s.As);
    });
    const tip = data.geometry.nodes.find((node) => node.positionMm[0] === tipX);
    expectRel(data.details?.displacements?.find((entry) => entry.node === tip?.id)?.uMm[2] as number, expected, 1e-6, 'stepped tip');
  });

  it('component data validation: a reducer or valve id of the model is accepted; a branch pipe outside the model is refused', () => {
    const scene = routedPumpToVesselWithTee();
    const created = ok(scene.doc, 'create_stress_model', { name: 't', pipeIds: [scene.runId, scene.branchRunId], rule: 'B31.3-2018' });
    const id = (created.data as { modelId: string }).modelId;
    const set = ok(created.document, 'set_stress_component', { modelId: id, branchPipeId: scene.branchRunId, weightKg: 12 });
    expect(set.affected[0]).toBe(id);
    expectRefusal(created.document, 'set_stress_component', { modelId: id, branchPipeId: 'nope', weightKg: 12 }, 'PST_PIPE_NOT_FOUND');
  });

  it('an RTE tee is a welding tee, an RTE header + branch analyses with a junction and no assumed fitting', () => {
    const scene = routedPumpToVesselWithTee();
    const created = ok(scene.doc, 'create_stress_model', { name: 't', pipeIds: [scene.runId, scene.branchRunId], rule: 'B31.3-2018' });
    const id = (created.data as { modelId: string }).modelId;
    let doc = conditioned(created.document, id, { wallMm: undefined });
    doc = apply(doc, 'add_stress_restraint', { modelId: id, at: { pipeId: scene.runId, atMm: 0 }, kind: 'anchor' });
    doc = apply(doc, 'add_stress_restraint', { modelId: id, at: { pipeId: scene.runId, atMm: 1e7 }, kind: 'anchor' });
    doc = cases(doc, id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const data = run(doc, id);
    expect(data.geometry.junctions).toHaveLength(1);
    expect(data.geometry.junctions[0]).toMatchObject({
      fitting: 'welding_tee',
      branchPipeId: scene.branchRunId,
      headerPipeId: scene.runId,
    });
    expect(data.findings.map((finding) => finding.code)).not.toContain('PST_TEE_FITTING_ASSUMED');
    expect(data.findings.map((finding) => finding.code)).not.toContain('PST_COMPONENT_UNSUPPORTED');
  });
});
