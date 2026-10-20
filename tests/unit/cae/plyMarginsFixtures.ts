/** Ply-failure margin fixtures: a 10 x 10 mm composite shell plate (one S4 element in z = 0, plies stacked along +z) with hand-built fibre stresses. */
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { AnalysisCase, FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CompositesModel, LaminaMaterial } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { withCase } from '@cae/shared/access';
import { barDocument, hashOf, portOf } from './deckFixtures';
import { composites } from './shellFixtures';

/** Lamina of the stack: UD tape with a cited basis (verified data) and all five strengths. */
export const TAPE: LaminaMaterial = {
  name: 'tape',
  form: 'ud_tape',
  E1: 135000,
  E2: 10000,
  G12: 5000,
  G23: 3500,
  nu12: 0.3,
  Xt: 1500,
  Xc: 1200,
  Yt: 50,
  Yc: 200,
  S: 80,
  plyThickness: 0.125,
  density: 0.0016,
  basis: 'b_basis',
  source: 'cited datasheet (illustrative)',
};

export interface CompositeShell {
  readonly doc: CadDocument;
  readonly recorded: CadDocument;
  readonly analysisId: string;
  readonly boxId: string;
  readonly ctx: ExecutionContext;
  readonly mesh: FeMeshArtifact;
}

export interface ShellOptions {
  /** Lamina records (default: TAPE). */
  readonly material?: LaminaMaterial;
  /** Ply angles bottom to top (default [0, 90, 90, 0]). */
  readonly angles?: readonly number[];
  /** Rosette id of each ply (default ro-1, x axis; ro-2 has its 0-degree axis along y). */
  readonly rosettes?: readonly string[];
  readonly analysisType?: 'static' | 'thermo_static';
  /** Global stress [xx, yy, zz, xy, yz, zx] at the top / bottom fibre of every node; null = the field is absent. */
  readonly top: readonly number[] | null;
  readonly bottom: readonly number[] | null;
  /** Category of the load case (a limit case by default). */
  readonly factorUltimate?: number;
}

const NODES: FeMeshArtifact['nodes'] = [
  [1, 0, 0, 0],
  [2, 10, 0, 0],
  [3, 10, 10, 0],
  [4, 0, 10, 0],
];
const COMPONENTS = ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'];

export function compositeShell(options: ShellOptions): CompositeShell {
  const bar = barDocument(options.analysisType === undefined ? {} : { analysisType: options.analysisType });
  let doc = bar.doc;
  const analysis = doc.analysis?.cases[bar.analysisId] as AnalysisCase;
  const shell: AnalysisCase = {
    ...analysis,
    ...(options.factorUltimate === undefined ? {} : { factors: { ...analysis.factors, ultimate: options.factorUltimate } }),
    parts: {
      [bar.boxId]: {
        kind: 'shell',
        thickness: 0.5,
        offset: 'mid',
        midsurface: { maxThickness: 1, angularTolDeg: 1 },
        laminate: { compositePartId: 'cp-1' },
      },
    },
  };
  doc = withCase(doc, shell);
  const base = composites(bar.boxId);
  const angles = options.angles ?? [0, 90, 90, 0];
  const material = options.material ?? TAPE;
  const model: CompositesModel = {
    ...base,
    materials: { tape: material },
    rosettes: {
      ...base.rosettes,
      'ro-2': { id: 'ro-2', name: 'ro2', origin: [0, 0, 2], axis0: [0, 1, 0], normal: [0, 0, 1], method: 'translational' },
    },
    plies: Object.fromEntries(
      angles.map((angle, order) => [
        `p${order + 1}`,
        {
          id: `p${order + 1}`,
          name: `P${order + 1}`,
          partId: 'cp-1',
          order,
          sequence: 'A',
          materialName: 'tape',
          orientation: angle,
          rosetteId: options.rosettes?.[order] ?? 'ro-1',
          boundary: { kind: 'whole_face' as const },
        },
      ]),
    ),
    plyOrder: angles.map((_, order) => `p${order + 1}`),
  };
  doc = { ...doc, composites: model };
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, bar.analysisId, 'mesh'),
    nodes: NODES,
    blocks: [{ type: 'S4', entityId: bar.boxId, elements: [[1, 1, 2, 3, 4]] }],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
  const field = (stress: readonly number[]): { components: readonly string[]; values: Record<string, readonly number[]> } => ({
    components: COMPONENTS,
    values: Object.fromEntries(NODES.map(([id]) => [String(id), stress])),
  });
  const mid =
    options.top !== null && options.bottom !== null ? options.top.map((v, i) => (v + (options.bottom?.[i] ?? 0)) / 2) : [0, 0, 0, 0, 0, 0];
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(doc, bar.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: [
      {
        step: 1,
        time: 1,
        fields: {
          STRESS: field(mid),
          ...(options.top === null ? {} : { STRESS_TOP: field(options.top) }),
          ...(options.bottom === null ? {} : { STRESS_BOT: field(options.bottom) }),
        },
      },
    ],
  };
  const port: FeArtifactPort = portOf(mesh, results);
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: port };
  const meshed = execute(doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, hashOf(mesh)) }, ctx);
  const recorded = execute(
    meshed.document,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(doc, bar.analysisId, mesh, results, hashOf(results)) },
    ctx,
  );
  if (recorded.rejected === true) throw new Error(`record_fea_results: ${recorded.summary}`);
  return { doc, recorded: recorded.document, analysisId: bar.analysisId, boxId: bar.boxId, ctx, mesh };
}
