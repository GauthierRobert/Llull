/** Time histories through the run: the job data, histories.json into the artifact, the summary flags and the explicit_time_history query (EXP-TH). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExplicitResultsSummary, FeExplicitArtifact } from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import { historyUnit, jobTimeHistories } from '@cae/explicit/historyJob';
import type { ExplicitMesh } from '@cae/explicit/mesh';
import type { ExplicitSpec } from '@core/model/explicit';
import { buildExplicitArtifact, buildExplicitJob, type ExplicitJob } from '@cae/index';
import { artifactStore, barModel, code, contextWith, data, must } from './support';

const bar = barModel({ size: 5 });

function withHistories(): { doc: CadDocument; ids: string[] } {
  let doc = bar.doc;
  const ids: string[] = [];
  const add = (params: Record<string, unknown>): void => {
    const added = must(doc, 'add_time_history', { analysisId: bar.analysisId, ...params });
    doc = added.document;
    ids.push(added.affected[1] ?? '');
  };
  add({
    name: 'top',
    kind: 'node',
    target: { entityId: bar.barId, facesNear: [[5, 5, 200]] },
    quantities: ['velocity', 'displacement'],
    intervalS: 2e-6,
  });
  add({ name: 'bar', kind: 'part', partId: bar.barId, quantities: ['kinetic_energy', 'momentum'] });
  add({ name: 'anvil', kind: 'rigid_wall', wallId: bar.wallId, quantities: ['normal_impulse'] });
  return { doc, ids };
}

const jobOf = (doc: CadDocument): ExplicitJob => {
  const built = buildExplicitJob(doc, bar.analysisId, null);
  if (!built.ok) throw new Error(built.message);
  return built.job;
};

/** A synthetic histories.json answering every request of the job except the quantities in `skip` (name:quantity). */
function historiesText(
  job: ExplicitJob,
  skip: readonly string[] = [],
  tweak: (series: Record<string, unknown>) => void = () => undefined,
): string {
  const series = job.timeHistories.flatMap((request) =>
    request.quantities
      .filter((quantity) => !skip.includes(`${request.name}:${quantity}`))
      .map((quantity) => {
        const components = ['velocity', 'displacement', 'momentum'].includes(quantity) ? 3 : 1;
        const times = [0, 1, 2, 3, 4].map((k) => k * (request.interval ?? 1e-6));
        const entry: Record<string, unknown> = {
          name: request.name,
          quantity,
          components,
          times,
          values: times.flatMap((_, k) => Array.from({ length: components }, (__, i) => (i === 2 ? -k : 0.5 * k))),
        };
        tweak(entry);
        return entry;
      }),
  );
  return JSON.stringify({ version: 1, series });
}

function resultText(): { text: string; fields: Float64Array; job: ExplicitJob } {
  const { doc } = withHistories();
  const job = jobOf(doc);
  const elements = job.mesh.hex8.length / 8;
  return {
    job,
    fields: new Float64Array(7 * elements),
    text: JSON.stringify({
      version: 1,
      termination: 'normal',
      message: '',
      cycles: 5,
      finalTime: 1.6e-4,
      minTimeStep: 3e-7,
      initialMass: 1.57e-4,
      addedMass: 0,
      device: 'cpu',
      deterministic: true,
      energy: [
        [0, 7.85, 0, 0, 0, 0, 0],
        [1.6e-4, 7.85, 0, 0, 0, 0, 0],
      ],
      walls: [{ name: 'anvil', t: [1e-6], force: [1] }],
    }),
  };
}

describe('job data of the requested histories', () => {
  const { doc, ids } = withHistories();
  const job = jobOf(doc);

  it('resolves node targets to mesh nodes, parts and walls to indices, in request order', () => {
    expect(job.timeHistories.map((request) => request.id)).toEqual(ids);
    const top = job.timeHistories[0];
    expect(top?.kind).toBe('node');
    // the 3 x 3 nodes of the z = 200 face of the 5 mm grid, all at z = 200
    expect(top?.nodes).toHaveLength(9);
    expect(top?.nodes?.every((node) => job.mesh.nodes[3 * node + 2] === 200)).toBe(true);
    expect(top?.interval).toBe(2e-6);
    expect(job.timeHistories[1]).toMatchObject({ kind: 'part', part: 0, quantities: ['kinetic_energy', 'momentum'] });
    expect(job.timeHistories[1]?.interval).toBeUndefined();
    expect(job.timeHistories[2]).toMatchObject({ kind: 'rigid_wall', wall: 0 });
  });

  it('refuses a history whose wall or part left the case, and a part meshed as shells', () => {
    const noWall = must(doc, 'delete_analysis_item', { analysisId: bar.analysisId, itemId: bar.wallId }).document;
    // deleting the wall also drops its histories: the job builds without them
    expect(jobOf(noWall).timeHistories.map((request) => request.kind)).toEqual(['node', 'part']);
    const orphan = structuredClone(doc);
    const spec = orphan.analysis?.cases[bar.analysisId]?.explicit;
    if (spec === undefined) throw new Error('no spec');
    const wallHistory = Object.values(spec.timeHistories ?? {}).find((history) => history.kind === 'rigid_wall');
    if (wallHistory === undefined) throw new Error('no wall history');
    (wallHistory as { wallId: string }).wallId = 'rw-404';
    expect(buildExplicitJob(orphan, bar.analysisId, null)).toMatchObject({ ok: false, code: 'EXP_TIME_HISTORY_INVALID' });
    const noPart = structuredClone(doc);
    const partHistory = Object.values(noPart.analysis?.cases[bar.analysisId]?.explicit?.timeHistories ?? {}).find(
      (history) => history.kind === 'part',
    );
    if (partHistory === undefined) throw new Error('no part history');
    (partHistory as { target: { entityId: string } }).target = { entityId: 'ghost' };
    expect(buildExplicitJob(noPart, bar.analysisId, null)).toMatchObject({ ok: false, code: 'EXP_TIME_HISTORY_INVALID' });
    const shelled = structuredClone(doc);
    const shelledSpec = shelled.analysis?.cases[bar.analysisId]?.explicit;
    if (shelledSpec === undefined) throw new Error('no spec');
    (shelledSpec as { shells?: Record<string, { points: number }> }).shells = { [bar.barId]: { points: 2 } };
    expect(buildExplicitJob(shelled, bar.analysisId, null)).toMatchObject({ ok: false });
  });

  it('refuses a node target that selects nothing', () => {
    const empty = structuredClone(doc);
    const nodeHistory = Object.values(empty.analysis?.cases[bar.analysisId]?.explicit?.timeHistories ?? {}).find(
      (history) => history.kind === 'node',
    );
    if (nodeHistory === undefined) throw new Error('no node history');
    (nodeHistory as { target: { entityId: string } }).target = { entityId: 'ghost' };
    expect(buildExplicitJob(empty, bar.analysisId, null)).toMatchObject({ ok: false, code: 'EXP_TIME_HISTORY_INVALID' });
  });
});

describe('artifact, summary and explicit_time_history', () => {
  const { doc } = withHistories();
  const run = resultText();
  const build = (text: string | null): FeExplicitArtifact => {
    const artifact = buildExplicitArtifact(run.job, run.text, run.fields, '0.1.0', text);
    if (typeof artifact === 'string') throw new Error(artifact);
    return artifact;
  };
  const record = (artifact: FeExplicitArtifact): { doc: CadDocument; ctx: ReturnType<typeof contextWith> } => {
    const store = artifactStore();
    const hash = store.put(artifact);
    const ctx = contextWith(store.port);
    return { doc: must(doc, 'record_explicit_results', { analysisId: bar.analysisId, artifactHash: hash }, ctx).document, ctx };
  };

  it('keeps recorded series with units and a bounded summary', () => {
    const artifact = build(historiesText(run.job));
    expect(artifact.histories).toHaveLength(5);
    const velocity = artifact.histories?.find((series) => series.name === 'top' && series.quantity === 'velocity');
    expect(velocity).toMatchObject({ components: 3, unit: 'mm/s', id: run.job.timeHistories[0]?.id });
    expect(artifact.histories?.find((series) => series.quantity === 'normal_impulse')?.unit).toBe('N*s');
    expect(artifact.histories?.find((series) => series.quantity === 'kinetic_energy')?.unit).toBe('mJ');
    const { doc: recorded } = record(artifact);
    const summary = recorded.analysis?.cases[bar.analysisId]?.explicit?.results as ExplicitResultsSummary;
    const first = Object.values(summary.histories ?? {})[0];
    expect(first?.name).toBe('top');
    expect(first?.quantities[0]).toMatchObject({ quantity: 'velocity', status: 'recorded', samples: 5, peakAbs: 4 });
  });

  it('flags a requested quantity the solver did not record as EXP_TIME_HISTORY_NOT_RECORDED, never empty', () => {
    const artifact = build(historiesText(run.job, ['bar:momentum', 'anvil:normal_impulse']));
    const { doc: recorded, ctx } = record(artifact);
    const summary = recorded.analysis?.cases[bar.analysisId]?.explicit?.results as ExplicitResultsSummary;
    const flagged = Object.values(summary.histories ?? {}).flatMap((entry) =>
      entry.quantities
        .filter((quantity) => quantity.status === 'EXP_TIME_HISTORY_NOT_RECORDED')
        .map((quantity) => `${entry.name}:${quantity.quantity}`),
    );
    expect(flagged.sort()).toEqual(['anvil:normal_impulse', 'bar:momentum']);
    const wall = execute(recorded, 'explicit_time_history', { analysisId: bar.analysisId, history: 'anvil' }, ctx);
    expect(wall.summary).toContain('EXP_TIME_HISTORY_NOT_RECORDED: normal_impulse');
    const series = data<{ series: { status: string; t: number[]; total: number }[] }>(wall).series;
    expect(series[0]).toMatchObject({ status: 'EXP_TIME_HISTORY_NOT_RECORDED', total: 0, t: [] });
    // the whole file absent (a solver that records nothing): every request flagged
    const none = record(build(null));
    const all = Object.values((none.doc.analysis?.cases[bar.analysisId]?.explicit?.results as ExplicitResultsSummary).histories ?? {});
    expect(all.flatMap((entry) => entry.quantities).every((quantity) => quantity.status === 'EXP_TIME_HISTORY_NOT_RECORDED')).toBe(true);
  });

  it('reads a history paged, by id or name, vectors as [x, y, z] rows', () => {
    const { doc: recorded, ctx } = record(build(historiesText(run.job)));
    const id = run.job.timeHistories[0]?.id ?? '';
    const page = execute(
      recorded,
      'explicit_time_history',
      { analysisId: bar.analysisId, history: id, quantity: 'velocity', offset: 1, limit: 2 },
      ctx,
    );
    expect(page.rejected).toBeUndefined();
    const body = data<{
      state: string;
      series: { quantity: string; unit: string; total: number; offset: number; t: number[]; values: number[][] }[];
    }>(page);
    expect(body.state).toBe('solved');
    expect(body.series).toHaveLength(1);
    expect(body.series[0]).toMatchObject({ quantity: 'velocity', unit: 'mm/s', total: 5, offset: 1, t: [2e-6, 4e-6] });
    expect(body.series[0]?.values).toEqual([
      [0.5, 0.5, -1],
      [1, 1, -2],
    ]);
    expect(page.summary).toContain('5 sample(s)');
    const byName = execute(recorded, 'explicit_time_history', { analysisId: bar.analysisId, history: 'bar' }, ctx);
    expect(data<{ series: unknown[] }>(byName).series).toHaveLength(2);
    const scalar = execute(
      recorded,
      'explicit_time_history',
      { analysisId: bar.analysisId, history: 'bar', quantity: 'kinetic_energy' },
      ctx,
    );
    expect(data<{ series: { values: number[] }[] }>(scalar).series[0]?.values).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('is read-only, reports no series without a trusted run and refuses unknown ids / quantities', () => {
    const before = structuredClone(doc);
    const unsolved = execute(doc, 'explicit_time_history', { analysisId: bar.analysisId, history: 'top' });
    expect(doc).toEqual(before);
    expect(unsolved.document).toBe(doc);
    expect(data<{ state: string; series: unknown[] }>(unsolved)).toMatchObject({ state: 'unsolved', series: [] });
    const { doc: recorded, ctx } = record(build(historiesText(run.job)));
    const ask = (params: Record<string, unknown>): string | undefined =>
      code(execute(recorded, 'explicit_time_history', { analysisId: bar.analysisId, ...params }, ctx));
    expect(ask({ history: 'nope' })).toBe('EXP_TIME_HISTORY_NOT_FOUND');
    expect(ask({ history: 'top', quantity: 'mass' })).toBe('EXP_TIME_HISTORY_INVALID');
    expect(ask({ history: 'top', analysisId: 'an-404' })).toBe('FEA_ANALYSIS_NOT_FOUND');
    expect(ask({ history: 'top', limit: 0 })).toBe('CMD_INVALID_PARAMS');
  });

  it('rejects a malformed histories.json', () => {
    const build2 = (text: string): string | FeExplicitArtifact => buildExplicitArtifact(run.job, run.text, run.fields, '1', text);
    expect(build2('nope')).toBe('histories.json is not JSON');
    expect(build2('{}')).toBe('histories.json has no series list');
    expect(build2(JSON.stringify({ series: [{ name: 3 }] }))).toContain('lacks name or quantity');
    expect(build2(historiesText(run.job, [], (series) => (series['components'] = 2)))).toContain('malformed');
    expect(build2(historiesText(run.job, [], (series) => (series['values'] = [1])))).toContain('malformed');
    expect(build2(historiesText(run.job, [], (series) => (series['times'] = [0, 0, 1, 2, 3])))).toContain('not increasing');
    expect(build2(historiesText(run.job, [], (series) => (series['name'] = 'ghost')))).toContain('was not requested');
  });
});

describe('historyUnit', () => {
  it('names the unit of every quantity in both supported unit systems', () => {
    const mm = { length: 'mm', energy: 'mJ' };
    const si = { length: 'm', energy: 'J' };
    const names = [
      'displacement',
      'velocity',
      'acceleration',
      'mass',
      'momentum',
      'normal_impulse',
      'normal_force',
      'kinetic_energy',
      'energy',
    ];
    expect(names.map((name) => historyUnit(name, mm))).toEqual(['mm', 'mm/s', 'mm/s^2', 't', 'N*s', 'N*s', 'N', 'mJ', 'mJ']);
    expect(names.map((name) => historyUnit(name, si))).toEqual(['m', 'm/s', 'm/s^2', 'kg', 'N*s', 'N*s', 'N', 'J', 'J']);
  });
});

describe('jobTimeHistories refusals', () => {
  const mesh: ExplicitMesh = {
    nodes: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
    hex8: [0, 1, 2, 3, 4, 5, 6, 7],
    tet4: [],
    shell4: [],
    shellThickness: [],
    elementPart: ['a'],
    nodePart: ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a'],
  };
  const specWith = (histories: ExplicitSpec['timeHistories'], extra: Partial<ExplicitSpec> = {}): ExplicitSpec =>
    ({
      rigidWallOrder: ['rw-1'],
      rigidWalls: {},
      timeHistories: histories,
      timeHistoryOrder: Object.keys(histories ?? {}),
      ...extra,
    }) as unknown as ExplicitSpec;
  const resolve = (histories: ExplicitSpec['timeHistories'], extra: Partial<ExplicitSpec> = {}): unknown =>
    jobTimeHistories(specWith(histories, extra), mesh, ['a'], 1);

  it('resolves a good request', () => {
    expect(
      resolve({
        't-1': { name: 'n', kind: 'node', target: { entityId: 'a', pointsNear: [[1, 1, 1]] }, quantities: ['velocity'] },
        't-2': { name: 'w', kind: 'rigid_wall', wallId: 'rw-1', quantities: ['energy'] },
      }),
    ).toMatchObject([{ nodes: [6] }, { wall: 0 }]);
  });

  it('refuses a shell part, a vanished part, a vanished wall, no target and a target that selects no node', () => {
    const refused = (histories: ExplicitSpec['timeHistories'], extra: Partial<ExplicitSpec> = {}): string =>
      String((resolve(histories, extra) as { code?: string; message?: string }).message);
    const part = { name: 'p', kind: 'part', target: { entityId: 'a' }, quantities: ['mass'] } as const;
    expect(refused({ 't-1': part }, { shells: { a: { points: 2 } } })).toContain('meshed as shells');
    expect(refused({ 't-1': { ...part, target: { entityId: 'gone' } } })).toContain('no longer a part');
    expect(refused({ 't-1': { name: 'w', kind: 'rigid_wall', wallId: 'rw-9', quantities: ['energy'] } })).toContain("rigid wall 'rw-9'");
    expect(refused({ 't-1': { name: 'n', kind: 'node', quantities: ['velocity'] } })).toContain('no target');
    expect(refused({ 't-1': { name: 'n', kind: 'node', target: { entityId: 'a' }, quantities: ['velocity'] } })).toContain(
      'selects no node',
    );
    expect(resolve({ 't-1': { ...part, target: { entityId: 'gone' } } })).toMatchObject({ code: 'EXP_TIME_HISTORY_INVALID', ids: ['t-1'] });
  });
});
