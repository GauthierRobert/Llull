import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeResultsArtifact, MeshSummary, ResultsSummary } from '@core/model/analysis';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { analysisInputHash } from '@cae/hash/inputHash';
import { stateOf } from '@cae/shared/state';
import { caseIn } from './helpers';
import { hashOf, portOf, solvedBar, type SolvedBar } from './deckFixtures';

const withPort = (bar: SolvedBar, port = bar.port): ExecutionContext => ({ ...defaultContext(), feaArtifacts: port });

function recordedMesh(bar: SolvedBar): SolvedBar['doc'] {
  const result = execute(
    bar.doc,
    'record_fe_mesh',
    { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) },
    withPort(bar),
  );
  expect(result.error).toBeUndefined();
  return result.document;
}

describe('meshSummary', () => {
  it('counts nodes and elements and rates the tetrahedra', () => {
    const { mesh, meshHash } = solvedBar();
    const summary = meshSummary(mesh, meshHash);
    expect(summary).toMatchObject({
      meshHash,
      inputHash: mesh.inputHash,
      mesher: 'test',
      nodes: 8,
      elements: { C3D4: 6 },
      warnings: [],
      faceMap: [],
    });
    expect(summary.quality.inverted).toBe(0);
    const sj = summary.quality.metrics['tet_scaled_jacobian'];
    expect(sj?.min).toBeGreaterThan(0.1);
    expect(sj?.max).toBeLessThanOrEqual(1);
    expect(summary.quality.metrics['tet_edge_ratio']?.min).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(summary)).toBe(JSON.stringify(meshSummary(mesh, meshHash)));
  });

  it('reports inverted elements and skips elements with unknown nodes', () => {
    const { mesh, meshHash } = solvedBar();
    const flipped = {
      ...mesh,
      blocks: [{ ...mesh.blocks[0]!, elements: [[1, 1, 3, 2, 8], [2, 1, 2, 3, 99], ...mesh.blocks[0]!.elements.slice(2)] }],
    };
    const summary = meshSummary(flipped, meshHash);
    expect(summary.quality.inverted).toBeGreaterThan(0);
    expect(summary.warnings[0]).toContain('FEA_MESH_INVERTED');
    expect(summary.elements['C3D4']).toBe(6);
  });
});

describe('resultsSummary on the CalculiX run', () => {
  it('gives the max von Mises (sigma = F/A = 210 MPa) and the max displacement magnitude with positions', () => {
    const bar = solvedBar();
    const summary = resultsSummary(bar.doc, bar.analysisId, bar.mesh, bar.results, bar.resultsHash);
    expect(summary).toMatchObject({ resultsHash: bar.resultsHash, solver: 'CalculiX', solverVersion: '2.21', units: 'N-mm-t-s' });
    expect(summary.loadCases).toHaveLength(1);
    const [loadCase] = summary.loadCases;
    expect(loadCase?.name).toBe('LC1');
    expect(loadCase?.category).toBe('limit');
    expect(loadCase?.maxVonMises.value).toBeCloseTo(210, 6);
    expect(loadCase?.maxVonMises.entityId).toBe(bar.boxId);
    expect(loadCase?.maxDisplacement.value).toBeCloseTo(Math.hypot(0.002, 3e-4, 3e-4), 9);
    expect(loadCase?.maxDisplacement.at).toEqual([2, 1, 1]);
  });

  it('omits load cases without stress / displacement and an unknown analysis has none', () => {
    const bar = solvedBar();
    const noStress: FeResultsArtifact = {
      ...bar.results,
      steps: bar.results.steps.map((s) => ({ ...s, fields: { DISP: s.fields['DISP']! } })),
    };
    expect(resultsSummary(bar.doc, bar.analysisId, bar.mesh, noStress, 'h').loadCases).toEqual([]);
    expect(resultsSummary(bar.doc, 'nope', bar.mesh, bar.results, 'h').loadCases).toEqual([]);
  });
});

describe('record_fe_mesh (trust model, 05 §4.1)', () => {
  it('records the recomputed summary and clears results', () => {
    const bar = solvedBar();
    const solved = execute(
      recordedMesh(bar),
      'record_fea_results',
      { analysisId: bar.analysisId, summary: resultsSummary(bar.doc, bar.analysisId, bar.mesh, bar.results, bar.resultsHash) },
      withPort(bar),
    );
    expect(solved.error).toBeUndefined();
    expect(caseIn(solved.document, bar.analysisId).results).toBeDefined();
    const again = execute(
      solved.document,
      'record_fe_mesh',
      { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) },
      withPort(bar),
    );
    expect(again.affected).toEqual([bar.analysisId]);
    expect(again.summary).toContain('8 nodes, 6 C3D4, 0 inverted');
    expect(caseIn(again.document, bar.analysisId).results).toBeUndefined();
    expect(caseIn(again.document, bar.analysisId).meshSummary?.meshHash).toBe(bar.meshHash);
  });

  it('is pure', () => {
    const bar = solvedBar();
    const snapshot = structuredClone(bar.doc);
    execute(bar.doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) }, withPort(bar));
    expect(bar.doc).toEqual(snapshot);
  });

  const refusal = (
    bar: SolvedBar,
    summary: unknown,
    ctx: ExecutionContext | undefined,
    analysisId = bar.analysisId,
  ): ReturnType<typeof execute> => execute(bar.doc, 'record_fe_mesh', { analysisId, summary }, ctx);

  it('keeps the summary flagged verified:false without a port or without the artifact (state missing), and refuses an unknown analysis', () => {
    const bar = solvedBar();
    const summary = meshSummary(bar.mesh, bar.meshHash);
    for (const result of [refusal(bar, summary, undefined), refusal(bar, summary, withPort(bar, portOf()))]) {
      expect(result.rejected).toBeUndefined();
      expect(result.affected).toEqual([bar.analysisId]);
      expect(result.summary).toContain('UNVERIFIED');
      const stored = caseIn(result.document, bar.analysisId);
      expect(stored.meshSummary).toEqual({ ...summary, verified: false });
      expect(stateOf(result.document, stored)).toBe('missing');
    }
    const unknown = refusal(bar, summary, withPort(bar), 'nope');
    expect(unknown.rejected).toBe(true);
    expect(unknown.document).toBe(bar.doc);
    expect(unknown.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const noHash = refusal(bar, { meshHash: bar.meshHash, nodes: 8 }, undefined);
    expect(noHash.error?.code).toBe('FEA_SUMMARY_MISMATCH');
    expect(noHash.document).toBe(bar.doc);
  });

  it('refuses an artifact whose sha256 is not the hash, and treats one of the wrong kind as absent', () => {
    const bar = solvedBar();
    const summary = meshSummary(bar.mesh, bar.meshHash);
    const lying = { get: () => ({ ...bar.mesh, mesher: 'forged' }) };
    expect(refusal(bar, summary, withPort(bar, lying)).error?.code).toBe('FEA_SUMMARY_MISMATCH');
    const resultsAsMesh = { get: () => bar.results };
    const unverified = refusal(bar, summary, withPort(bar, resultsAsMesh));
    expect(unverified.rejected).toBeUndefined();
    expect(caseIn(unverified.document, bar.analysisId).meshSummary?.verified).toBe(false);
  });

  it('refuses a hand-written summary and names the differing fields', () => {
    const bar = solvedBar();
    const forged: MeshSummary = { ...meshSummary(bar.mesh, bar.meshHash), nodes: 9999 };
    const result = refusal(bar, forged, withPort(bar));
    expect(result.error?.code).toBe('FEA_SUMMARY_MISMATCH');
    expect(result.summary).toContain('nodes');
    expect(result.error?.ids).toContain(bar.meshHash);
  });

  it('records a mesh built for other inputs as stale (regeneration after a parameter change), never as current', () => {
    const bar = solvedBar();
    const moved = execute(bar.doc, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: 3 }).document;
    const result = execute(
      moved,
      'record_fe_mesh',
      { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) },
      withPort(bar),
    );
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain('recorded STALE');
    expect(result.summary).toContain('re-run fea_mesh then fea_solve');
    expect(
      (execute(result.document, 'analysis_report', { analysisId: bar.analysisId }, withPort(bar)).data as { state: string }).state,
    ).toBe('stale');
  });
});

describe('record_fea_results (trust model, 05 §4.1)', () => {
  const summaryOf = (bar: SolvedBar): ResultsSummary => resultsSummary(bar.doc, bar.analysisId, bar.mesh, bar.results, bar.resultsHash);
  const record = (
    bar: SolvedBar,
    doc: SolvedBar['doc'],
    summary: unknown,
    ctx: ExecutionContext | null = withPort(bar),
  ): ReturnType<typeof execute> => execute(doc, 'record_fea_results', { analysisId: bar.analysisId, summary }, ctx ?? undefined);

  it('records the recomputed summary and reports load cases and units', () => {
    const bar = solvedBar();
    const result = record(bar, recordedMesh(bar), summaryOf(bar));
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([bar.analysisId]);
    expect(result.summary).toContain('LC1: max von Mises 210 MPa');
    expect(caseIn(result.document, bar.analysisId).results?.resultsHash).toBe(bar.resultsHash);
  });

  it('refuses before a mesh is recorded (FEA_MESH_MISMATCH)', () => {
    const bar = solvedBar();
    expect(record(bar, bar.doc, summaryOf(bar)).error?.code).toBe('FEA_MESH_MISMATCH');
  });

  it('refuses results computed on another mesh than the recorded one', () => {
    const bar = solvedBar();
    const other: FeResultsArtifact = { ...bar.results, meshHash: 'f'.repeat(64) };
    const port = portOf(bar.mesh, other);
    const result = record(bar, recordedMesh(bar), { ...summaryOf(bar), resultsHash: hashOf(other) }, withPort(bar, port));
    expect(result.error?.code).toBe('FEA_MESH_MISMATCH');
  });

  it('keeps results flagged verified:false when an artifact is missing, still refuses hand-written summaries and unknown analyses', () => {
    const bar = solvedBar();
    const meshed = recordedMesh(bar);
    for (const ctx of [null, withPort(bar, portOf(bar.results)), withPort(bar, portOf(bar.mesh))]) {
      const kept = record(bar, meshed, summaryOf(bar), ctx);
      expect(kept.rejected).toBeUndefined();
      expect(kept.summary).toContain('UNVERIFIED');
      const stored = caseIn(kept.document, bar.analysisId);
      expect(stored.results).toEqual({ ...summaryOf(bar), verified: false });
      expect(stateOf(kept.document, stored)).toBe('missing');
    }
    const forged = summaryOf(bar);
    const inflated = { ...forged, loadCases: forged.loadCases.map((lc) => ({ ...lc, maxVonMises: { ...lc.maxVonMises, value: 1 } })) };
    const mismatch = record(bar, meshed, inflated);
    expect(mismatch.error?.code).toBe('FEA_SUMMARY_MISMATCH');
    expect(mismatch.summary).toContain('loadCases');
    expect(execute(meshed, 'record_fea_results', { analysisId: 'nope', summary: summaryOf(bar) }, withPort(bar)).error?.code).toBe(
      'FEA_ANALYSIS_NOT_FOUND',
    );
  });

  it('records results computed for other inputs as stale; their numbers are withheld', () => {
    const bar = solvedBar();
    const meshed = recordedMesh(bar);
    const stale: FeResultsArtifact = { ...bar.results, inputHash: analysisInputHash(bar.doc, bar.analysisId, 'mesh') };
    const staleHash = hashOf(stale);
    const result = record(
      bar,
      meshed,
      { ...summaryOf(bar), resultsHash: staleHash, inputHash: stale.inputHash },
      withPort(bar, portOf(bar.mesh, stale)),
    );
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain('recorded STALE');
    const reported = execute(result.document, 'analysis_report', { analysisId: bar.analysisId }, withPort(bar, portOf(bar.mesh, stale)))
      .data as { state: string; results: unknown };
    expect(reported.state).toBe('stale');
    expect(reported.results).toBeNull();
  });
});
