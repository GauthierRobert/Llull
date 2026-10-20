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
import type { FeArtifactPort } from '@core/model/analysis';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';

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
}

export interface MarginBar extends SolvedBar {
  readonly ctx: ExecutionContext;
  /** The document with mesh and results recorded (verified against `port`). */
  readonly recorded: CadDocument;
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
  const mesh = barMesh(doc, bar.analysisId, bar.boxId, sets, faces);
  const meshHash = hashOf(mesh);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash,
    inputHash: analysisInputHash(doc, bar.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: parseFrd(readFileSync('tests/unit/cae/fixtures/static.frd', 'utf8')),
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
