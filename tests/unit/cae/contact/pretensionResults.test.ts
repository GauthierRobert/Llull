/** PHY-06 M3 bolt results (FR-CNT-03/04, TR-CNT-10): section force / shear / bending / torsion from the frd stress, bolt shortening, clamp-zone separation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import { caseOf, withCase } from '@cae/shared/access';
import { sectionItems } from '@cae/contact/check';
import { must } from './support';
import { bolted, boltedMesh, contactBlock, frdBlock, frdSet, sectionParams, solveBolted, stressBlock, type Bolted } from './boltSupport';

const dataOf = (result: {
  data?: unknown;
}): { bolts: Record<string, number | null>[]; clamp: Record<string, unknown>[]; separated: Record<string, unknown>[] } =>
  result.data as { bolts: Record<string, number | null>[]; clamp: Record<string, unknown>[]; separated: Record<string, unknown>[] };

const DAT: FeResultsArtifact['dat'] = {
  tables: [{ title: 'displacements (vx,vy,vz) for set PTN_1 and time 0.1000000E+01', time: 1, rows: [[33, 0.02, 0, 0]] }],
};

/** Sections and results of a bolt at mid-height with `tensor(x, y, z)` as the nodal stress of the single preload increment. */
function solvedBar(
  tensor: (x: number, y: number, z: number) => readonly number[],
  preload = 10,
): ReturnType<typeof solveBolted> & { b: Bolted } {
  const b = bolted();
  const added = must(b.doc, 'add_bolt_pretension', sectionParams(b, { preload: { kind: 'force', value: preload } }));
  return { ...solveBolted(b, added.doc, frdSet(1, 1, [stressBlock(tensor)]), DAT), b };
}

describe('contact_report bolts', () => {
  it('integrates a uniform axial stress over the cut: N = sigma A, no shear, bending or torsion, shortening from the reference node, pure, no pair needed', () => {
    const { doc, ctx, b } = solvedBar(() => [0, 0, 10, 0, 0, 0]);
    const before = structuredClone(doc);
    const result = execute(doc, 'contact_report', { analysisId: b.analysisId }, ctx);
    expect(result.error).toBeUndefined();
    expect(doc).toEqual(before);
    expect(result.affected).toEqual([]);
    const [row] = dataOf(result).bolts;
    expect(row?.['axialForce']).toBeCloseTo(10, 10);
    expect(row?.['shearForce']).toBeCloseTo(0, 10);
    expect(row?.['bendingMoment']).toBeCloseTo(0, 10);
    expect(row?.['torsion']).toBeCloseTo(0, 10);
    expect(row).toMatchObject({ preload: 10, shortening: 0.02, facesUsed: 2, faces: 2, solverStep: 1 });
    expect(result.summary).toContain('N 10 N');
    expect(result.summary).toContain('not approved');
    expect((result.data as { rows: unknown[] }).rows).toEqual([]);
  });

  it('averages the low-side and high-side (duplicate node) stress of the cut: 8 below and 12 above give N = 10', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const tensor = (value: number): number[] => [0, 0, value, 0, 0, 0];
    const block = frdBlock('STRESS', ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], {
      9: tensor(8),
      10: tensor(8),
      11: tensor(8),
      12: tensor(8),
      29: tensor(12),
      30: tensor(12),
      31: tensor(12),
      32: tensor(12),
    });
    const { doc, ctx } = solveBolted(b, added.doc, frdSet(1, 1, [block]));
    const [row] = dataOf(execute(doc, 'contact_report', { analysisId: b.analysisId }, ctx)).bolts;
    expect(row?.['axialForce']).toBeCloseTo(10, 10);
  });

  it('a linear stress gives the exact bending moment (edge-midpoint rule): sigma = 12 (x - 0.5) -> |M| = E I-style 12 / 12 = 1, no axial force', () => {
    const { doc, ctx, b } = solvedBar((x) => [0, 0, 12 * (x - 0.5), 0, 0, 0]);
    const [row] = dataOf(execute(doc, 'contact_report', { analysisId: b.analysisId }, ctx)).bolts;
    expect(row?.['axialForce']).toBeCloseTo(0, 10);
    expect(row?.['bendingMoment']).toBeCloseTo(1, 10);
    expect(row?.['torsion']).toBeCloseTo(0, 10);
  });

  it('transverse shear 3 gives V = 3, a swirl tau (x - .5, -(y - .5)) gives torsion tau / 6', () => {
    const shear = solvedBar(() => [0, 0, 0, 0, 0, 3]);
    const [one] = dataOf(execute(shear.doc, 'contact_report', { analysisId: shear.b.analysisId }, shear.ctx)).bolts;
    expect(one?.['shearForce']).toBeCloseTo(3, 10);
    expect(one?.['axialForce']).toBeCloseTo(0, 10);
    const swirl = solvedBar((x, y) => [0, 0, 0, 0, 6 * (x - 0.5), -6 * (y - 0.5)]);
    const [two] = dataOf(execute(swirl.doc, 'contact_report', { analysisId: swirl.b.analysisId }, swirl.ctx)).bolts;
    expect(Math.abs(two?.['torsion'] ?? 0)).toBeCloseTo(1, 10);
    expect(two?.['bendingMoment']).toBeCloseTo(0, 10);
  });

  it('reports every stored increment with increments all, and filters by step; refuses an unknown pair on a case without pairs', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const frd = [frdSet(1, 0.5, [stressBlock(() => [0, 0, 5, 0, 0, 0])]), frdSet(1, 1, [stressBlock(() => [0, 0, 10, 0, 0, 0])], 2)].join(
      '\n',
    );
    const { doc, ctx } = solveBolted(b, added.doc, frd);
    const all = dataOf(execute(doc, 'contact_report', { analysisId: b.analysisId, increments: 'all' }, ctx));
    expect(all.bolts.map((row) => row['axialForce'])).toEqual([expect.closeTo(5, 10), expect.closeTo(10, 10)]);
    expect(all.bolts.map((row) => row['shortening'])).toEqual([null, null]);
    expect(dataOf(execute(doc, 'contact_report', { analysisId: b.analysisId, step: 'preload' }, ctx)).bolts).toHaveLength(1);
    const pair = execute(doc, 'contact_report', { analysisId: b.analysisId, pair: 'x' }, ctx);
    expect(pair.error?.code).toBe('CNT_PAIR_NOT_FOUND');
  });

  it('refuses a case with neither pairs nor bolts (CNT_PAIR_NOT_FOUND)', () => {
    const b = bolted();
    expect(execute(b.doc, 'contact_report', { analysisId: b.analysisId }).error?.code).toBe('CNT_PAIR_NOT_FOUND');
  });
});

describe('check_contact bolts', () => {
  const codes = (result: { data?: unknown }): string[] => (result.data as { items: { code: string }[] }).items.map((entry) => entry.code);

  it('passes a preload step whose section force equals the preload; warns CNT_PRELOAD_MISMATCH when it differs by more than 5 %, or without stress', () => {
    const good = solvedBar(() => [0, 0, 10.2, 0, 0, 0]);
    expect(codes(execute(good.doc, 'check_contact', { analysisId: good.b.analysisId }, good.ctx))).not.toContain('CNT_PRELOAD_MISMATCH');
    const off = solvedBar(() => [0, 0, 8, 0, 0, 0]);
    const result = execute(off.doc, 'check_contact', { analysisId: off.b.analysisId }, off.ctx);
    expect(codes(result)).toContain('CNT_PRELOAD_MISMATCH');
    expect((result.data as { status: string }).status).toBe('warn');
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const bare = solveBolted(b, added.doc, frdSet(1, 1, [stressBlock(() => [0, 0, 10, 0, 0, 0], [1])]));
    const none = execute(bare.doc, 'check_contact', { analysisId: b.analysisId }, bare.ctx);
    expect(
      (none.data as { items: { code: string; message: string }[] }).items.find((entry) => entry.code === 'CNT_PRELOAD_MISMATCH')?.message,
    ).toContain('no stress');
  });

  it('flags a stored bolt that no longer fits the case (set-up item), and a cut that touches a constraint node on the current mesh', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const analysis = caseOf(added.doc, b.analysisId);
    const boltId = added.affected[1] ?? '';
    const bolt = analysis?.pretension?.bolts[boltId];
    if (analysis === undefined || bolt === undefined) throw new Error('no bolt');
    const stale = withCase(added.doc, {
      ...analysis,
      pretension: { order: [boltId], bolts: { [boltId]: { ...bolt, preloadStepId: 'gone' } } },
    });
    const result = execute(stale, 'check_contact', { analysisId: b.analysisId });
    expect((result.data as { items: { code: string; severity: string }[] }).items).toContainEqual(
      expect.objectContaining({ code: 'CNT_STEP_UNKNOWN', severity: 'error' }),
    );
    const mesh = boltedMesh(b, added.doc);
    expect(sectionItems(added.doc, analysis, mesh)).toEqual([]);
    const touched = sectionItems(added.doc, analysis, { ...mesh, nodeSets: { ...mesh.nodeSets, [`C_${b.bottomId}`]: [1, 2, 3, 4, 9] } });
    expect(touched).toMatchObject([{ code: 'CNT_PRETENSION_SECTION_INVALID', severity: 'error', ids: [boltId] }]);
  });
});

describe('separation (clamp zone of the pairs around a bolt)', () => {
  /** Bolt + plate with a pair; the preload step has two increments, a second step follows; `pressures` are the CPRESS of the four increments. */
  function joint(pressures: readonly [number, number, number]): {
    doc: ReturnType<typeof solveBolted>['doc'];
    ctx: ReturnType<typeof solveBolted>['ctx'];
    b: Bolted;
    second: string;
    boltId: string;
  } {
    const base = bolted({ pair: true });
    const second = must(base.doc, 'add_analysis_step', {
      analysisId: base.analysisId,
      name: 'service',
      multipliers: {},
      control: { kind: 'load', initialIncrement: 0.5, minIncrement: 0.001, maxIncrement: 0.5, maxIncrements: 20 },
    });
    const b: Bolted = { ...base, doc: second.doc };
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const stress = stressBlock(() => [0, 0, 10, 0, 0, 0]);
    const frd = [
      frdSet(1, 0.5, [stress, contactBlock(0)]),
      frdSet(1, 1, [stress, contactBlock(pressures[0])], 2),
      frdSet(2, 2, [stress, contactBlock(pressures[1])]),
      frdSet(2, 3, [stress, contactBlock(pressures[2])], 2),
    ].join('\n');
    return { ...solveBolted(b, added.doc, frd), b, second: second.affected[0] ?? '', boltId: added.affected[1] ?? '' };
  }

  it('a clamp zone that is closed at the end of the preload step and stays closed does not separate (the open first increment is ignored); the closure is reported per step', () => {
    const { doc, ctx, b } = joint([5, 5, 5]);
    const data = dataOf(execute(doc, 'contact_report', { analysisId: b.analysisId }, ctx));
    expect(data.separated).toEqual([]);
    expect(data.clamp.map((row) => row['closedFraction'])).toEqual([1, 1]);
    expect(data.clamp.map((row) => row['stepId'])).toEqual([b.stepId, expect.any(String)]);
    const check = execute(doc, 'check_contact', { analysisId: b.analysisId }, ctx);
    expect((check.data as { items: { code: string }[] }).items.map((entry) => entry.code)).not.toContain('CNT_SEPARATED');
  });

  it('reports the first increment of the later step in which the whole zone is open, and check_contact fails with CNT_SEPARATED', () => {
    const { doc, ctx, b, second, boltId } = joint([5, 5, 0]);
    const data = dataOf(execute(doc, 'contact_report', { analysisId: b.analysisId, increments: 'all' }, ctx));
    expect(data.separated).toEqual([{ pretensionId: boltId, pairId: b.pairId, stepId: second, solverStep: 2, time: 3 }]);
    const check = execute(doc, 'check_contact', { analysisId: b.analysisId }, ctx);
    const items = (check.data as { items: { code: string; severity: string }[]; status: string }).items;
    expect(items.find((entry) => entry.code === 'CNT_SEPARATED')).toMatchObject({ severity: 'fail' });
    expect((check.data as { status: string }).status).toBe('fail');
    expect(check.summary).toContain('CNT_SEPARATED');
  });

  it('a joint that is open at the end of the preload step never clamped: separated in the preload step (last increment)', () => {
    const { doc, ctx, b } = joint([0, 5, 5]);
    const data = dataOf(execute(doc, 'contact_report', { analysisId: b.analysisId }, ctx));
    expect(data.separated).toMatchObject([{ stepId: b.stepId, time: 1 }]);
  });
});

describe('bolt readout cross-checks and cut nodes', () => {
  const stress = (value: number): number[] => [0, 0, value, 0, 0, 0];
  const labels = ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'];

  it('reads the equation force of the duplicate nodes as an independent cross-check: reactionForce = -(sum RF) . n', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const dat: FeResultsArtifact['dat'] = {
      tables: [{ title: 'total force (fx,fy,fz) for set PTD_1 and time 0.1000000E+01', time: 1, rows: [[22.2, 22.2, -10]] }],
    };
    const { doc, ctx } = solveBolted(b, added.doc, frdSet(1, 1, [stressBlock(() => stress(10))]), dat);
    const [row] = dataOf(execute(doc, 'contact_report', { analysisId: b.analysisId }, ctx)).bolts;
    expect(row?.['reactionForce']).toBeCloseTo(10, 12);
    const bare = solveBolted(b, added.doc, frdSet(1, 1, [stressBlock(() => stress(10))]));
    expect(dataOf(execute(bare.doc, 'contact_report', { analysisId: b.analysisId }, bare.ctx)).bolts[0]?.['reactionForce']).toBeNull();
  });

  it('no stress on any section face is an error, stress on only some faces is a warning with the counts', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const none = solveBolted(b, added.doc, frdSet(1, 1, [stressBlock(() => stress(10), [1])]));
    const empty = (
      execute(none.doc, 'check_contact', { analysisId: b.analysisId }, none.ctx).data as { items: { code: string; severity: string }[] }
    ).items;
    expect(empty.find((entry) => entry.code === 'CNT_PRELOAD_MISMATCH')?.severity).toBe('error');
    const some = solveBolted(b, added.doc, frdSet(1, 1, [stressBlock(() => stress(10), [9, 11, 12])]));
    const result = execute(some.doc, 'check_contact', { analysisId: b.analysisId }, some.ctx);
    const items = (result.data as { items: { code: string; severity: string; message: string }[] }).items;
    expect(items.find((entry) => entry.message.includes('of 2 section faces only'))?.severity).toBe('warning');
  });

  it('a node on the cut reads the low-side copy; the duplicates are no mesh nodes and stay out of the statistics', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const values: Record<number, readonly number[]> = {};
    for (let node = 1; node <= 28; node++) values[node] = stress(8);
    for (const node of [29, 30, 31, 32]) values[node] = stress(12);
    const { doc, ctx } = solveBolted(b, added.doc, frdSet(1, 1, [frdBlock('STRESS', labels, values)]));
    const result = execute(doc, 'fea_result_field', { analysisId: b.analysisId, field: 'von_mises', nodes: [9, 29] }, ctx);
    expect(result.error).toBeUndefined();
    const data = result.data as { count: number; max: { value: number }; rows: { node: number; value: number }[]; missingNodes: number[] };
    expect(data.rows).toEqual([expect.objectContaining({ node: 9, value: expect.closeTo(8, 10) })]);
    expect(data.missingNodes).toEqual([29]);
    expect(data.count).toBe(28);
    expect(data.max.value).toBeCloseTo(8, 10);
  });
});
