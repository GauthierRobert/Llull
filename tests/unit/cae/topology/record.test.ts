/** record_topology_result and the trust model: numbers enter the document only from a verified artifact (05 4.1). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeTopologyArtifact, TopologyResultSummary, TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { buildTopologyArtifact, runTopologyReference, TS_REFERENCE_MAX_ELEMENTS } from '@cae/index';
import { fieldBytes } from '@cae/topology/artifact';
import { artifactStore, code, contextWith, data, jobOf, mbbModel, solveAndRecord, studyOf, type Model } from './support';

const relative = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

function patchStudy(doc: CadDocument, model: Model, patch: Partial<TopologyStudy>): CadDocument {
  const study = studyOf(doc, model.analysisId, model.studyId);
  const analysisCase = doc.analysis?.cases[model.analysisId];
  if (doc.analysis === undefined || analysisCase === undefined) throw new Error('no analysis');
  const next = { ...analysisCase, topology: { ...analysisCase.topology, [model.studyId]: { ...study, ...patch } } };
  return { ...doc, analysis: { ...doc.analysis, cases: { ...doc.analysis.cases, [model.analysisId]: next } } };
}

describe('record_topology_result', () => {
  const model = mbbModel();
  const solved = solveAndRecord(model);
  const study = studyOf(solved.doc, model.analysisId, model.studyId);

  it('records the recomputed summary and derives the read-only iso-surface (VC-TOP-10)', () => {
    const summary = study.result;
    expect(summary).toBeDefined();
    expect(summary?.fieldHash).toBe(solved.hash);
    expect(summary?.iterations).toBe(94);
    expect(summary?.status).toBe('converged');
    expect(relative(summary?.compliance ?? 0, 203.182593258)).toBeLessThan(1e-6);
    expect(Math.abs((summary?.volumeFraction ?? 0) - 0.499970090278)).toBeLessThan(1e-3);
    expect(Math.abs((summary?.grey ?? 0) - 0.174175545817)).toBeLessThan(1e-3);
    expect(summary?.complianceUnit).toBe('N*mm');
    expect(summary?.volumeUnit).toBe('mm^3');
    expect(summary?.thresholdedVolume).toBeGreaterThan(500);
    expect(summary?.solver).toEqual({ job: 'ts-reference', version: 'llull-lib-topology-1', device: 'cpu', deterministic: true });
    expect(summary?.concept).toBe(true);
    expect(summary?.unverified).toBe(false);
    expect(summary?.grid).toEqual({ nx: 60, ny: 20, nz: 1, active: 1200, keepIn: 0, keepOut: 0 });
    expect(summary?.history).toHaveLength(94);
    expect(summary?.perLoadCase['LC1']).toBe(summary?.compliance);
    const derivedId = study.derivedEntityId ?? '';
    expect(solved.result.affected).toEqual([model.studyId, derivedId]);
    const entity = solved.doc.entities[derivedId];
    expect(entity).toMatchObject({ kind: 'mesh', layerId: 'layer-topology', tags: [`topology:${model.studyId}`] });
    expect(solved.doc.order).toContain(derivedId);
    expect(solved.doc.layers['layer-topology']?.name).toBe('topology');
    expect(solved.doc.layerOrder).toContain('layer-topology');
    expect(solved.result.summary).toContain('94 iterations (converged)');
  });

  it('is pure and idempotent: recording the same artifact again re-derives the same entity', () => {
    const before = JSON.stringify(model.doc);
    const first = execute(
      model.doc,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: solved.hash },
      contextWith(solved.store.port),
    );
    expect(JSON.stringify(model.doc)).toBe(before);
    const again = execute(
      first.document,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: solved.hash },
      contextWith(solved.store.port),
    );
    const derivedId = studyOf(first.document, model.analysisId, model.studyId).derivedEntityId ?? '';
    expect(studyOf(again.document, model.analysisId, model.studyId).derivedEntityId).toBe(derivedId);
    expect(again.document.entities[derivedId]).toEqual(first.document.entities[derivedId]);
    expect(again.document.order.filter((id) => id === derivedId)).toHaveLength(1);
  });

  it('two identical runs give the identical artifact hash (VC-TOP-27)', () => {
    const second = solveAndRecord(model, artifactStore());
    expect(second.hash).toBe(solved.hash);
    expect(second.result.summary).toBe(solved.result.summary);
  });

  it('accepts a summary equal to the recomputed one and rejects one that differs', () => {
    const summary = study.result as TopologyResultSummary;
    const same = execute(
      model.doc,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: solved.hash, summary },
      contextWith(solved.store.port),
    );
    expect(same.affected).toHaveLength(2);
    const lying = execute(
      model.doc,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: solved.hash, summary: { ...summary, compliance: summary.compliance / 2, iterations: 3 } },
      contextWith(solved.store.port),
    );
    expect(code(lying)).toBe('TOP_SUMMARY_MISMATCH');
    expect(lying.summary).toContain('compliance');
    expect(lying.document).toBe(model.doc);
  });

  it('refuses a missing artifact, an unknown study and an artifact that does not hash to its name', () => {
    const none = execute(
      model.doc,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: 'f'.repeat(64) },
      contextWith(artifactStore().port),
    );
    expect(code(none)).toBe('TOP_ARTIFACT_NOT_FOUND');
    expect(none.document).toBe(model.doc);
    expect(code(execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: solved.hash }))).toBe(
      'TOP_ARTIFACT_NOT_FOUND',
    );
    expect(
      code(execute(model.doc, 'record_topology_result', { studyId: 'ts-0.0', fieldHash: solved.hash }, contextWith(solved.store.port))),
    ).toBe('TOP_STUDY_NOT_FOUND');
    const liar = { get: (): FeTopologyArtifact => ({ ...solved.artifact, compliance: 1 }) };
    const forged = execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: solved.hash }, contextWith(liar));
    expect(code(forged)).toBe('TOP_SUMMARY_MISMATCH');
    expect(forged.document).toBe(model.doc);
  });

  it('refuses an artifact built for other inputs or settings (TOP_RESULT_STALE)', () => {
    const moved = execute(model.doc, 'set_topology_settings', { studyId: model.studyId, penal: 4 }).document;
    const staleSettings = execute(
      moved,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: solved.hash },
      contextWith(solved.store.port),
    );
    expect(code(staleSettings)).toBe('TOP_RESULT_STALE');
    const regions = execute(model.doc, 'set_topology_regions', {
      studyId: model.studyId,
      keepOut: [{ kind: 'box', min: [30, 8, 0], max: [34, 12, 1] }],
    }).document;
    expect(
      code(execute(regions, 'record_topology_result', { studyId: model.studyId, fieldHash: solved.hash }, contextWith(solved.store.port))),
    ).toBe('TOP_RESULT_STALE');
  });

  it('refuses an artifact whose field does not decode', () => {
    const broken: FeTopologyArtifact = { ...solved.artifact, xPhys: 'AAAA' };
    const store = artifactStore();
    const hash = store.put(broken);
    const result = execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: hash }, contextWith(store.port));
    expect(code(result)).toBe('TOP_SUMMARY_MISMATCH');
    expect(result.summary).toContain('does not decode');
  });

  it('keeps a summary flagged unverified when the artifact is not on this machine (replay)', () => {
    const summary = study.result as TopologyResultSummary;
    const replayed = execute(
      model.doc,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: solved.hash, summary },
      contextWith(artifactStore().port),
    );
    expect(replayed.affected).toEqual([model.studyId]);
    expect(replayed.summary).toContain('UNVERIFIED');
    const recorded = studyOf(replayed.document, model.analysisId, model.studyId);
    expect(recorded.result?.verified).toBe(false);
    expect(recorded.derivedEntityId).toBeUndefined();
    const report = execute(replayed.document, 'topology_report', { studyId: model.studyId }, contextWith(solved.store.port));
    expect(data(report)['state']).toBe('missing');
    expect(data(report)['result']).toBeNull();
    const otherHash = execute(
      model.doc,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: 'a'.repeat(64), summary },
      contextWith(artifactStore().port),
    );
    expect(code(otherHash)).toBe('TOP_ARTIFACT_NOT_FOUND');
    const noHash = execute(
      model.doc,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: solved.hash, summary: { fieldHash: solved.hash } },
      contextWith(artifactStore().port),
    );
    expect(code(noHash)).toBe('TOP_ARTIFACT_NOT_FOUND');
  });

  it('records a field without solid voxels and removes an earlier iso-surface', () => {
    const job = jobOf(model);
    const empty = buildTopologyArtifact(
      job,
      fieldBytes(new Float32Array(1200)),
      {
        compliance: 1,
        perLoadCase: { LC1: 1 },
        iterations: 1,
        status: 'max_iterations',
        history: [],
        device: 'cpu',
        deterministic: true,
        version: 'test',
      },
      'topopt',
    );
    expect(typeof empty).not.toBe('string');
    const store = artifactStore();
    const hash = store.put(empty as FeTopologyArtifact);
    const result = execute(solved.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: hash }, contextWith(store.port));
    expect(result.summary).toContain('no iso-surface');
    expect(result.affected).toEqual([model.studyId]);
    const derivedBefore = study.derivedEntityId ?? '';
    expect(result.document.entities[derivedBefore]).toBeUndefined();
    expect(studyOf(result.document, model.analysisId, model.studyId).derivedEntityId).toBeUndefined();
    const fresh = execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: hash }, contextWith(store.port));
    expect(fresh.affected).toEqual([model.studyId]);
  });

  it('caps a long history to 1000 rows ending with the last iteration and flags unverified material', () => {
    const job = jobOf(model);
    const history = Array.from({ length: 2500 }, (_, i) => ({ it: i + 1, compliance: 100 - i / 100, volume: 0.5, change: 0.1 }));
    const long = buildTopologyArtifact(
      job,
      fieldBytes(new Float32Array(1200).fill(0.6)),
      {
        compliance: 5,
        perLoadCase: { LC1: 5 },
        iterations: 2500,
        status: 'max_iterations',
        history,
        device: 'gpu',
        deterministic: false,
        version: 'native-1',
      },
      'topopt',
    );
    const store = artifactStore();
    const hash = store.put(long as FeTopologyArtifact);
    const result = execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: hash }, contextWith(store.port));
    const summary = studyOf(result.document, model.analysisId, model.studyId).result;
    expect(summary?.history.length).toBeLessThanOrEqual(1000);
    expect(summary?.history[summary.history.length - 1]?.it).toBe(2500);
    expect(summary?.history[0]?.it).toBe(1);
    expect(summary?.solver).toEqual({ job: 'topopt', version: 'native-1', device: 'gpu', deterministic: false });
    expect(result.summary).not.toContain('deterministic');
  });
});

describe('artifact helpers of the transport', () => {
  const model = mbbModel();
  const job = jobOf(model);
  const output = {
    compliance: 1,
    perLoadCase: { LC1: 1 },
    iterations: 1,
    status: 'converged' as const,
    history: [],
    device: 'cpu' as const,
    deterministic: true,
    version: 't',
  };

  it('buildTopologyArtifact refuses a field of the wrong length or with values outside [0, 1]', () => {
    expect(buildTopologyArtifact(job, new Uint8Array(10), output, 'topopt')).toMatch(/bytes of float32/);
    expect(buildTopologyArtifact(job, fieldBytes(new Float32Array(1200).fill(1.5)), output, 'topopt')).toMatch(/bytes of float32/);
    expect(buildTopologyArtifact(job, fieldBytes(new Float32Array(1200).fill(Number.NaN)), output, 'topopt')).toMatch(/bytes of float32/);
    const ok = buildTopologyArtifact(job, fieldBytes(new Float32Array(1200).fill(1 + 1e-7)), output, 'topopt');
    expect(typeof ok).toBe('object');
  });

  it('runTopologyReference refuses 3D jobs, large grids and singular systems', () => {
    expect(runTopologyReference({ ...job, dimension: 3, grid: { ...job.grid, dimension: 3, nz: 2 } })).toMatch(/2D studies only/);
    expect(runTopologyReference({ ...job, grid: { ...job.grid, nx: 60, ny: 40 } })).toContain(`cap of ${TS_REFERENCE_MAX_ELEMENTS}`);
    expect(runTopologyReference({ ...job, fixedDofs: [] })).toMatch(/singular/);
  });
});

describe('trust: topology_report reads numbers only from a verified artifact', () => {
  const model = mbbModel();
  const solved = solveAndRecord(model);
  const report = (doc: CadDocument, port = solved.store.port): Record<string, unknown> =>
    data(execute(doc, 'topology_report', { studyId: model.studyId }, contextWith(port)));

  it('is solved with the verified summary', () => {
    const solvedReport = report(solved.doc);
    expect(solvedReport['state']).toBe('solved');
    expect((solvedReport['result'] as { iterations: number }).iterations).toBe(94);
  });

  it('is unsolved before a record and stale after the study changed', () => {
    expect(report(model.doc)['state']).toBe('unsolved');
    const changed = execute(solved.doc, 'set_topology_settings', { studyId: model.studyId, move: 0.3 }).document;
    const stale = report(changed);
    expect(stale['state']).toBe('stale');
    expect(stale['result']).toBeNull();
  });

  it('is missing without the artifact on this machine and untrusted when the record or the store lies', () => {
    expect(report(solved.doc, artifactStore().port)['state']).toBe('missing');
    expect(data(execute(solved.doc, 'topology_report', { studyId: model.studyId }))['state']).toBe('missing');
    const study = studyOf(solved.doc, model.analysisId, model.studyId);
    const tampered = patchStudy(solved.doc, model, { result: { ...(study.result as TopologyResultSummary), compliance: 1 } });
    const lied = report(tampered);
    expect(lied['state']).toBe('untrusted');
    expect((lied['problem'] as { code: string }).code).toBe('TOP_SUMMARY_MISMATCH');
    expect(lied['result']).toBeNull();
    const forgedStore = { get: (): FeTopologyArtifact => ({ ...solved.artifact, iterations: 1 }) };
    const forged = report(solved.doc, forgedStore);
    expect(forged['state']).toBe('untrusted');
  });

  it('refuses an unknown study', () => {
    const result = execute(model.doc, 'topology_report', { studyId: 'ts-0.0' });
    expect(code(result)).toBe('TOP_STUDY_NOT_FOUND');
    expect(result.document).toBe(model.doc);
  });
});
