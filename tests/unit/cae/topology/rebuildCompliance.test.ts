/** compare_to_topology / check_topology compliance ratio from a current 05 result (TR-TOP-10) and suggest_rebuild widthSamples (TR-TOP-09). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { FeTopologyArtifact } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { buildTopologyArtifact } from '@cae/index';
import { fieldBytes } from '@cae/topology/artifact';
import { distanceToVoid } from '@cae/topology/widthSamples';
import { artifactStore, code, contextWith, data, jobOf, mbbModel } from './support';

const model = mbbModel();
const job = jobOf(model);
const outcome = {
  perLoadCase: { LC1: 9 },
  iterations: 3,
  status: 'converged' as const,
  history: [],
  device: 'cpu' as const,
  deterministic: true,
  version: 't',
};
const block = Float32Array.from({ length: 1200 }, (_, n) => (n % 60 < 30 ? 1 : 0));

function solvedStudy(compliance: number): { doc: CadDocument; topology: ReturnType<typeof artifactStore> } {
  const artifact = buildTopologyArtifact(job, fieldBytes(block), { ...outcome, compliance }, 'topopt') as FeTopologyArtifact;
  const topology = artifactStore();
  const hash = topology.put(artifact);
  const doc = execute(
    model.doc,
    'record_topology_result',
    { studyId: model.studyId, fieldHash: hash },
    contextWith(topology.port),
  ).document;
  return { doc, topology };
}

const hashOf = (artifact: FeMeshArtifact | FeResultsArtifact): string => sha256Hex(canonicalJson(artifact));

interface Rebuilt {
  readonly doc: CadDocument;
  readonly entityId: string;
  readonly analysisId: string;
  readonly ctx: ReturnType<typeof contextWith>;
}

interface RebuiltOptions {
  readonly unitSystem?: 'N-mm-t-s' | 'N-m-kg-s' | 'lbf-in-slinch-s';
  readonly loadKind?: 'force' | 'pressure';
  readonly loadCase?: string;
  readonly nodeSet?: readonly number[];
  readonly displaced?: boolean;
  readonly solve?: boolean;
  readonly analysisType?: 'static' | 'modal';
}

/** The 30 x 20 x 1 rebuild with a 05 static analysis: 1000 N pulled over four nodes that moved `uy` each (F^T u = 1000 uy), recorded with its artifacts. */
function rebuilt(base: CadDocument, topology: ReturnType<typeof artifactStore>, uy: number, options: RebuiltOptions = {}): Rebuilt {
  const { unitSystem = 'N-mm-t-s', loadKind = 'force', loadCase = 'LC1', nodeSet = [2, 4, 6, 8], displaced = true, solve = true } = options;
  const added = execute(base, 'add_box', { size: [30, 20, 1], position: [0, 0, 0], anchor: 'min' });
  const entityId = added.affected[0] ?? '';
  const created = execute(added.document, 'create_analysis', { name: 'rebuild', analysisType: options.analysisType ?? 'static' });
  const analysisId = created.affected[0] ?? '';
  let doc = execute(created.document, 'set_part_idealization', { analysisId, entityId, idealization: 'solid' }).document;
  doc = execute(doc, 'add_fea_constraint', {
    analysisId,
    name: 'fix',
    kind: 'fixed',
    target: { entityId, facesNear: [[0, 10, 0.5]] },
  }).document;
  const load = execute(doc, 'add_fea_load', {
    analysisId,
    name: 'pull',
    loadCase,
    category: 'limit',
    kind: loadKind,
    target: { entityId, facesNear: [[30, 10, 0.5]] },
    ...(loadKind === 'force' ? { vector: [0, -1000, 0] } : { magnitude: 1 }),
  });
  doc = load.document;
  const analysis = doc.analysis;
  const analysisCase = analysis?.cases[analysisId];
  if (analysis !== undefined && analysisCase !== undefined && unitSystem !== 'N-mm-t-s')
    doc = { ...doc, analysis: { ...analysis, cases: { ...analysis.cases, [analysisId]: { ...analysisCase, unitSystem } } } };
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem,
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, analysisId, 'mesh'),
    nodes: [
      [1, 0, 0, 0],
      [2, 30, 0, 0],
      [3, 0, 20, 0],
      [4, 30, 20, 0],
      [5, 0, 0, 1],
      [6, 30, 0, 1],
      [7, 0, 20, 1],
      [8, 30, 20, 1],
    ],
    blocks: [{ type: 'C3D4', entityId, elements: [[1, 1, 2, 4, 8]] }],
    nodeSets: { [`L_${load.affected[0]}`]: nodeSet },
    faceSets: {},
    targets: {},
  };
  const meshHash = hashOf(mesh);
  doc = execute(doc, 'record_fe_mesh', { analysisId, summary: meshSummary(mesh, meshHash) }, contextWith({ get: () => mesh })).document;
  const values = displaced ? Object.fromEntries([2, 4, 6, 8].map((node) => [String(node), [0, -uy, 0]])) : {};
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash,
    inputHash: analysisInputHash(doc, analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: [{ step: 1, time: 1, fields: { DISP: { components: ['D1', 'D2', 'D3'], values } } }],
  };
  const resultsHash = hashOf(results);
  const store = new Map<string, FeMeshArtifact | FeResultsArtifact>([
    [meshHash, mesh],
    [resultsHash, results],
  ]);
  const port: FeArtifactPort = { get: (hash) => store.get(hash) ?? topology.port.get(hash) };
  if (solve)
    doc = execute(
      doc,
      'record_fea_results',
      { analysisId, summary: resultsSummary(doc, analysisId, mesh, results, resultsHash) },
      contextWith(port),
    ).document;
  return { doc, entityId, analysisId, ctx: contextWith(port) };
}

const compare = (rebuild: Rebuilt, params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(rebuild.doc, 'compare_to_topology', { studyId: model.studyId, entityId: rebuild.entityId, ...params }, rebuild.ctx);

type Compare = {
  complianceRatio: number | null;
  complianceStatus: {
    available: boolean;
    reason?: string;
    code?: string;
    analysisId?: string;
    unit?: string;
    rebuildCompliance?: number;
    optimumCompliance?: number;
  };
  status: string;
  codes: string[];
  targets: { complianceRatio: { value: number; defaulted: boolean } };
};

describe('compare_to_topology compliance ratio', () => {
  const { doc, topology } = solvedStudy(9);

  it('is F^T u of the rebuild over the compliance of the optimum, checked against the named target', () => {
    const rebuild = rebuilt(doc, topology, 0.0099);
    const before = JSON.stringify(rebuild.doc);
    const result = compare(rebuild);
    expect(JSON.stringify(rebuild.doc)).toBe(before);
    expect(result.document).toBe(rebuild.doc);
    expect(result.affected).toEqual([]);
    const out = data<Compare>(result);
    expect(out.complianceRatio).toBeCloseTo(1.1, 10);
    expect(out.complianceStatus).toMatchObject({ available: true, analysisId: rebuild.analysisId, unit: 'N*mm' });
    expect(out.complianceStatus.rebuildCompliance).toBeCloseTo(9.9, 10);
    expect(out.complianceStatus.optimumCompliance).toBe(9);
    expect(out).toMatchObject({ status: 'pass', codes: [] });
    expect(out.targets.complianceRatio).toMatchObject({ value: 1.15, defaulted: true });
    expect(result.summary).toContain('compliance ratio 1.1');
  });

  it('fails with TOP_REBUILD_DEVIATION above the target and passes with a looser caller target', () => {
    const rebuild = rebuilt(doc, topology, 0.0108);
    const out = data<Compare>(compare(rebuild));
    expect(out.complianceRatio).toBeCloseTo(1.2, 10);
    expect(out).toMatchObject({ status: 'fail', codes: ['TOP_REBUILD_DEVIATION'] });
    const lenient = data<Compare>(compare(rebuild, { complianceRatioTarget: 1.3 }));
    expect(lenient).toMatchObject({ status: 'pass', codes: [] });
    expect(lenient.targets.complianceRatio).toMatchObject({ value: 1.3, defaulted: false });
    expect(code(compare(rebuild, { complianceRatioTarget: 0.9 }))).toBe('TOP_SETUP_INVALID');
  });

  it('converts both compliances to N*mm when the unit systems differ', () => {
    const metric = rebuilt(doc, topology, 9.9e-6, { unitSystem: 'N-m-kg-s' });
    expect(data<Compare>(compare(metric)).complianceRatio).toBeCloseTo(1.1, 8);
    const imperial = rebuilt(doc, topology, 0.0099 / 112.98482902, { unitSystem: 'lbf-in-slinch-s' });
    expect(data<Compare>(compare(imperial)).complianceRatio).toBeCloseTo(1.1, 8);
  });

  const unavailable = (rebuild: Rebuilt, reason: string): void => {
    const result = compare(rebuild);
    const out = data<Compare>(result);
    expect(out.complianceRatio).toBeNull();
    expect(out.complianceStatus).toMatchObject({ available: false, code: 'TOP_REBUILD_NOT_ANALYSED', reason });
    expect(out.codes).toContain('TOP_REBUILD_NOT_ANALYSED');
    expect(out.status).toBe('warn');
    expect(result.summary).toContain('TOP_REBUILD_NOT_ANALYSED');
  };

  it('reports the ratio as unavailable when no analysis has the solid, when it is unsolved, stale or its artifacts are absent', () => {
    const plain = execute(doc, 'add_box', { size: [30, 20, 1], position: [0, 0, 0], anchor: 'min' });
    unavailable({ ...rebuilt(doc, topology, 0.01), doc: plain.document, entityId: plain.affected[0] ?? '' }, 'no_analysis');
    unavailable(rebuilt(doc, topology, 0.01, { solve: false }), 'not_solved');
    const stale = rebuilt(doc, topology, 0.01);
    const moved = execute(stale.doc, 'set_mesh_controls', { analysisId: stale.analysisId, globalSize: 3 }).document;
    unavailable({ ...stale, doc: moved }, 'stale');
    unavailable({ ...stale, ctx: contextWith(topology.port) }, 'unverified');
    unavailable(rebuilt(doc, topology, 0.01, { analysisType: 'modal' }), 'no_analysis');
  });

  it('reports the ratio as unavailable for loads and results it cannot read', () => {
    unavailable(rebuilt(doc, topology, 0.01, { loadKind: 'pressure' }), 'unsupported');
    unavailable(rebuilt(doc, topology, 0.01, { nodeSet: [] }), 'unsupported');
    unavailable(rebuilt(doc, topology, 0.01, { nodeSet: [2, 99] }), 'unsupported');
    unavailable(rebuilt(doc, topology, 0.01, { displaced: false }), 'unsupported');
    unavailable(rebuilt(doc, topology, 0.01, { loadCase: 'OTHER' }), 'unsupported');
  });

  it('reports the ratio as unavailable when the optimum has no compliance to compare with', () => {
    const zero = solvedStudy(0);
    unavailable(rebuilt(zero.doc, zero.topology, 0.01), 'optimum_zero');
  });
});

describe('check_topology compliance ratio', () => {
  const { doc, topology } = solvedStudy(9);
  const items = (rebuild: Rebuilt): Array<{ code: string; severity: string }> =>
    data<{ items: Array<{ code: string; severity: string }> }>(
      execute(rebuild.doc, 'check_topology', { studyId: model.studyId, rebuildEntityIds: [rebuild.entityId] }, rebuild.ctx),
    ).items.filter((entry) => entry.code.startsWith('TOP_REBUILD'));

  it('is silent for a rebuild within the target, fails above it and warns when it is not analysed', () => {
    expect(items(rebuilt(doc, topology, 0.0099))).toEqual([]);
    expect(items(rebuilt(doc, topology, 0.0108))).toEqual([expect.objectContaining({ code: 'TOP_REBUILD_DEVIATION', severity: 'fail' })]);
    expect(items(rebuilt(doc, topology, 0.01, { solve: false }))).toEqual([
      expect.objectContaining({ code: 'TOP_REBUILD_NOT_ANALYSED', severity: 'warning' }),
    ]);
  });
});

describe('suggest_rebuild widthSamples', () => {
  type Samples = Array<{ at: number[]; width: number; widthMm: number }>;
  const widths = (rowsOn: (row: number) => boolean): Samples => {
    const field = Float32Array.from({ length: 1200 }, (_, n) => (rowsOn(Math.floor(n / 60)) ? 1 : 0));
    const artifact = buildTopologyArtifact(job, fieldBytes(field), { ...outcome, compliance: 9 }, 'topopt') as FeTopologyArtifact;
    const store = artifactStore();
    const hash = store.put(artifact);
    const ctx = contextWith(store.port);
    const recorded = execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: hash }, ctx).document;
    return data<{ widthSamples: Samples }>(execute(recorded, 'suggest_rebuild', { studyId: model.studyId }, ctx)).widthSamples;
  };

  it('measures a straight bar 4 voxels wide on its medial axis', () => {
    const samples = widths((row) => row >= 8 && row < 12);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.width).toBeCloseTo(4, 6);
      expect(sample.widthMm).toBeCloseTo(4, 6);
      expect(sample.at[1]).toBeCloseTo(10, 6);
    }
    expect(samples.length).toBeLessThanOrEqual(200);
  });

  it('samples two members of different width, widest first', () => {
    const samples = widths((row) => (row >= 2 && row < 6) || (row >= 10 && row < 18));
    expect(samples[0]?.width).toBeCloseTo(8, 6);
    expect(samples.some((sample) => Math.abs(sample.width - 4) < 1e-6)).toBe(true);
    expect([...samples].sort((a, b) => b.width - a.width)).toEqual(samples);
  });
});

describe('distanceToVoid', () => {
  it('is the exact Euclidean distance to the nearest void node', () => {
    const inside = Uint8Array.from({ length: 49 }, (_, n) => {
      const [i, j] = [n % 7, Math.floor(n / 7)];
      return i >= 1 && i <= 5 && j >= 1 && j <= 5 ? 1 : 0;
    });
    const distance = distanceToVoid(inside, 7, 7);
    expect(distance[3 + 7 * 3]).toBe(3);
    expect(distance[1 + 7 * 1]).toBe(1);
    expect(distance[0]).toBe(0);
  });
});
