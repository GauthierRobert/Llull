/**
 * Convergence-study fixtures (PHY-00 VNV-M3): the 05 bar with a synthetic three-level mesh sequence whose von Mises is a known power law of the
 * representative spacing, f(h) = F0 + C h^2 (hand-derived oracle: observed order 2, extrapolated value F0). Artifacts are genuine content-addressed
 * mesh / results objects behind an in-memory port, so the record command verifies them exactly as it does against the server store.
 */
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact, MeshControls } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { representativeSpacing } from '@lib/convergence';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshMeasure } from '@cae/vnv/studyQuantity';
import { levelDocument } from '@cae/vnv/studyState';
import { barDocument, hashOf, mustRun } from '../deckFixtures';
import { gridMesh } from '../gridMesh';

/** Law of the synthetic solution: f(h) = F0 + C h^2. */
export const F0 = 100;
export const C = 2;
/** Cells (n x 2n x 2n... see `LEVELS`) of the finest, middle and coarsest level. */
const LEVELS: readonly number[] = [4, 2, 1];
/** Nominal global sizes (mm) of the levels, finest first. */
const SIZES: readonly number[] = [0.25, 0.5, 1];

export interface StudyBar {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly boxId: string;
  readonly probeId: string;
  readonly port: FeArtifactPort;
  readonly ctx: ExecutionContext;
  /** The params `study` of record_convergence_study exactly as the transport would send them. */
  readonly study: Record<string, unknown>;
  readonly levels: readonly {
    readonly controls: MeshControls;
    readonly mesh: FeMeshArtifact;
    readonly results: FeResultsArtifact;
    readonly h: number;
  }[];
}

const stressStep = (mesh: FeMeshArtifact, value: number): FeResultsArtifact['steps'] => [
  {
    step: 1,
    time: 1,
    fields: {
      DISP: { components: ['D1', 'D2', 'D3'], values: Object.fromEntries(mesh.nodes.map((node) => [String(node[0]), [0, 0, 0]])) },
      STRESS: {
        components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
        values: Object.fromEntries(mesh.nodes.map((node) => [String(node[0]), [value, 0, 0, 0, 0, 0]])),
      },
    },
  },
];

/** The artifacts of one level of `doc` meshed with `controls` on `cells` cells: uniform von Mises `value` everywhere. */
function levelArtifacts(
  doc: CadDocument,
  analysisId: string,
  boxId: string,
  controls: MeshControls,
  cells: number,
  value: (h: number) => number,
  volume: { current: number },
): { mesh: FeMeshArtifact; results: FeResultsArtifact; h: number } {
  const analysisCase = doc.analysis?.cases[analysisId];
  if (analysisCase === undefined) throw new Error('no case');
  const levelDoc = levelDocument(doc, analysisCase, controls);
  const grid = gridMesh({ cells: [2 * cells, cells, cells], size: [2, 1, 1] });
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(levelDoc, analysisId, 'mesh'),
    nodes: grid.nodes,
    blocks: [{ type: 'C3D4', entityId: boxId, elements: grid.elements.map((nodes, index) => [index + 1, ...nodes]) }],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
  const measure = meshMeasure(mesh);
  if ('code' in measure) throw new Error(measure.message);
  if (volume.current === 0) volume.current = measure.value;
  const h = representativeSpacing(volume.current, measure.elements, 3);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(levelDoc, analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: stressStep(mesh, value(h)),
  };
  return { mesh, results, h };
}

export interface StudyBarOptions {
  /** The bar's material: 'models' gives property models of basis typical (unverified, PHY-01). */
  readonly material?: 'set' | 'models';
  /** Value of level `h` (default the power law F0 + C h^2). */
  readonly value?: (h: number, level: number) => number;
}

/** The bar with a probe, the three level artifacts behind a port, and the params of the study. */
export function studyBar(options: StudyBarOptions = {}): StudyBar {
  const bar = barDocument({ material: options.material ?? 'set' });
  const probed = mustRun(bar.doc, 'add_result_probe', {
    analysisId: bar.analysisId,
    name: 'mid',
    point: [1, 0.5, 0.5],
    quantity: 'von_mises',
  });
  const doc = mustRun(probed, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: 0.25, order: 1 });
  const probeId = Object.keys(doc.analysis?.cases[bar.analysisId]?.probes ?? {})[0] ?? 'missing';
  const base = doc.analysis?.cases[bar.analysisId]?.mesh;
  if (base === undefined) throw new Error('no mesh controls');
  const volume = { current: 0 };
  const levels = LEVELS.map((cells, index) => {
    const controls: MeshControls = { ...base, globalSize: SIZES[index] ?? 1 };
    const value = (h: number): number => (options.value ?? ((x: number) => F0 + C * x * x))(h, index);
    return { controls, ...levelArtifacts(doc, bar.analysisId, bar.boxId, controls, cells, value, volume) };
  });
  const artifacts = levels.flatMap((level) => [level.mesh, level.results]);
  const byHash = new Map<string, FeMeshArtifact | FeResultsArtifact>(artifacts.map((artifact) => [hashOf(artifact), artifact]));
  const port: FeArtifactPort = { get: (hash) => byHash.get(hash) ?? null };
  const study = {
    quantity: { kind: 'field_max', field: 'von_mises', loadCase: 'LC1' },
    unit: 'MPa',
    ratio: 2,
    measure: { value: volume.current, dimension: 3 },
    levels: levels.map((level) => ({
      controls: level.controls,
      elements: level.mesh.blocks[0]?.elements.length ?? 0,
      h: level.h,
      value: (level.results.steps[0]?.fields['STRESS']?.values['1'] ?? [Number.NaN])[0],
      meshHash: level.results.meshHash,
      resultsHash: hashOf(level.results),
      inputHash: level.results.inputHash,
      solver: level.results.solver,
      solverVersion: level.results.solverVersion,
      mesher: level.mesh.mesher,
      mesherVersion: level.mesh.mesherVersion,
    })),
  };
  return {
    doc,
    analysisId: bar.analysisId,
    boxId: bar.boxId,
    probeId,
    port,
    ctx: { ...defaultContext(), feaArtifacts: port },
    study,
    levels,
  };
}

/** The document after a verified record_convergence_study of `bar.study` (the study id is `affected[0]`). */
export function recordedStudy(bar: StudyBar, extra: Record<string, unknown> = {}): { doc: CadDocument; studyId: string } {
  const result = execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: { ...bar.study, ...extra } }, bar.ctx);
  if (result.rejected === true) throw new Error(result.summary);
  return { doc: result.document, studyId: result.affected[0] ?? '' };
}
