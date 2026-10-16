import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { barDocument, mustRun, portOf, solvedBar, type SolvedBar } from './deckFixtures';

const ctxOf = (bar: SolvedBar, port = bar.port): ExecutionContext => ({ ...defaultContext(), feaArtifacts: port });

/** The bar with mesh and results recorded through the commands. */
function recorded(bar: SolvedBar): CadDocument {
  const meshed = execute(
    bar.doc,
    'record_fe_mesh',
    { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) },
    ctxOf(bar),
  );
  return execute(
    meshed.document,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(bar.doc, bar.analysisId, bar.mesh, bar.results, bar.resultsHash) },
    ctxOf(bar),
  ).document;
}

interface Report {
  state: string;
  mesh: { nodes: number } | null;
  results: { loadCases: unknown[] } | null;
  probes: { probeId: string; quantity: string; unit: string; nodeId: number; values: { loadCase: string; value: number }[] }[];
  probesNote: string;
}

describe('fea_report', () => {
  it('walks unmeshed -> meshed -> solved and reads probes at the nearest node', () => {
    const bar = solvedBar();
    const report = (doc: CadDocument, ctx = ctxOf(bar)): { data: Report; summary: string } => {
      const result = execute(doc, 'fea_report', { analysisId: bar.analysisId }, ctx);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      return { data: result.data as Report, summary: result.summary };
    };
    expect(report(bar.doc).data).toMatchObject({ state: 'unmeshed', mesh: null, results: null, probes: [] });
    const meshed = execute(
      bar.doc,
      'record_fe_mesh',
      { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) },
      ctxOf(bar),
    );
    expect(report(meshed.document).data.state).toBe('meshed');
    const solved = recorded(bar);
    const { data, summary } = report(solved);
    expect(data.state).toBe('solved');
    expect(data.mesh?.nodes).toBe(8);
    expect(data.results?.loadCases).toHaveLength(1);
    expect(summary).toContain('solved');
    const byQuantity = Object.fromEntries(data.probes.map((probe) => [probe.quantity, probe]));
    expect(byQuantity['u_x']).toMatchObject({ unit: 'mm', nodeId: 2 });
    expect(byQuantity['u_x']?.values[0]?.value).toBeCloseTo(0.002, 12);
    expect(byQuantity['u_x']?.values[0]?.loadCase).toBe('LC1');
    expect(byQuantity['von_mises']).toMatchObject({ unit: 'MPa', nodeId: 5 });
    expect(byQuantity['von_mises']?.values[0]?.value).toBeCloseTo(210, 6);
    expect(data.probesNote).toBe('values at the nearest mesh node');
  });

  it('is missing when a recorded artifact is not in the store of this machine, and stale after an edit', () => {
    const bar = solvedBar();
    const solved = recorded(bar);
    const missing = execute(solved, 'fea_report', { analysisId: bar.analysisId }, ctxOf(bar, portOf()));
    expect((missing.data as Report).state).toBe('missing');
    expect((missing.data as Report).probes).toEqual([]);
    expect((missing.data as Report).probesNote).toContain('need the results artifact');
    expect((execute(solved, 'fea_report', { analysisId: bar.analysisId }).data as Report).state).toBe('missing');
    const edited = mustRun(solved, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: 3 });
    expect((execute(edited, 'fea_report', { analysisId: bar.analysisId }, ctxOf(bar)).data as Report).state).toBe('stale');
  });

  it('falls back to the nearest mesh node when the mesher resolved none, and refuses an unknown analysis', () => {
    const bar = solvedBar();
    const solved = recorded(bar);
    const sets = Object.fromEntries(Object.entries(bar.mesh.nodeSets).filter(([key]) => !key.startsWith('P_')));
    const noProbeNodes = { ...bar.mesh, nodeSets: sets };
    expect(noProbeNodes.nodeSets).not.toEqual(bar.mesh.nodeSets);
    // the artifact must be the recorded one: query through a port that serves the modified mesh under the recorded hash
    const port = { get: (hash: string) => (hash === bar.meshHash ? noProbeNodes : bar.port.get(hash)) };
    const result = execute(solved, 'fea_report', { analysisId: bar.analysisId }, ctxOf(bar, port));
    const probes = (result.data as Report).probes;
    expect(probes.find((p) => p.quantity === 'u_x')?.nodeId).toBe(2);
    // (1, 0.5, 0.5) is equidistant from several corners: the first nearest node wins
    expect(probes.find((p) => p.quantity === 'von_mises')?.nodeId).toBe(1);
    const unknown = execute(solved, 'fea_report', { analysisId: 'nope' });
    expect(unknown.rejected).toBe(true);
    expect(unknown.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });
});

interface Check {
  status: 'pass' | 'warn' | 'fail';
  state: string;
  items: { code: string; severity: string; ids: string[]; remediation: string }[];
  reviewRequired: boolean;
}
const check = (doc: CadDocument, analysisId: string, ctx?: ExecutionContext): Check =>
  execute(doc, 'check_analysis', { analysisId }, ctx).data as Check;
const codes = (result: Check): string[] => result.items.map((entry) => entry.code);

describe('check_analysis', () => {
  it('passes a solved, current analysis and always requires review', () => {
    const bar = solvedBar();
    const result = check(recorded(bar), bar.analysisId, ctxOf(bar));
    expect(result).toMatchObject({ status: 'pass', state: 'solved', items: [], reviewRequired: true });
    expect(execute(recorded(bar), 'check_analysis', { analysisId: bar.analysisId }, ctxOf(bar)).summary).toContain('reviewRequired');
  });

  it('is read-only and pure', () => {
    const bar = solvedBar();
    const snapshot = structuredClone(bar.doc);
    const result = execute(bar.doc, 'check_analysis', { analysisId: bar.analysisId });
    expect(result.document).toBe(bar.doc);
    expect(bar.doc).toEqual(snapshot);
  });

  it('fails a bare analysis for missing parts, mesh and results', () => {
    const created = execute(barDocument().doc, 'create_analysis', { name: 'empty', analysisType: 'static' });
    const result = check(created.document, created.affected[0] ?? '');
    expect(result.status).toBe('fail');
    expect(codes(result)).toEqual(['FEA_PART_INVALID', 'FEA_NO_CONSTRAINTS', 'FEA_NO_LOADS', 'FEA_MESH_MISSING']);
    expect(result.items.every((entry) => entry.remediation.length > 0)).toBe(true);
  });

  it('flags a material without elastic constants, a part without material and invalid nu', () => {
    const bad = barDocument({ material: 'bad_nu' });
    expect(codes(check(bad.doc, bad.analysisId))).toContain('FEA_PROPERTY_INVALID');
    const none = barDocument({ material: 'none' });
    expect(codes(check(none.doc, none.analysisId))).toContain('FEA_MATERIAL_MISSING');
    const bare = barDocument({ material: 'none' });
    const created = mustRun(bare.doc, 'create_material', { name: 'bare', density: 0.001, color: '#000000', metalness: 0, roughness: 0.5 });
    const assigned = mustRun(created, 'assign_material', { materialName: 'bare', entityIds: [bare.boxId] });
    expect(check(assigned, bare.analysisId).items.find((entry) => entry.code === 'FEA_MATERIAL_NO_ELASTIC')?.ids).toEqual([
      bare.boxId,
      'bare',
    ]);
  });

  it('warns about a force on an edge or point, and reports a stale mesh then stale results', () => {
    const bar = solvedBar();
    const solved = recorded(bar);
    const pointLoad = mustRun(solved, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'tip',
      kind: 'force',
      vector: [0, 0, -1],
      target: { entityId: bar.boxId, pointsNear: [[2, 0, 0]] },
    });
    const afterLoad = check(pointLoad, bar.analysisId, ctxOf(bar));
    expect(codes(afterLoad)).toEqual(['FEA_POINT_LOAD_SINGULAR', 'FEA_MESH_STALE']);
    expect(afterLoad.status).toBe('fail');
    // a recorded mesh that is current while the results are for other inputs
    const meshed = execute(
      bar.doc,
      'record_fe_mesh',
      { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) },
      ctxOf(bar),
    ).document;
    expect(codes(check(meshed, bar.analysisId))).toEqual(['FEA_RESULTS_MISSING']);
  });

  it('flags results computed for other inputs and artifacts absent on this machine', () => {
    const bar = solvedBar();
    const solved = recorded(bar);
    const absent = check(solved, bar.analysisId, ctxOf(bar, portOf()));
    expect(codes(absent)).toEqual(['FEA_MESH_MISSING', 'FEA_RESULTS_MISSING']);
    const stale = mustRun(solved, 'add_fea_load', { analysisId: bar.analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -9810] });
    expect(codes(check(stale, bar.analysisId))).toEqual(['FEA_RESULTS_STALE']);
  });

  it('refuses an unknown analysis', () => {
    const result = execute(barDocument().doc, 'check_analysis', { analysisId: 'nope' });
    expect(result.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });
});
