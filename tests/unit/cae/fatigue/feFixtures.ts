/**
 * FE fatigue fixtures: a solved static analysis on a structured tet mesh with two load cases of seeded stress tensors (recorded and
 * verified against an in-memory artifact store), fatigue curves on the part material and an FE fatigue case driven by two load-factor
 * histories. The store resolves alias keys like the server store, so a FatigueField can be looked up by its input hash.
 */
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { barDocument, hashOf, mustRun } from '../deckFixtures';
import { gridMesh, seeded } from '../gridMesh';

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/fatigue/feFixtures' };

interface MemoryStore extends FeArtifactPort {
  put(artifact: FeMeshArtifact | FeResultsArtifact): string;
  alias(key: string, hash: string): void;
}

function memoryStore(): MemoryStore {
  const byHash = new Map<string, FeMeshArtifact | FeResultsArtifact>();
  const aliases = new Map<string, string>();
  return {
    put(artifact) {
      const hash = hashOf(artifact);
      byHash.set(hash, artifact);
      return hash;
    },
    alias: (key, hash) => void aliases.set(key, hash),
    get: (hash) => byHash.get(hash) ?? byHash.get(aliases.get(hash) ?? '') ?? null,
  };
}

const model = (id: string, body: Record<string, unknown>): Record<string, unknown> => ({
  material: 'steel',
  id,
  model: body,
  basis: 'company',
  source: SOURCE,
});

export interface FeFatigueOptions {
  readonly cells?: readonly [number, number, number];
  readonly steps?: number;
  readonly seed?: number;
  /** Extra create_fatigue_case params (override the defaults). */
  readonly caseParams?: Record<string, unknown>;
}

export interface FeFatigue {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext;
  readonly store: MemoryStore;
  readonly analysisId: string;
  readonly caseId: string;
  readonly histories: readonly [string, string];
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

/** Solved static analysis with load cases LC1 / LC2 and FE fatigue case `caseId` (stress_life, sn1, Goodman, scatter 3). */
export function feFatigue(options: FeFatigueOptions = {}): FeFatigue {
  const { cells = [4, 2, 2], steps = 40, seed = 7 } = options;
  const bar = barDocument();
  let doc = bar.doc;
  doc = mustRun(doc, 'set_material_property', {
    material: 'steel',
    property: 'Ftu',
    value: 900,
    unit: 'MPa',
    basis: 'company',
    source: SOURCE,
    preferred: true,
  });
  doc = mustRun(doc, 'set_material_property', {
    material: 'steel',
    property: 'Fty',
    value: 700,
    unit: 'MPa',
    basis: 'company',
    source: SOURCE,
    preferred: true,
  });
  const conditions = {
    stressRatio: -1,
    specimenKt: 1,
    probability: 'mean',
    control: 'load',
    testedLifeRange: { minCycles: 100, maxCycles: 1e7 },
  };
  doc = mustRun(
    doc,
    'add_material_model',
    model('sn1', { kind: 'sn_basquin', sigmaF: { value: 1160, unit: 'MPa' }, b: -0.081, conditions }),
  );
  doc = mustRun(
    doc,
    'add_material_model',
    model('sn2', { kind: 'sn_power_law', k: 5, nD: 2e6, sD: { value: 80, unit: 'MPa' }, k2: 9, conditions }),
  );
  doc = mustRun(
    doc,
    'add_material_model',
    model('sn3', {
      kind: 'sn_table',
      families: [
        {
          stressRatio: -1,
          points: [
            [1e3, 600],
            [1e5, 300],
            [1e7, 120],
          ],
          amplitudeUnit: 'MPa',
        },
      ],
      measure: 'amplitude',
      conditions,
    }),
  );
  doc = mustRun(
    doc,
    'add_material_model',
    model('en1', {
      kind: 'en_coffin_manson',
      sigmaF: { value: 1160, unit: 'MPa' },
      b: -0.081,
      epsF: 1.1,
      c: -0.65,
      E: { value: 210000, unit: 'MPa' },
      conditions: { ...conditions, control: 'strain' },
    }),
  );
  doc = mustRun(
    doc,
    'add_material_model',
    model('ro1', { kind: 'cyclic_ramberg_osgood', Kprime: { value: 1060, unit: 'MPa' }, nPrime: 0.14, E: { value: 210000, unit: 'MPa' } }),
  );
  for (const loadCase of ['LC1', 'LC2'])
    doc = mustRun(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: loadCase,
      kind: 'force',
      loadCase,
      category: 'limit',
      vector: loadCase === 'LC1' ? [100, 0, 0] : [0, 100, 0],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
  const grid = gridMesh({ cells, size: [2, 1, 1] });
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, bar.analysisId, 'mesh'),
    nodes: grid.nodes,
    blocks: [{ type: 'C3D4', entityId: bar.boxId, elements: grid.elements.map((nodes, index) => [index + 1, ...nodes]) }],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
  const random = seeded(seed);
  const field = (scale: number): Record<string, number[]> =>
    Object.fromEntries(
      grid.nodes.map(([id]) => [String(id), Array.from({ length: 6 }, (_, c) => (random() - (c < 3 ? 0.3 : 0.5)) * scale)]),
    );
  const disp = (): Record<string, number[]> => Object.fromEntries(grid.nodes.map(([id]) => [String(id), [random() * 1e-3, 0, 0]]));
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(doc, bar.analysisId, 'full'),
    solver: 'test',
    solverVersion: '1',
    steps: [1, 2].map((step) => ({
      step,
      time: step,
      fields: {
        STRESS: { components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], values: field(step === 1 ? 400 : 250) },
        DISP: { components: ['D1', 'D2', 'D3'], values: disp() },
      },
    })),
  };
  const store = memoryStore();
  const meshHash = store.put(mesh);
  const resultsHash = store.put(results);
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: store };
  doc = execute(doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, meshHash) }, ctx).document;
  doc = execute(
    doc,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(doc, bar.analysisId, mesh, results, resultsHash) },
    ctx,
  ).document;
  const history = (name: string, values: number[]): string => {
    const result = execute(doc, 'define_load_history', {
      name,
      kind: 'load_factor',
      unit: '-',
      data: { form: 'series', values },
      source: SOURCE,
    });
    doc = result.document;
    return result.affected[0] ?? '';
  };
  const h1 = history(
    'h1',
    Array.from({ length: steps }, () => random() * 2 - 0.8),
  );
  const h2 = history(
    'h2',
    Array.from({ length: steps }, () => random() * 2 - 1),
  );
  const created = execute(doc, 'create_fatigue_case', {
    name: 'fe',
    method: 'stress_life',
    analysisId: bar.analysisId,
    mapping: [
      { loadCase: 'LC1', historyId: h1, scale: 1 },
      { loadCase: 'LC2', historyId: h2, scale: 0.5 },
    ],
    material: { recordId: 'steel', modelId: 'sn1' },
    meanStress: 'goodman',
    locations: { mode: 'hotspots', count: 3 },
    requiredLife: { value: 1000, unit: 'blocks' },
    factors: { scatter: { value: 3, source: 'test' }, marginalBand: 0.5 },
    ...options.caseParams,
  });
  if (created.rejected === true) throw new Error(created.summary);
  return {
    doc: created.document,
    ctx,
    store,
    analysisId: bar.analysisId,
    caseId: created.affected[0] ?? '',
    histories: [h1, h2],
    mesh,
    results,
  };
}
