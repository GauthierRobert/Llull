/** compute_margins fixtures: the solved 2 x 1 x 1 bar (sigma_vm = 210 MPa from the real ccx run) with strengths, factors and loads set BEFORE the solve. */
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import type { FactorSet, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { withCase } from '@cae/shared/access';
import { barDocument, barMesh, facesOn, hashOf, mustRun, portOf, X0_NODES, X2_NODES, type SolvedBar } from './deckFixtures';
import type { FeArtifactPort, FeMeshArtifact } from '@core/model/analysis';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';

/**
 * The 8-node, 6-tet fixture bar is NOT a fine mesh (one layer through its depth, measured inadequate): tests of the stress arithmetic opt in to
 * its mesh explicitly with these params (spread into the command params); nothing is stamped on the results.
 */
export const STAND_IN_MESH = { acceptInadequateMesh: true } as const;

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/margins' };

export const strengthModel = (property: string, value: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: property.toLowerCase(),
  property,
  unit: 'MPa',
  variables: [{ variable: 'T', unit: 'K' }],
  validity: [{ variable: 'T', unit: 'K', data: [250, 400] }],
  form: { kind: 'constant', value },
  basis: 'company',
  source: SOURCE,
  ...extra,
});

export interface MarginBarOptions {
  readonly ftu?: number | null;
  readonly fty?: number | null;
  readonly factors?: FactorSet;
  /** Category of the single load case LC1 (a force load is added for 'ultimate'); default: none (LC1, limit). */
  readonly category?: 'limit' | 'ultimate';
  readonly analysisType?: 'static' | 'thermo_static';
  readonly ftuExtra?: Record<string, unknown>;
  /** Mesh globalSize in mm (default 0.1: the singularity radius 0.2 mm reaches only the two point-support nodes). */
  readonly globalSize?: number;
  /** The point supports (nodes 1 and 3) are singular sources (no face in the mesh artifact). Default: false. */
  readonly pointSupportsSingular?: boolean;
  /**
   * A REAL mesh of the 2 x 1 x 1 bar instead of the 8-node stand-in (build it for the part id; its nodes must contain the corners): the results
   * carry the same uniform 210 MPa uniaxial field at every node, so the stress arithmetic is unchanged and the mesh is measured honestly.
   */
  readonly lattice?: (boxId: string) => FeMeshArtifact;
  /** A verdict to record on the results (display only: the gate always measures the mesh; used to prove a forged record gates nothing). */
  readonly recordedAdequacy?: unknown;
}

export interface MarginBar extends SolvedBar {
  readonly ctx: ExecutionContext;
  /** The document with mesh and results recorded (verified against `port`). */
  readonly recorded: CadDocument;
}

type Steps = FeResultsArtifact['steps'];

/** The faces (element id, CalculiX label) of the tets of `mesh` whose three nodes all lie in `nodeIds`. */
function facesIn(mesh: FeMeshArtifact, nodeIds: ReadonlySet<number>): [number, number][] {
  const labels = [
    [0, 1, 2],
    [0, 3, 1],
    [1, 3, 2],
    [2, 3, 0],
  ] as const;
  return (mesh.blocks[0]?.elements ?? []).flatMap((element) =>
    labels.flatMap((corner, index): [number, number][] =>
      corner.every((at) => nodeIds.has(element[at + 1] ?? -1)) ? [[element[0] ?? 0, index + 1]] : [],
    ),
  );
}

/** A lattice mesh of the bar with the node / face sets of the constraints and the uniform uniaxial results (sxx 210 MPa, ux = 0.001 x). */
function latticeOf(
  base: FeMeshArtifact,
  doc: CadDocument,
  analysisId: string,
  constraints: Record<string, string>,
  pullId: string,
): { mesh: FeMeshArtifact; steps: Steps } {
  const at = (x: number): Set<number> => new Set(base.nodes.filter((node) => node[1] === x).map((node) => node[0]));
  const nearest = (y: number): number =>
    (base.nodes.find((node) => node[1] === 0 && node[2] === y && node[3] === 0) ?? base.nodes[0])?.[0] ?? 1;
  const [x0, x2] = [at(0), at(2)];
  const mesh: FeMeshArtifact = {
    ...base,
    inputHash: analysisInputHash(doc, analysisId, 'mesh'),
    nodeSets: {
      [`C_${constraints['x0']}`]: [...x0],
      [`C_${constraints['nodeA']}`]: [nearest(0)],
      [`C_${constraints['nodeB']}`]: [nearest(1)],
      [`C_${pullId}`]: [...x2],
    },
    faceSets: {
      [`C_${constraints['x0']}`]: facesIn(base, x0),
      [`C_${constraints['nodeA']}`]: facesIn(base, x0),
      [`C_${constraints['nodeB']}`]: facesIn(base, x0),
      [`C_${pullId}`]: facesIn(base, x2),
    },
  };
  const values = (tensor: (node: FeMeshArtifact['nodes'][number]) => number[]): Record<string, number[]> =>
    Object.fromEntries(mesh.nodes.map((node) => [String(node[0]), tensor(node)]));
  return {
    mesh,
    steps: [
      {
        step: 1,
        time: 1,
        fields: {
          DISP: { components: ['D1', 'D2', 'D3'], values: values((node) => [0.001 * node[1], 0, 0]) },
          STRESS: { components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], values: values(() => [210, 0, 0, 0, 0, 0]) },
        },
      },
    ],
  };
}

/** Bar of ~210 MPa von Mises, strengths Ftu 300 / Fty 250 MPa by default. */
export function marginBar(options: MarginBarOptions = {}): MarginBar {
  const { ftu = 300, fty = 250, factors, category, analysisType = 'static' } = options;
  const bar = barDocument({ analysisType });
  let doc = bar.doc;
  if (ftu !== null) doc = mustRun(doc, 'define_property_model', { material: 'steel', model: strengthModel('Ftu', ftu, options.ftuExtra) });
  if (fty !== null) doc = mustRun(doc, 'define_property_model', { material: 'steel', model: strengthModel('Fty', fty) });
  const analysis = doc.analysis?.cases[bar.analysisId];
  if (factors !== undefined && analysis !== undefined) doc = withCase(doc, { ...analysis, factors });
  const pull = execute(doc, 'add_fea_constraint', {
    analysisId: bar.analysisId,
    name: 'pull',
    kind: 'displacement',
    dofs: { ux: 0.002 },
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  });
  doc = pull.document;
  if (category === 'ultimate') {
    doc = mustRun(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'ult',
      kind: 'force',
      loadCase: 'LC1',
      category: 'ultimate',
      vector: [1, 0, 0],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
  }
  doc = mustRun(doc, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: options.globalSize ?? 0.1 });
  const sets: Record<string, number[]> = {
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
    [`C_${pull.affected[0]}`]: X2_NODES,
  };
  const faces = {
    [`C_${bar.constraints['x0']}`]: facesOn(X0_NODES),
    [`C_${pull.affected[0]}`]: facesOn(X2_NODES),
    // the two point supports resolve to no face (singular sources) only with `pointSupportsSingular`; otherwise stand-in faces keep every node regular
    ...(options.pointSupportsSingular === true
      ? {}
      : { [`C_${bar.constraints['nodeA']}`]: facesOn(X0_NODES), [`C_${bar.constraints['nodeB']}`]: facesOn(X0_NODES) }),
  };
  const lattice =
    options.lattice === undefined
      ? null
      : latticeOf(options.lattice(bar.boxId), doc, bar.analysisId, bar.constraints, pull.affected[0] ?? '');
  const mesh = lattice?.mesh ?? barMesh(doc, bar.analysisId, bar.boxId, sets, faces);
  const meshHash = hashOf(mesh);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash,
    inputHash: analysisInputHash(doc, bar.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: lattice?.steps ?? parseFrd(readFileSync('tests/unit/cae/fixtures/static.frd', 'utf8')),
    ...(options.recordedAdequacy === undefined ? {} : ({ adequacy: options.recordedAdequacy } as Partial<FeResultsArtifact>)),
  };
  const resultsHash = hashOf(results);
  const port: FeArtifactPort = portOf(mesh, results);
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: port };
  const meshed = execute(doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, meshHash) }, ctx);
  const recorded = execute(
    meshed.document,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(doc, bar.analysisId, mesh, results, resultsHash) },
    ctx,
  ).document;
  return { ...bar, doc, mesh, meshHash, results, resultsHash, port, probeIds: { ux: '', mises: '' }, ctx, recorded };
}
