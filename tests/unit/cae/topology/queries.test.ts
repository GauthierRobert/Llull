/** suggest_rebuild, compare_to_topology and check_topology (TR-TOP-09..12, VC-TOP-21/22/23/25/26). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeTopologyArtifact } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { buildTopologyArtifact } from '@cae/index';
import { fieldBytes } from '@cae/topology/artifact';
import { artifactStore, code, contextWith, data, jobOf, mbbModel, solveAndRecord, studyOf } from './support';

type Loop = { points: number[][]; orientation: 'outer' | 'hole'; area: number; areaMm2: number };
type Rebuild = {
  plane: string;
  placement: { position: number[]; rotation: number[]; extrusion: string; depth: number | null };
  loops: Loop[];
  droppedLoops: number;
  enclosedFraction: number;
  widthSamples: unknown[];
};

describe('suggest_rebuild', () => {
  const model = mbbModel();
  const solved = solveAndRecord(model);
  const ctx = contextWith(solved.store.port);
  const suggest = (params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
    execute(solved.doc, 'suggest_rebuild', { studyId: model.studyId, ...params }, ctx);

  it('returns closed loops, outer counter-clockwise and holes clockwise, within VC-TOP-22 of the thresholded fraction', () => {
    const before = JSON.stringify(solved.doc);
    const result = suggest();
    expect(JSON.stringify(solved.doc)).toBe(before);
    expect(result.document).toBe(solved.doc);
    expect(result.affected).toEqual([]);
    const rebuild = data<Rebuild>(result);
    expect(rebuild.plane).toBe('XY');
    expect(rebuild.loops.length).toBeGreaterThanOrEqual(2);
    for (const loop of rebuild.loops) {
      const signed =
        loop.points.reduce(
          (sum, p, i) =>
            sum +
            (p[0] ?? 0) * (loop.points[(i + 1) % loop.points.length]?.[1] ?? 0) -
            (loop.points[(i + 1) % loop.points.length]?.[0] ?? 0) * (p[1] ?? 0),
          0,
        ) / 2;
      expect(loop.orientation === 'outer' ? signed > 0 : signed < 0).toBe(true);
      expect(Math.abs(Math.abs(signed) - loop.area)).toBeLessThan(1e-4);
      expect(loop.areaMm2).toBeCloseTo(loop.area, 5);
      expect(loop.points.length).toBeGreaterThanOrEqual(3);
    }
    expect(rebuild.loops.filter((loop) => loop.orientation === 'outer')).toHaveLength(1);
    const summary = studyOf(solved.doc, model.analysisId, model.studyId).result;
    const thresholdedFraction = (summary?.thresholdedVolume ?? 0) / (1200 * 1);
    expect(Math.abs(rebuild.enclosedFraction - thresholdedFraction)).toBeLessThanOrEqual(0.02);
    expect(rebuild.placement).toMatchObject({ position: [0, 0, 0], rotation: [0, 0, 0], extrusion: '+z', depth: 1 });
    expect(rebuild.widthSamples.length).toBeGreaterThan(0);
    expect(data(result)['concept']).toBe(true);
  });

  it('simplifies with the tolerance and drops loops below the minimum area, counting them', () => {
    const fine = data<Rebuild>(suggest({ tolerance: 0.01, minLoopArea: 0 }));
    const coarse = data<Rebuild>(suggest({ tolerance: 1.5, minLoopArea: 0 }));
    const count = (r: Rebuild): number => r.loops.reduce((sum, loop) => sum + loop.points.length, 0);
    expect(count(coarse)).toBeLessThan(count(fine));
    const big = data<Rebuild>(suggest({ minLoopArea: 1e6 }));
    expect(big.loops.length + big.droppedLoops).toBe(data<Rebuild>(suggest({ minLoopArea: 0 })).loops.length);
    expect(big.droppedLoops).toBeGreaterThan(0);
  });

  it('refuses unknown, unsolved, stale and untrusted studies and bad parameters', () => {
    expect(code(execute(solved.doc, 'suggest_rebuild', { studyId: 'ts-0.0' }, ctx))).toBe('TOP_STUDY_NOT_FOUND');
    expect(code(execute(model.doc, 'suggest_rebuild', { studyId: model.studyId }, ctx))).toBe('TOP_RESULT_MISSING');
    expect(code(execute(solved.doc, 'suggest_rebuild', { studyId: model.studyId }, contextWith(artifactStore().port)))).toBe(
      'TOP_RESULT_MISSING',
    );
    const stale = execute(solved.doc, 'set_topology_settings', { studyId: model.studyId, move: 0.3 }).document;
    expect(code(execute(stale, 'suggest_rebuild', { studyId: model.studyId }, ctx))).toBe('TOP_RESULT_STALE');
    const forged = contextWith({ get: (): FeTopologyArtifact => ({ ...solved.artifact, iterations: 1 }) });
    expect(code(execute(solved.doc, 'suggest_rebuild', { studyId: model.studyId }, forged))).toBe('TOP_SUMMARY_MISMATCH');
    expect(code(suggest({ tolerance: 0 }))).toBe('TOP_SETUP_INVALID');
    expect(code(suggest({ minLoopArea: -1 }))).toBe('TOP_SETUP_INVALID');
    expect(code(suggest({ plane: 'XZ' }))).toBe('TOP_SETUP_INVALID');
    expect(suggest({ plane: 'XY' }).rejected).toBeUndefined();
  });
});

describe('suggest_rebuild on a 3D field', () => {
  const model = mbbModel();
  const solid = execute(model.doc, 'add_box', { size: [8, 6, 4], position: [10, 0, 0], anchor: 'min' });
  const entityId = solid.affected[0] ?? '';
  const doc3 = (() => {
    let doc = execute(solid.document, 'assign_material', { materialName: 'topo_unit', entityIds: [entityId] }).document;
    const created = execute(doc, 'create_analysis', { name: 'cube', analysisType: 'static' });
    const analysisId = created.affected[0] ?? '';
    doc = execute(created.document, 'set_part_idealization', { analysisId, entityId, idealization: 'solid' }).document;
    doc = execute(doc, 'add_fea_constraint', {
      analysisId,
      name: 'fix',
      kind: 'fixed',
      target: { entityId, facesNear: [[10, 3, 2]] },
    }).document;
    doc = execute(doc, 'add_fea_load', {
      analysisId,
      name: 'push',
      kind: 'force',
      loadCase: 'LC1',
      category: 'limit',
      target: { entityId, facesNear: [[18, 3, 2]] },
      vector: [0, 0, -1],
    }).document;
    const study = execute(doc, 'create_topology_study', {
      analysisId,
      name: '3d',
      designDomain: [entityId],
      dimension: 3,
      voxel: 1,
      volumeFraction: 0.5,
    });
    return { doc: study.document, analysisId, studyId: study.affected[0] ?? '' };
  })();

  function recordField(field: (i: number, j: number, k: number) => number): { doc: CadDocument; ctx: ReturnType<typeof contextWith> } {
    const built = jobOf({ ...model, ...doc3, entityId });
    const values = Float32Array.from({ length: 8 * 6 * 4 }, (_, n) => field(n % 8, Math.floor(n / 8) % 6, Math.floor(n / 48)));
    const artifact = buildTopologyArtifact(
      built,
      fieldBytes(values),
      {
        compliance: 2,
        perLoadCase: { LC1: 2 },
        iterations: 7,
        status: 'converged',
        history: [],
        device: 'gpu',
        deterministic: false,
        version: 'native',
      },
      'topopt',
    ) as FeTopologyArtifact;
    const store = artifactStore();
    const hash = store.put(artifact);
    const result = execute(doc3.doc, 'record_topology_result', { studyId: doc3.studyId, fieldHash: hash }, contextWith(store.port));
    expect(result.rejected).toBeUndefined();
    return { doc: result.document, ctx: contextWith(store.port) };
  }

  it('derives the marching-tetrahedra surface and sections the field on a plane (default through the middle)', () => {
    const { doc, ctx } = recordField((i, j, k) => (i >= 2 && i <= 5 && j >= 1 && j <= 4 && k >= 1 && k <= 2 ? 1 : 0));
    const derived = doc.entities[studyOf(doc, doc3.analysisId, doc3.studyId).derivedEntityId ?? ''];
    expect(derived?.kind).toBe('mesh');
    const sectionXY = data<Rebuild>(execute(doc, 'suggest_rebuild', { studyId: doc3.studyId }, ctx));
    expect(sectionXY.plane).toBe('XY');
    expect(sectionXY.loops).toHaveLength(1);
    expect(sectionXY.placement.position).toEqual([0, 0, 2]);
    expect(sectionXY.placement.depth).toBeNull();
    const xs = (sectionXY.loops[0]?.points ?? []).map((p) => p[0] ?? 0);
    expect(Math.min(...xs)).toBeGreaterThan(11);
    expect(Math.max(...xs)).toBeLessThan(17);
    const xz = data<Rebuild>(
      execute(doc, 'suggest_rebuild', { studyId: doc3.studyId, plane: 'XZ', offset: 3, minLoopArea: 0, tolerance: 0.1 }, ctx),
    );
    expect(xz.placement.rotation[0]).toBeCloseTo(Math.PI / 2, 12);
    expect(xz.placement.position).toEqual([0, 3, 0]);
    expect(xz.loops).toHaveLength(1);
    const yz = data<Rebuild>(
      execute(doc, 'suggest_rebuild', { studyId: doc3.studyId, plane: 'YZ', offset: 13, minLoopArea: 0, tolerance: 0.1 }, ctx),
    );
    expect(yz.loops).toHaveLength(1);
    const mapped = applyEulerXYZ([1, 0, 0], [0, 0, 0], yz.placement.rotation as [number, number, number]);
    expect(mapped.map((v) => Math.round(v) + 0)).toEqual([0, 1, 0]);
    const along = applyEulerXYZ([0, 0, 1], [0, 0, 0], yz.placement.rotation as [number, number, number]);
    expect(along.map((v) => Math.round(v) + 0)).toEqual([1, 0, 0]);
    const empty = data<Rebuild>(execute(doc, 'suggest_rebuild', { studyId: doc3.studyId, plane: 'XY', offset: 3.9 }, ctx));
    expect(empty.loops.length).toBeGreaterThanOrEqual(0);
  });
});

describe('compare_to_topology', () => {
  const model = mbbModel();
  const job = jobOf(model);
  const half = Float32Array.from({ length: 1200 }, (_, n) => (n % 60 < 30 ? 1 : 0));
  const artifact = buildTopologyArtifact(
    job,
    fieldBytes(half),
    {
      compliance: 9,
      perLoadCase: { LC1: 9 },
      iterations: 3,
      status: 'converged',
      history: [],
      device: 'cpu',
      deterministic: true,
      version: 't',
    },
    'topopt',
  ) as FeTopologyArtifact;
  const store = artifactStore();
  const hash = store.put(artifact);
  const doc = execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: hash }, contextWith(store.port)).document;
  const ctx = contextWith(store.port);
  const box = (width: number): string => {
    const added = execute(doc, 'add_box', { size: [width, 20, 1], position: [0, 0, 0], anchor: 'min' });
    return JSON.stringify({ doc: added.document, id: added.affected[0] });
  };
  const compare = (rebuilt: string, params: Record<string, unknown> = {}): ReturnType<typeof execute> => {
    const { doc: withBox, id } = JSON.parse(rebuilt) as { doc: CadDocument; id: string };
    return execute(withBox, 'compare_to_topology', { studyId: model.studyId, entityId: id, ...params }, ctx);
  };

  it('is IoU 1 for a rebuild that matches the optimum and still asks for the compliance analysis', () => {
    const before = JSON.stringify(doc);
    const result = compare(box(30));
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.affected).toEqual([]);
    expect(data(result)).toMatchObject({
      iou: 1,
      volumeRatio: 1,
      complianceRatio: null,
      rebuildVoxels: 600,
      optimumVoxels: 600,
      status: 'warn',
      codes: ['TOP_REBUILD_NOT_ANALYSED'],
      reviewRequired: true,
    });
    expect((data(result)['targets'] as { iou: { value: number; defaulted: boolean } }).iou).toMatchObject({ value: 0.85, defaulted: true });
    expect(result.summary).toContain('iou 1');
  });

  it('measures the deviation of a smaller rebuild and fails below the target', () => {
    const result = compare(box(15));
    expect(data(result)).toMatchObject({
      iou: 0.5,
      volumeRatio: 0.5,
      status: 'fail',
      codes: ['TOP_REBUILD_DEVIATION', 'TOP_REBUILD_NOT_ANALYSED'],
    });
    const lenient = compare(box(15), { iouTarget: 0.4, complianceRatioTarget: 1.3 });
    expect(data(lenient)).toMatchObject({ status: 'warn' });
    expect(
      (data(lenient)['targets'] as { iou: { defaulted: boolean }; complianceRatio: { value: number; defaulted: boolean } }).complianceRatio,
    ).toMatchObject({ value: 1.3, defaulted: false });
    const larger = compare(box(45));
    expect((data(larger)['iou'] as number) - 30 / 45).toBeCloseTo(0, 10);
  });

  it('refuses unknown studies and entities, stale results and a bad target', () => {
    expect(code(execute(doc, 'compare_to_topology', { studyId: 'ts-0.0', entityId: model.entityId }, ctx))).toBe('TOP_STUDY_NOT_FOUND');
    expect(code(execute(doc, 'compare_to_topology', { studyId: model.studyId, entityId: 'ghost' }, ctx))).toBe('TOP_DOMAIN_INVALID');
    const sketch = execute(doc, 'draw_rectangle', { width: 2, height: 2 });
    expect(code(execute(sketch.document, 'compare_to_topology', { studyId: model.studyId, entityId: sketch.affected[0] ?? '' }, ctx))).toBe(
      'TOP_DOMAIN_INVALID',
    );
    expect(code(execute(model.doc, 'compare_to_topology', { studyId: model.studyId, entityId: model.entityId }, ctx))).toBe(
      'TOP_RESULT_MISSING',
    );
    const stale = execute(doc, 'set_topology_settings', { studyId: model.studyId, penal: 4 }).document;
    expect(code(execute(stale, 'compare_to_topology', { studyId: model.studyId, entityId: model.entityId }, ctx))).toBe('TOP_RESULT_STALE');
    expect(code(compare(box(30), { iouTarget: 0 }))).toBe('TOP_SETUP_INVALID');
    const empty = buildTopologyArtifact(
      job,
      fieldBytes(new Float32Array(1200)),
      {
        compliance: 1,
        perLoadCase: { LC1: 1 },
        iterations: 1,
        status: 'converged',
        history: [],
        device: 'cpu',
        deterministic: true,
        version: 't',
      },
      'topopt',
    ) as FeTopologyArtifact;
    const emptyStore = artifactStore();
    const emptyDoc = execute(
      model.doc,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: emptyStore.put(empty) },
      contextWith(emptyStore.port),
    ).document;
    const none = execute(
      emptyDoc,
      'compare_to_topology',
      { studyId: model.studyId, entityId: model.entityId },
      contextWith(emptyStore.port),
    );
    expect(data(none)).toMatchObject({ iou: 0, volumeRatio: null, optimumVoxels: 0 });
  });
});

describe('check_topology', () => {
  const model = mbbModel();
  const items = (result: ReturnType<typeof execute>): string[] =>
    data<{ items: Array<{ code: string }> }>(result).items.map((entry) => entry.code);
  const check = (
    doc: CadDocument,
    port: ReturnType<typeof artifactStore>['port'] | null,
    params: Record<string, unknown> = {},
  ): ReturnType<typeof execute> => execute(doc, 'check_topology', { studyId: model.studyId, ...params }, contextWith(port));

  it('flags an unsolved study and passes review notes through', () => {
    const before = JSON.stringify(model.doc);
    const result = check(model.doc, null);
    expect(JSON.stringify(model.doc)).toBe(before);
    expect(result.document).toBe(model.doc);
    expect(items(result)).toEqual(['TOP_RESULT_MISSING']);
    expect(data(result)).toMatchObject({ status: 'fail', state: 'unsolved', reviewRequired: true });
    const entry = data<{ items: Array<{ remediation: string; severity: string; ids: string[] }> }>(result).items[0];
    expect(entry).toMatchObject({ severity: 'error', ids: [model.studyId] });
    expect(entry?.remediation).toContain('topology_solve');
  });

  it('reports greyness, the missing rebuild and the iso-surface as not releasable on a solved study', () => {
    const solved = solveAndRecord(model);
    const derivedId = studyOf(solved.doc, model.analysisId, model.studyId).derivedEntityId ?? '';
    const result = check(solved.doc, solved.store.port, { release: [derivedId, model.entityId] });
    expect(items(result)).toEqual(['TOP_GREY_HIGH', 'TOP_REBUILD_MISSING', 'TOP_RESULT_NOT_RELEASABLE']);
    const releasable = data<{ items: Array<{ code: string; ids: string[] }> }>(result).items.find(
      (entry) => entry.code === 'TOP_RESULT_NOT_RELEASABLE',
    );
    expect(releasable?.ids).toEqual([derivedId]);
    expect(data(result)['status']).toBe('fail');
    const plain = check(solved.doc, solved.store.port);
    expect(data(plain)['status']).toBe('warn');
  });

  it('compares each rebuilt solid with the optimum', () => {
    const solved = solveAndRecord(model);
    const added = execute(solved.doc, 'add_box', { size: [10, 10, 1], position: [0, 0, 0], anchor: 'min' });
    const result = check(added.document, solved.store.port, { rebuildEntityIds: [added.affected[0] ?? '', 'ghost'] });
    const codes = items(result);
    expect(codes).toContain('TOP_REBUILD_DEVIATION');
    expect(codes).toContain('TOP_REBUILD_NOT_ANALYSED');
    expect(codes).not.toContain('TOP_REBUILD_MISSING');
    expect(codes.filter((entry) => entry === 'TOP_REBUILD_DEVIATION')).toHaveLength(2);
  });

  it('warns about an unconverged run, a small filter and reports stale / untrusted records', () => {
    const quick = mbbModel({ maxIterations: 4, filter: { kind: 'sensitivity', radius: 0.5 } });
    const solved = solveAndRecord(quick);
    const result = execute(
      solved.doc,
      'check_topology',
      { studyId: quick.studyId, rebuildEntityIds: [quick.entityId] },
      contextWith(solved.store.port),
    );
    expect(items(result)).toEqual(expect.arrayContaining(['TOP_FILTER_TOO_SMALL', 'TOP_NOT_CONVERGED', 'TOP_GREY_HIGH']));
    const stale = execute(solved.doc, 'set_topology_settings', { studyId: quick.studyId, penal: 4 }).document;
    expect(items(execute(stale, 'check_topology', { studyId: quick.studyId }, contextWith(solved.store.port)))).toContain(
      'TOP_RESULT_STALE',
    );
    const forged = contextWith({ get: (): FeTopologyArtifact => ({ ...solved.artifact, iterations: 1 }) });
    expect(items(execute(solved.doc, 'check_topology', { studyId: quick.studyId }, forged))).toContain('TOP_SUMMARY_MISMATCH');
    expect(items(execute(solved.doc, 'check_topology', { studyId: quick.studyId }, contextWith(artifactStore().port)))).toContain(
      'TOP_RESULT_MISSING',
    );
  });

  it('reports set-up problems of the 05 analysis and the keep-in budget', () => {
    const broken = execute(model.doc, 'delete_fea_load', {
      analysisId: model.analysisId,
      loadId: model.doc.analysis?.cases[model.analysisId]?.loadOrder[0] ?? '',
    });
    expect(items(check(broken.document, null))).toContain('TOP_SETUP_INVALID');
    const heavy = execute(model.doc, 'set_topology_settings', { studyId: model.studyId, protectLoadSupport: true });
    const overfull = execute(heavy.document, 'create_topology_study', {
      analysisId: model.analysisId,
      name: 'tight',
      designDomain: [model.entityId],
      dimension: 2,
      voxel: 4,
      volumeFraction: 0.01,
    });
    const tightId = overfull.affected[0] ?? '';
    const tight = execute(overfull.document, 'check_topology', { studyId: tightId }, contextWith(null));
    expect(data<{ items: Array<{ code: string }> }>(tight).items.map((entry) => entry.code)).toContain('TOP_KEEPIN_EXCEEDS_BUDGET');
    expect(code(execute(model.doc, 'check_topology', { studyId: 'ts-0.0' }))).toBe('TOP_STUDY_NOT_FOUND');
  });

  it('warns TOP_INPUT_UNVERIFIED when E comes from a typical 08 value (VC-TOP-25)', () => {
    const typical = mbbModel({}, (action) =>
      action.command === 'set_material_property' && action.params['property'] === 'E'
        ? { ...action, params: { ...action.params, basis: 'typical' } }
        : action,
    );
    const result = execute(typical.doc, 'check_topology', { studyId: typical.studyId }, contextWith(null));
    const unverified = data<{ items: Array<{ code: string; severity: string }> }>(result).items.find(
      (entry) => entry.code === 'TOP_INPUT_UNVERIFIED',
    );
    expect(unverified?.severity).toBe('warning');
    const solved = solveAndRecord(typical);
    const summary = studyOf(solved.doc, typical.analysisId, typical.studyId).result;
    expect(summary?.unverified).toBe(true);
    expect(summary?.unverifiedReasons.length).toBeGreaterThan(0);
    const report = data<{ unverified: boolean }>(
      execute(solved.doc, 'topology_report', { studyId: typical.studyId }, contextWith(solved.store.port)),
    );
    expect(report.unverified).toBe(true);
  });
});

describe('topology_report', () => {
  it('returns the verified result, the named settings and limits the history rows', () => {
    const model = mbbModel();
    const solved = solveAndRecord(model);
    const result = execute(solved.doc, 'topology_report', { studyId: model.studyId, historyRows: 5 }, contextWith(solved.store.port));
    const report = data<{
      result: { history: Array<{ it: number }>; iterations: number };
      settings: { penal: { defaulted: boolean } };
      derivedGeometry: string;
      derivedEntityId: string;
      concept: boolean;
      reviewRequired: boolean;
      study: { lengthUnit: string };
    }>(result);
    expect(report.result.history.map((row) => row.it)).toEqual([90, 91, 92, 93, 94]);
    expect(report.result.iterations).toBe(94);
    expect(report.settings.penal.defaulted).toBe(false);
    expect(report.derivedGeometry).toBe('present');
    expect(report.concept).toBe(true);
    expect(report.reviewRequired).toBe(true);
    expect(report.study.lengthUnit).toBe('mm');
    const none = data<{ result: { history: unknown[] } }>(
      execute(solved.doc, 'topology_report', { studyId: model.studyId, historyRows: 0 }, contextWith(solved.store.port)),
    );
    expect(none.result.history).toEqual([]);
    expect(result.summary).toContain('compliance 203.183 N*mm');
    const unsolved = data<{ derivedGeometry: string; result: unknown }>(execute(model.doc, 'topology_report', { studyId: model.studyId }));
    expect(unsolved.derivedGeometry).toBe('none');
    expect(unsolved.result).toBeNull();
    const absent = {
      ...solved.doc,
      entities: Object.fromEntries(Object.entries(solved.doc.entities).filter(([, e]) => e.kind !== 'mesh')),
    };
    expect(data(execute(absent, 'topology_report', { studyId: model.studyId }, contextWith(solved.store.port)))['derivedGeometry']).toBe(
      'absent',
    );
  });
});
