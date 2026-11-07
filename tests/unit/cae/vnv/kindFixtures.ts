/**
 * Fixtures of the time-step (dt) and element-order (p) convergence studies (PHY-00 VNV-M4): genuine content-addressed artifacts behind an in-memory port.
 * dt: a heat_transient box (end 8 s) whose end temperature is the first-order law T(dt) = T0 + K dt (hand oracle: observed order 1, extrapolated T0).
 * p: the 05 bar with the same grid at order 2 (quadratic tets) and order 1; the order-1 value is the order-2 value plus a known offset.
 */
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact, MeshControls } from '@core/model/analysis';
import type { StudyRefinement } from '@core/model/convergenceStudy';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { levelDocument } from '@cae/vnv/studyState';
import { barDocument, hashOf, mustRun } from '../deckFixtures';
import { gridMesh } from '../gridMesh';
import { thermalFixture } from '../thermal/fixtures';

/** The dt law: T(dt) = T0 + K dt; the order law: value(order 1) = value(order 2) + OFFSET. */
export const T0 = 20;
export const K = 0.5;
export const END_S = 8;
export const OFFSET = 3;
export const QUADRATIC = 40;

export interface KindBar {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly port: FeArtifactPort;
  readonly ctx: ExecutionContext;
  /** The params `study` of record_convergence_study exactly as the transport would send them. */
  readonly study: Record<string, unknown>;
  readonly levels: readonly { readonly controls: MeshControls; readonly h: number; readonly value: number }[];
}

interface LevelDefinition {
  readonly controls: MeshControls;
  readonly h: number;
  readonly value: number;
  readonly quadratic: boolean;
}

function assemble(
  doc: CadDocument,
  analysisId: string,
  boxId: string,
  refinement: StudyRefinement,
  quantity: Record<string, unknown>,
  unit: string,
  definitions: readonly LevelDefinition[],
  steps: (value: number, nodes: FeMeshArtifact['nodes']) => FeResultsArtifact['steps'],
): KindBar {
  const analysisCase = doc.analysis?.cases[analysisId];
  if (analysisCase === undefined) throw new Error('no case');
  const built = definitions.map((definition) => {
    const levelDoc = levelDocument(doc, analysisCase, refinement, definition);
    const grid = gridMesh({ cells: [2, 1, 1], size: [2, 1, 1], quadratic: definition.quadratic });
    const mesh: FeMeshArtifact = {
      kind: 'fe_mesh',
      unitSystem: analysisCase.unitSystem,
      mesher: 'test',
      mesherVersion: '1',
      inputHash: analysisInputHash(levelDoc, analysisId, 'mesh'),
      nodes: grid.nodes,
      blocks: [
        {
          type: definition.quadratic ? 'C3D10' : 'C3D4',
          entityId: boxId,
          elements: grid.elements.map((nodes, index) => [index + 1, ...nodes]),
        },
      ],
      nodeSets: {},
      faceSets: {},
      targets: {},
    };
    const results: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: hashOf(mesh),
      inputHash: analysisInputHash(levelDoc, analysisId, 'full'),
      solver: 'CalculiX',
      solverVersion: '2.21',
      steps: steps(definition.value, mesh.nodes),
    };
    return { ...definition, mesh, results };
  });
  const artifacts = built.flatMap((level) => [level.mesh, level.results]);
  const byHash = new Map<string, FeMeshArtifact | FeResultsArtifact>(artifacts.map((artifact) => [hashOf(artifact), artifact]));
  const port: FeArtifactPort = { get: (hash) => byHash.get(hash) ?? null };
  const study = {
    refinement,
    quantity,
    unit,
    ratio: 2,
    ...(refinement === 'h' ? { measure: { value: 2, dimension: 3 } } : {}),
    levels: built.map((level) => ({
      controls: level.controls,
      elements: level.mesh.blocks[0]?.elements.length ?? 0,
      h: level.h,
      value: level.value,
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
    analysisId,
    port,
    ctx: { ...defaultContext(), feaArtifacts: port },
    study,
    levels: built.map(({ controls, h, value }) => ({ controls, h, value })),
  };
}

const temperatureSteps = (value: number, nodes: FeMeshArtifact['nodes']): FeResultsArtifact['steps'] =>
  [END_S / 2, END_S].map((time, index) => ({
    step: index + 1,
    time,
    fields: {
      NDTEMP: { components: ['T'], values: Object.fromEntries(nodes.map((node) => [String(node[0]), [index === 0 ? value - 1 : value]])) },
    },
  }));

const stressSteps = (value: number, nodes: FeMeshArtifact['nodes']): FeResultsArtifact['steps'] => [
  {
    step: 1,
    time: 1,
    fields: {
      DISP: { components: ['D1', 'D2', 'D3'], values: Object.fromEntries(nodes.map((node) => [String(node[0]), [0, 0, 0]])) },
      STRESS: {
        components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
        values: Object.fromEntries(nodes.map((node) => [String(node[0]), [value, 0, 0, 0, 0, 0]])),
      },
    },
  },
];

/** A heat_transient box (end 8 s, fixed increments) with a temperature probe, and a dt study of it at increments `dts` (finest first; default 1, 2, 4 s). */
export function dtStudyBar(dts: readonly number[] = [1, 2, 4], law: (dt: number) => number = (dt) => T0 + K * dt): KindBar {
  const fixture = thermalFixture({ type: 'heat_transient', units: 'mm', size: [2, 1, 1] });
  let doc = mustRun(fixture.doc, 'set_thermal_step', {
    analysisId: fixture.analysisId,
    endTimeS: END_S,
    initialIncrementS: 1,
    fixedIncrements: true,
  });
  doc = mustRun(doc, 'add_result_probe', { analysisId: fixture.analysisId, name: 'corner', point: [0, 0, 0], quantity: 'temperature' });
  const analysisCase = doc.analysis?.cases[fixture.analysisId];
  const base = analysisCase?.mesh;
  if (base === undefined) throw new Error('no mesh controls');
  const probeId = Object.keys(analysisCase?.probes ?? {})[0] ?? 'missing';
  return assemble(
    doc,
    fixture.analysisId,
    fixture.boxId,
    'dt',
    { kind: 'probe', probeId },
    analysisCase?.thermal?.temperatureScale ?? 'degC',
    dts.map((dt) => ({ controls: base, h: dt, value: law(dt), quadratic: false })),
    temperatureSteps,
  );
}

/** The 05 bar with a von Mises study of order 2 (finest) then order 1 on one mesh size; the order-1 value is the order-2 one plus OFFSET. */
export function orderStudyBar(): KindBar {
  const bar = barDocument({ material: 'set' });
  const doc = mustRun(bar.doc, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: 0.5, order: 1 });
  const base = doc.analysis?.cases[bar.analysisId]?.mesh;
  if (base === undefined) throw new Error('no mesh controls');
  return assemble(
    doc,
    bar.analysisId,
    bar.boxId,
    'p',
    { kind: 'field_max', field: 'von_mises', loadCase: 'LC1' },
    'MPa',
    [
      { controls: { ...base, order: 2 }, h: 0.5, value: QUADRATIC, quadratic: true },
      { controls: { ...base, order: 1 }, h: 1, value: QUADRATIC + OFFSET, quadratic: false },
    ],
    stressSteps,
  );
}

/** The document after a verified record of `bar.study` (the study id is `affected[0]`). */
export function recordKind(bar: KindBar, extra: Record<string, unknown> = {}): { doc: CadDocument; studyId: string } {
  const result = execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: { ...bar.study, ...extra } }, bar.ctx);
  if (result.rejected === true) throw new Error(result.summary);
  return { doc: result.document, studyId: result.affected[0] ?? '' };
}
