/**
 * PST-M5b spring hangers (TR-PST-08, VC-PST-14): an L-frame (riser H = 4000 mm anchored at the base, horizontal leg L = 6000 mm, DN100) whose tip is the
 * hanger point. The travel is determinate (a free thermal strain on a cantilever frame moves the tip by eps H exactly); the hot load is the propped-leg
 * formula R = w L (H / 2 + L / 8) / (H + L / 3) (Euler-Bernoulli, root spring EI / H); the preloaded spring then reproduces the hot load in OPE exactly
 * (superposition about the design state) and F = P_hot + k d / (1 + k / k_t) in SUS.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { analyzed, baseDoc, cases, conditioned, DN100, reaction, withModel, withPipe, type AnalysisData } from './m3Fixtures';
import { expectRel } from './stressFixtures';

const GRAVITY = 9.80665;
const od = DN100.odMm;
const id = od - 2 * DN100.wallMm;
const A = (Math.PI / 4) * (od ** 2 - id ** 2);
const w = GRAVITY * 1e-9 * 7850 * A;
const H = 4000;
const L = 6000;
const ALPHA = 1.2e-5;
const DELTA_T = 200;
const TRAVEL = ALPHA * DELTA_T * H; // 9.6 mm
const HOT = (w * L * (H / 2 + L / 8)) / (H + L / 3);

const TABLE = {
  S0: { size: 'S0', series: 'A', minN: 300, maxN: 500, rateNPerMm: 30, travelMm: 25 },
  S2: { size: 'S2', series: 'A', minN: 300, maxN: 600, rateNPerMm: 10, travelMm: 25 },
  S3: { size: 'S3', series: 'A', minN: 300, maxN: 600, rateNPerMm: 5, travelMm: 25 },
  S4: { size: 'S4', series: 'B', minN: 300, maxN: 1200, rateNPerMm: 2, travelMm: 25 },
  S1: { size: 'S1', series: 'A', minN: 100, maxN: 250, rateNPerMm: 5, travelMm: 25 },
  S5: { size: 'S5', series: 'A', minN: 300, maxN: 500, rateNPerMm: 5, travelMm: 5 },
};

interface Scene {
  doc: CadDocument;
  id: string;
  pipe: string;
  tip: { pipeId: string; atMm: number };
}

function frame(withCases = true): Scene {
  const pipe = withPipe(
    baseDoc(),
    [
      [0, 0, 0],
      [0, 0, H],
      [L, 0, H],
    ],
    od,
  );
  const model = withModel(pipe.doc, [pipe.id]);
  let doc = conditioned(
    model.doc,
    model.id,
    { temperatures: [{ name: 'T1', tempC: 21.1 + DELTA_T }] },
    { thermal: { meanCtePerK: ALPHA } },
  );
  doc = apply(doc, 'add_stress_restraint', { modelId: model.id, at: { pipeId: pipe.id, atMm: 0 }, kind: 'anchor' });
  if (withCases)
    doc = cases(doc, model.id, [
      { name: 'SUS', type: 'SUS', basic: ['W'] },
      { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
      {
        name: 'EXP',
        type: 'EXP',
        combine: [
          { case: 'OPE', factor: 1 },
          { case: 'SUS', factor: -1 },
        ],
      },
    ]);
  return { doc, id: model.id, pipe: pipe.id, tip: { pipeId: pipe.id, atMm: H + L } };
}

const withTable = (scene: Scene, names: (keyof typeof TABLE)[]): CadDocument =>
  apply(scene.doc, 'import_spring_table', {
    modelId: scene.id,
    tableId: 'T',
    source: 'test catalogue 2026',
    sizes: names.map((name) => TABLE[name]),
  });

const select = (doc: CadDocument, scene: Scene, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(doc, 'select_spring_hangers', { modelId: scene.id, hangers: [{ pipeId: scene.pipe, atMm: H + L }], tableId: 'T', ...extra });

interface SpringRow {
  id: string;
  kind: string;
  size?: string;
  series?: string;
  rateNPerMm: number;
  hotLoadN: number;
  coldLoadN: number;
  travelUpMm: number;
  variability: number;
  operatingLoadN: number;
  residualPct: number;
}
const springsOf = (result: ReturnType<typeof execute>): SpringRow[] => (result.data as { springs: SpringRow[] }).springs;
const tipNode = (data: AnalysisData & { geometry?: { nodes: { id: string; positionMm: number[] }[] } }): string =>
  (data.geometry?.nodes.find((node) => Math.abs((node.positionMm[0] as number) - L) < 0.5) as { id: string }).id;

describe('select_spring_hangers on the L-frame (VC-PST-14)', () => {
  it('hot load = the propped-leg formula, travel = eps H exactly, size = the smallest low-rate size within 25 percent', () => {
    const scene = frame();
    const doc = withTable(scene, ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
    const result = select(doc, scene);
    expect(result.rejected).toBeUndefined();
    const [spring] = springsOf(result) as [SpringRow];
    expectRel(spring.travelUpMm, TRAVEL, 1e-6, 'travel d = eps H');
    // Euler-Bernoulli formula; the model is Timoshenko with an axial riser, which shifts the load by under 0.5 %
    expectRel(spring.hotLoadN, HOT, 5e-3, 'hot load');
    // S0 is the smallest range but varies 66 %, S1 does not hold the load, S5 has too little travel, S2 and S3 share a range: the lower rate wins
    expect([spring.series, spring.size]).toEqual(['A', 'S3']);
    expect(spring.coldLoadN).toBeCloseTo(spring.hotLoadN + 5 * spring.travelUpMm, 9);
    expect(spring.variability).toBeCloseTo((5 * spring.travelUpMm) / spring.hotLoadN, 12);
    expect(result.affected).toEqual([scene.id, spring.id]);
    expect((result.data as { defaulted: string[] }).defaulted).toEqual(['maxVariability=0.25', 'constantEffortFallback=true']);
  });

  it('the hot load is the share of the weight: base vertical reaction + hot = total weight (statics, 1e-6)', () => {
    const scene = frame();
    const doc = select(withTable(scene, ['S3']), scene).document;
    const data = analyzed(doc, scene.id, { include: ['reactions', 'geometry'], cases: ['SUS', 'OPE'] });
    const spring = (doc.plant?.stress?.models[scene.id]?.springs ?? [])[0];
    const base = reaction(data, 'OPE', 'N1');
    // in OPE the spring carries exactly P_hot; the base carries the rest of the weight
    expectRel((base.forceN[2] as number) + (spring?.hotLoadN as number), w * (H + L), 1e-6, 'total weight');
  });

  it('the preloaded spring carries exactly the hot load in OPE and P_hot + k d / (1 + k / k_t) in SUS (k_t = tip stiffness of the frame)', () => {
    const scene = frame();
    const result = select(withTable(scene, ['S3']), scene);
    const [spring] = springsOf(result) as [SpringRow];
    expect(Math.abs(spring.residualPct)).toBeLessThan(1e-5);
    expectRel(spring.operatingLoadN, spring.hotLoadN, 1e-7, 'operating load');
    const data = analyzed(result.document, scene.id, { include: ['reactions', 'geometry'] });
    const tip = tipNode(data);
    expectRel(reaction(data, 'OPE', tip).forceN[2] as number, spring.hotLoadN, 1e-7, 'OPE spring load');
    // tip stiffness of the frame without the spring: a 1000 N upward point load
    const free = frame();
    const probe = apply(
      cases(
        free.doc,
        free.id,
        [{ name: 'P', type: 'SUS', basic: ['F1'] }],
        [{ name: 'F1', pipeId: free.pipe, atMm: H + L, forceN: [0, 0, 1000] }],
      ),
      'set_stress_load_cases',
      {
        modelId: free.id,
        cases: [{ name: 'P', type: 'SUS', basic: ['F1'] }],
        forces: [{ name: 'F1', pipeId: free.pipe, atMm: H + L, forceN: [0, 0, 1000] }],
      },
    );
    const freeData = analyzed(probe, free.id, { include: ['displacements', 'geometry'] });
    const uz = freeData.details?.displacements?.find((entry) => entry.case === 'P' && entry.node === tipNode(freeData))?.uMm[2] as number;
    const kt = 1000 / uz;
    const k = 5;
    expectRel(
      reaction(data, 'SUS', tip).forceN[2] as number,
      spring.hotLoadN + (k * spring.travelUpMm) / (1 + k / kt),
      1e-5,
      'SUS spring load',
    );
  });

  it('a hanger support at the tip is replaced by the spring: the rigid rest held the tip in OPE (load 406.8 N, not P_hot), the spring carries P_hot', () => {
    const scene = frame();
    const hanger = apply(scene.doc, 'add_pipe_support', { pipeId: scene.pipe, at: [[L, 0, H]], type: 'hanger' });
    const supportId = Object.values(hanger.building?.elements ?? {}).find((element) => element.category === 'pipeSupport')?.id as string;
    const before = analyzed(hanger, scene.id);
    const rest = before.cases.find((entry) => entry.name === 'OPE')?.contacts.find((contact) => contact.sources.includes(supportId));
    expect(rest?.status).toBe('active');
    const table = apply(hanger, 'import_spring_table', {
      modelId: scene.id,
      tableId: 'T',
      source: 'test catalogue 2026',
      sizes: [TABLE.S3],
    });
    const result = execute(table, 'select_spring_hangers', { modelId: scene.id, hangers: [{ supportId }], tableId: 'T' });
    expect(result.rejected).toBeUndefined();
    const after = analyzed(result.document, scene.id);
    expect(after.cases.flatMap((entry) => entry.contacts).filter((contact) => contact.sources.includes(supportId))).toEqual([]);
    // the rest carries the weight share minus what the riser growth takes (a rigid prop): not the hot load
    expect(Math.abs((rest?.normalForceN as number) - (springsOf(result)[0]?.hotLoadN as number))).toBeGreaterThan(10);
    expectRel(springsOf(result)[0]?.operatingLoadN as number, springsOf(result)[0]?.hotLoadN as number, 1e-7, 'operating load');
  });

  it('with no variable size that fits, a constant-effort hanger of load P_hot carries P_hot in every case; the fallback can be refused', () => {
    const scene = frame();
    const doc = withTable(scene, ['S1']);
    const result = select(doc, scene);
    const [spring] = springsOf(result) as [SpringRow];
    expect(spring.kind).toBe('constant');
    expect(spring.coldLoadN).toBe(spring.hotLoadN);
    expect((result.data as { warnings: { code: string }[] }).warnings.map((warning) => warning.code)).toContain(
      'PST_SPRING_CONSTANT_EFFORT',
    );
    const data = analyzed(result.document, scene.id, { include: ['reactions', 'geometry'] });
    const tip = tipNode(data);
    expectRel(reaction(data, 'SUS', tip).forceN[2] as number, spring.hotLoadN, 1e-7, 'SUS');
    expectRel(reaction(data, 'OPE', tip).forceN[2] as number, spring.hotLoadN, 1e-7, 'OPE');
    expectRefusal(
      doc,
      'select_spring_hangers',
      { modelId: scene.id, hangers: [scene.tip], tableId: 'T', constantEffortFallback: false },
      'PST_SPRING_NO_SIZE',
    );
    // sizes that hold the load and travel but vary 66 %
    const varying = withTable(scene, ['S0']);
    expectRefusal(
      varying,
      'select_spring_hangers',
      { modelId: scene.id, hangers: [scene.tip], tableId: 'T', constantEffortFallback: false },
      'PST_SPRING_VARIABILITY',
    );
    expect(select(varying, scene, { constantEffortFallback: false, maxVariability: 0.9 }).rejected).toBeUndefined();
  });

  it('selecting again at the same place replaces the spring (same id); delete_spring_hanger removes it and the rest acts again', () => {
    const scene = frame();
    const doc = withTable(scene, ['S3', 'S4']);
    const first = select(doc, scene);
    const second = select(first.document, scene, { maxVariability: 0.05 });
    expect(springsOf(second)[0]?.id).toBe(springsOf(first)[0]?.id);
    expect(springsOf(second)[0]?.size).toBe('S4');
    expect(second.document.plant?.stress?.models[scene.id]?.springs).toHaveLength(1);
    const removed = apply(second.document, 'delete_spring_hanger', { modelId: scene.id, springId: springsOf(second)[0]?.id as string });
    expect(removed.plant?.stress?.models[scene.id]?.springs).toEqual([]);
    expectRefusal(removed, 'delete_spring_hanger', { modelId: scene.id, springId: 'nope' }, 'PST_SPRING_NOT_FOUND');
  });

  it('two hangers are designed together: each OPE load is its own hot load and base + hot loads carry the whole weight', () => {
    const scene = frame();
    const doc = withTable(scene, ['S3', 'S4']);
    const result = execute(doc, 'select_spring_hangers', {
      modelId: scene.id,
      hangers: [
        { pipeId: scene.pipe, atMm: H + L / 2 },
        { pipeId: scene.pipe, atMm: H + L },
      ],
      tableId: 'T',
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const rows = springsOf(result);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Math.abs(row.residualPct)).toBeLessThan(1e-5);
    const data = analyzed(result.document, scene.id, { include: ['reactions'] });
    const base = reaction(data, 'OPE', 'N1').forceN[2] as number;
    expectRel(base + (rows[0] as SpringRow).hotLoadN + (rows[1] as SpringRow).hotLoadN, w * (H + L), 1e-6, 'total weight');
    // the mid-span hanger takes the larger share of a uniformly loaded leg
    expect((rows[0] as SpringRow).hotLoadN).toBeGreaterThan((rows[1] as SpringRow).hotLoadN);
  });

  it('is pure and an approval is dropped by a selection', () => {
    const scene = frame();
    const doc = withTable(scene, ['S3']);
    const before = JSON.stringify(doc);
    select(doc, scene);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('refusals', () => {
  it('table, conditions, cases, places and loads', () => {
    const scene = frame();
    const doc = withTable(scene, ['S3']);
    expectRefusal(
      scene.doc,
      'select_spring_hangers',
      { modelId: scene.id, hangers: [scene.tip], tableId: 'T' },
      'PST_SPRING_TABLE_MISSING',
    );
    expectRefusal(doc, 'select_spring_hangers', { modelId: 'nope', hangers: [scene.tip], tableId: 'T' }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(
      doc,
      'select_spring_hangers',
      { modelId: scene.id, hangers: [{ supportId: 'nope' }], tableId: 'T' },
      'PST_SUPPORT_NOT_FOUND',
    );
    expectRefusal(
      doc,
      'select_spring_hangers',
      { modelId: scene.id, hangers: [{ pipeId: 'nope', atMm: 1 }], tableId: 'T' },
      'PST_POINT_OFF_PIPE',
    );
    expectRefusal(doc, 'select_spring_hangers', { modelId: scene.id, hangers: [scene.tip, scene.tip], tableId: 'T' }, 'PST_PARAM_INVALID');
    expectRefusal(
      doc,
      'select_spring_hangers',
      { modelId: scene.id, hangers: [scene.tip], tableId: 'T', operatingCase: 'SUS' },
      'PST_LOADCASE_INVALID',
    );
    // a hanger on the anchor is no hanger point
    expectRefusal(
      doc,
      'select_spring_hangers',
      { modelId: scene.id, hangers: [{ pipeId: scene.pipe, atMm: 0 }], tableId: 'T' },
      'PST_PARAM_INVALID',
    );
    // no OPE case, OPE without weight, no conditions
    const noOpe = cases(doc, scene.id, [{ name: 'SUS', type: 'SUS', basic: ['W'] }]);
    expectRefusal(noOpe, 'select_spring_hangers', { modelId: scene.id, hangers: [scene.tip], tableId: 'T' }, 'PST_LOADCASE_INVALID');
    const noWeight = cases(doc, scene.id, [{ name: 'OPE', type: 'OPE', basic: ['T1'] }]);
    expectRefusal(noWeight, 'select_spring_hangers', { modelId: scene.id, hangers: [scene.tip], tableId: 'T' }, 'PST_LOADCASE_INVALID');
  });

  it('a model without conditions is PST_CONDITIONS_MISSING', () => {
    const pipe = withPipe(
      baseDoc(),
      [
        [0, 0, 0],
        [L, 0, 0],
      ],
      od,
    );
    const model = withModel(pipe.doc, [pipe.id]);
    const doc = apply(model.doc, 'import_spring_table', {
      modelId: model.id,
      tableId: 'T',
      source: 'test catalogue 2026',
      sizes: [TABLE.S3],
    });
    expectRefusal(
      doc,
      'select_spring_hangers',
      { modelId: model.id, hangers: [{ pipeId: pipe.id, atMm: L }], tableId: 'T' },
      'PST_CONDITIONS_MISSING',
    );
  });
});

describe('import_spring_table', () => {
  it('stores a table and replaces one of the same id; refuses an empty load range, a duplicate size and an unknown model', () => {
    const scene = frame();
    const first = withTable(scene, ['S2']);
    expect(first.plant?.stress?.models[scene.id]?.springTables).toHaveLength(1);
    const second = withTable({ ...scene, doc: first }, ['S2', 'S3']);
    expect(second.plant?.stress?.models[scene.id]?.springTables).toHaveLength(1);
    expect(second.plant?.stress?.models[scene.id]?.springTables[0]?.sizes).toHaveLength(2);
    const bad = (sizes: unknown[]): unknown => ({ modelId: scene.id, tableId: 'X', source: 'cat', sizes });
    expectRefusal(scene.doc, 'import_spring_table', bad([{ ...TABLE.S2, minN: 600, maxN: 300 }]), 'PST_TABLE_INVALID');
    expectRefusal(scene.doc, 'import_spring_table', bad([TABLE.S2, TABLE.S2]), 'PST_TABLE_INVALID');
    expectRefusal(scene.doc, 'import_spring_table', bad([]), 'CMD_INVALID_PARAMS');
    expectRefusal(scene.doc, 'import_spring_table', { ...(bad([TABLE.S2]) as object), modelId: 'nope' }, 'PST_MODEL_NOT_FOUND');
  });
});
