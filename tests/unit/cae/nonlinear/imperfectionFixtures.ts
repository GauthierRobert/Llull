/** PHY-05 imperfection fixtures: the pressure bar (nonlinear_static) next to a SOLVED buckling case on the same part and the same 8-node mesh. */
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseDat } from '@cae/results/datReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { BAR_NODES, X0_NODES, X2_NODES, barMesh, facesOn, hashOf, portOf } from '../deckFixtures';
import { bucklingDat } from '../eigenFixtures';
import { pressureBar, step, type PressureBar } from './support';

export const FACTORS = [4.5, 9.1] as const;

/** Mode 1: uy = x (peak 2 at x = 2); mode 2: uz = -x * y (peak 2 at x = 2, y = 1); mode 3: ux = y. Every node of the bar has a value. */
const MODE_SHAPES: readonly ((x: number, y: number) => [number, number, number])[] = [
  (x) => [0, x, 0],
  (x, y) => [0, 0, -x * y],
  (_x, y) => [y, 0, 0],
];

export interface ImperfectBar extends PressureBar {
  readonly bucklingId: string;
  readonly bucklingMesh: FeMeshArtifact;
  readonly bucklingResults: FeResultsArtifact;
  readonly bucklingResultsHash: string;
  /** Port holding the four artifacts (both meshes, buckling results). */
  readonly ctx: ExecutionContext;
}

/** Results artifact of the buckling case: two mode sets (time = buckling factor) and the factor table. */
function bucklingResults(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, factors: readonly number[]): FeResultsArtifact {
  return {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(doc, analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: factors.map((factor, index) => ({
      step: 1,
      time: factor,
      fields: {
        DISP: {
          components: ['D1', 'D2', 'D3'],
          values: Object.fromEntries(BAR_NODES.map(([id, x, y]) => [String(id), MODE_SHAPES[index]?.(x, y) ?? [0, 0, 0]])),
        },
      },
    })),
    dat: parseDat(bucklingDat(factors)),
  };
}

/** The pressure bar (nlgeom as given) plus buckling case (factors as given; ccx can report a negative factor for a load reversal) `bk` with the x = 0 face fixed and an end force, meshed and solved (recorded). */
export function imperfectBar(nlgeom = true, factors: readonly number[] = FACTORS): ImperfectBar {
  const bar = pressureBar({ controls: { nlgeom } });
  let doc = bar.doc;
  const created = step(doc, 'create_analysis', { name: 'bk', analysisType: 'buckling', modes: factors.length });
  const bucklingId = created.id;
  doc = step(created.doc, 'set_part_idealization', { analysisId: bucklingId, entityId: bar.boxId }).doc;
  const fixed = step(doc, 'add_fea_constraint', {
    analysisId: bucklingId,
    name: 'base',
    kind: 'fixed',
    target: { entityId: bar.boxId, facesNear: [[0, 0.5, 0.5]] },
  });
  const load = step(fixed.doc, 'add_fea_load', {
    analysisId: bucklingId,
    name: 'axial',
    kind: 'force',
    loadCase: 'LC1',
    vector: [-1, 0, 0],
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  });
  doc = load.doc;
  const bucklingMesh = barMesh(
    doc,
    bucklingId,
    bar.boxId,
    { [`C_${fixed.id}`]: X0_NODES, [`L_${load.id}`]: X2_NODES },
    { [`L_${load.id}`]: facesOn(X2_NODES) },
  );
  const results = bucklingResults(doc, bucklingId, bucklingMesh, factors);
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(bar.mesh, bucklingMesh, results) };
  const meshed = execute(doc, 'record_fe_mesh', { analysisId: bucklingId, summary: meshSummary(bucklingMesh, hashOf(bucklingMesh)) }, ctx);
  if (meshed.error !== undefined) throw new Error(meshed.summary);
  const summary = resultsSummary(meshed.document, bucklingId, bucklingMesh, results, hashOf(results));
  const solved = execute(meshed.document, 'record_fea_results', { analysisId: bucklingId, summary }, ctx);
  if (solved.error !== undefined) throw new Error(solved.summary);
  return { ...bar, doc: solved.document, bucklingId, bucklingMesh, bucklingResults: results, bucklingResultsHash: hashOf(results), ctx };
}

export const SOURCE_TEXT = 'unit fixture amplitude (not a design rule)';
