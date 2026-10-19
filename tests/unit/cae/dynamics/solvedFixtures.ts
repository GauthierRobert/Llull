/**
 * Solved PHY-09 cases without CalculiX: a structured tet mesh of the 100 x 20 x 3 mm strip whose frequency-step results carry the
 * Euler-Bernoulli modes of VC-DYN-21 (deflection u_z = phi(x), sigma_xx = E (z - h/2) phi''(x), participation G_z, effective mass G^2 of a
 * unit total), laid out exactly like a parsed CalculiX artifact (eigenvalue / participation / effective-mass / total tables in `dat`,
 * one DISP + STRESS set per mode in step 1, DISP / DISPI sets per frequency in step 2). Recorded through record_fe_mesh / record_fea_results.
 */
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { DAT_TITLES } from '@cae/results/datReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { randomFieldInput, randomFieldReference, withNodalRms } from '@cae/dynamics/nodalField';
import { isPostProblem } from '@cae/dynamics/randomSetup';
import { hashOf } from '../deckFixtures';
import { gridMesh } from '../gridMesh';
import { EB, ebField, ebModes } from './ebCantilever';
import { mustRun } from './fixtures';

type Steps = FeResultsArtifact['steps'][number][];

interface MemoryStore extends FeArtifactPort {
  put(artifact: FeMeshArtifact | FeResultsArtifact): string;
}

function memoryStore(): MemoryStore {
  const byHash = new Map<string, FeMeshArtifact | FeResultsArtifact>();
  return {
    put: (artifact) => {
      const hash = hashOf(artifact);
      byHash.set(hash, artifact);
      return hash;
    },
    get: (hash) => byHash.get(hash) ?? null,
  };
}

/** Mesh of the strip for the current mesh inputs of `analysisId` (C3D4, 10 x 2 x 1 cells). */
export function stripMesh(
  doc: CadDocument,
  analysisId: string,
  boxId: string,
  cells: readonly [number, number, number] = [10, 2, 1],
): FeMeshArtifact {
  const grid = gridMesh({ cells, size: [EB.L, EB.b, EB.h] });
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, analysisId, 'mesh'),
    nodes: grid.nodes,
    blocks: [{ type: 'C3D4', entityId: boxId, elements: grid.elements.map((nodes, i) => [i + 1, ...nodes]) }],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
}

/** Frequency-step tables and mode sets of the first `modes` EB modes on `mesh`. */
export function modalResults(mesh: FeMeshArtifact, modes = 6): { dat: NonNullable<FeResultsArtifact['dat']>; steps: Steps } {
  const data = ebModes(modes);
  const fields = data.map((_, index) => ebField(index));
  const eigen = data.map((m, j) => [j + 1, m.omega * m.omega, m.omega, m.fHz, 0]);
  const participation = data.map((m, j) => [j + 1, 0, 0, m.gamma, 0, 0, 0]);
  const effective = data.map((m, j) => [j + 1, 0, 0, m.gamma * m.gamma, 0, 0, 0]);
  const steps: Steps = data.map((m, j) => {
    const disp: Record<string, number[]> = {};
    const stress: Record<string, number[]> = {};
    for (const [id, x, , z] of mesh.nodes) {
      disp[String(id)] = [0, 0, fields[j]?.shape(x / EB.L) ?? 0];
      stress[String(id)] = [fields[j]?.stress(x / EB.L, z) ?? 0, 0, 0, 0, 0, 0];
    }
    return {
      step: 1,
      time: m.fHz,
      fields: {
        DISP: { components: ['D1', 'D2', 'D3'], values: disp },
        STRESS: { components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], values: stress },
      },
    };
  });
  return {
    dat: {
      tables: [
        { title: 'eigenvalues (mode, eigenvalue, real part rad/time, frequency cycles/time, imaginary part)', time: 0, rows: eigen },
        { title: DAT_TITLES.participation, time: 0, rows: participation },
        { title: DAT_TITLES.effectiveMass, time: 0, rows: effective },
        { title: DAT_TITLES.totalMass, time: 0, rows: [[1, 1, 1, 1, 1, 1]] },
      ],
    },
    steps,
  };
}

export interface Solved {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext;
  readonly store: MemoryStore;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
  readonly resultsHash: string;
}

/** Records `mesh` and `results` (built for the current inputs) through the registry, verified against an in-memory store. */
export function recordSolved(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  build: (meshHash: string) => FeResultsArtifact,
): Solved {
  const store = memoryStore();
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: store };
  const meshHash = store.put(mesh);
  const meshed = mustRun(doc, 'record_fe_mesh', { analysisId, summary: meshSummary(mesh, meshHash) }, ctx);
  const results = build(meshHash);
  const resultsHash = store.put(results);
  const solved = mustRun(
    meshed,
    'record_fea_results',
    { analysisId, summary: resultsSummary(meshed, analysisId, mesh, results, resultsHash) },
    ctx,
  );
  return { doc: solved, ctx, store, mesh, results, resultsHash };
}

/** A random_response strip (fixtures.readyRandomStrip + probes) solved with the EB modal basis and the TS nodal rms field. */
export function solvedRandom(doc: CadDocument, analysisId: string, boxId: string, modes = 6): Solved {
  const mesh = stripMesh(doc, analysisId, boxId);
  return recordSolved(doc, analysisId, mesh, (meshHash) => {
    const partial: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash,
      inputHash: analysisInputHash(doc, analysisId, 'full'),
      solver: 'calculix',
      solverVersion: 'test',
      ...modalResults(mesh, modes),
    };
    const input = randomFieldInput(doc, analysisId, mesh, partial);
    if (isPostProblem(input)) throw new Error(input.message);
    const withField = withNodalRms(partial, input, randomFieldReference(input), 'ts', 'llull random (TypeScript reference)', 'test');
    if (typeof withField === 'string') throw new Error(withField);
    return withField;
  });
}
