/**
 * FE hot spots of a fatigue case (PHY-07 §5.6 step 4, TR-FAT-41): with a current FatigueField (every node counted and damaged by
 * `llull-compute post fatigue`) the `count` nodes of largest damage are ranked (static failures first, ties by mesh node order) and each
 * row is recomputed by the TypeScript code (rainflow, curve, Miner) — the reference — then checked against the native damage.
 */

import type { FatigueCase } from '@core/model/durability';
import type { FeArtifactPort } from '@core/model/analysis';
import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import type { CadDocument } from '@core/model/types';
import { ACCEPT_INADEQUATE_MESH } from '../margins/adequacyGate';
import { blocksAssessment } from '../results/adequacy';
import { inadequacyReasons } from '../results/adequacy';
import { nodeCoordinates, nodeEntities } from '../results/fields';
import { evaluateCycles, isEvaluationFailure, type Evaluation, type Failure } from './evaluate';
import { cyclesOfNode, fatigueFieldInput, FIELD_COMPONENTS, FLAG_BITS, readFatigueField } from './feField';
import { item, type Item } from './items';

/** Relative agreement required between the native and the TypeScript damage of a hot spot (VC-FAT-43: same formulas in f64). */
const NATIVE_TOLERANCE = 1e-12;

interface HotSpot {
  readonly rowKey: string;
  readonly node: number;
  readonly entityId: string;
  /** Node position, analysis length unit. */
  readonly at: readonly [number, number, number];
  readonly nativeDamage: number;
  readonly evaluation: Evaluation;
}

export interface FeEvaluation {
  readonly hotSpots: readonly HotSpot[];
  readonly items: readonly Item[];
  readonly resultsHash: string;
  readonly fatigueInputHash: string;
  readonly nodesEvaluated: number;
  readonly skippedNodes: number;
  readonly minMargin: number | null;
  /** `NOT_ASSESSED` when the mesh is inadequate and not accepted: the rows carry no verdict (FR-INT-06). */
  readonly status: Evaluation['status'] | 'NOT_ASSESSED';
  readonly adequacy: FeMeshAdequacy;
  /** `['acceptInadequateMesh']` when the caller's acceptance let an inadequate mesh through. */
  readonly overrides: readonly string[];
}

const STATUS_RANK: Readonly<Record<Evaluation['status'], number>> = { PASS: 0, MARGINAL: 1, FAIL: 2 };

/** Node indices by damage, largest first: static failures rank above everything, ties keep the mesh node order. */
function ranked(field: Float64Array, nodes: number): number[] {
  const width = FIELD_COMPONENTS.length;
  const key = (index: number): number =>
    ((field[index * width + 3] ?? 0) & FLAG_BITS.static_failure) !== 0 ? Number.POSITIVE_INFINITY : (field[index * width] ?? 0);
  return Array.from({ length: nodes }, (_, index) => index).sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka === kb ? a - b : kb > ka ? 1 : -1;
  });
}

const agrees = (native: number, reference: number): boolean =>
  native === reference || Math.abs(native - reference) <= NATIVE_TOLERANCE * Math.max(Math.abs(native), Math.abs(reference));

/**
 * Hot-spot evaluation of an FE-driven case from its current FatigueField.
 * @invariant an inadequate mesh (FR-INT-06) gives status NOT_ASSESSED, no minMargin and an error item FEA_MESH_INADEQUATE unless `acceptInadequateMesh`
 *   (then a warning item and overrides ['acceptInadequateMesh'])
 * @failure no scatter factor (when `needScatter`) -> FAT_SCATTER_FACTOR_UNSET; the job-input failures of `fatigueFieldInput`;
 *   no current field -> FAT_RESULTS_MISSING; a field bound to something else -> FAT_FIELD_INVALID
 */
export function evaluateFeCase(
  doc: CadDocument,
  fatigueCase: FatigueCase,
  artifacts: FeArtifactPort | null | undefined,
  needScatter: boolean,
  acceptInadequateMesh = false,
): FeEvaluation | Failure {
  if (needScatter && fatigueCase.factors.scatter === undefined)
    return { code: 'FAT_SCATTER_FACTOR_UNSET', message: 'no scatter factor on the case', ids: [fatigueCase.id] };
  const input = fatigueFieldInput(doc, fatigueCase.id, artifacts);
  if (isEvaluationFailure(input)) return input;
  const field = readFatigueField(artifacts, input);
  if (isEvaluationFailure(field)) return field;
  const coordinates = nodeCoordinates(input.mesh);
  const owners = nodeEntities(input.mesh);
  const count = Math.max(1, Math.floor(fatigueCase.locations.count));
  const items: Item[] = [];
  const seen = new Set<string>();
  const hotSpots = ranked(field, input.nodeIds.length)
    .slice(0, count)
    .map((index, rank): HotSpot => {
      const node = input.nodeIds[index] ?? 0;
      const evaluation = evaluateCycles(fatigueCase, cyclesOfNode(input, index), input.damage);
      const nativeDamage = field[index * FIELD_COMPONENTS.length] ?? Number.NaN;
      const rowKey = `h${rank + 1}`;
      if (!agrees(nativeDamage, evaluation.sum.damage))
        items.push(
          item(
            'FAT_NATIVE_MISMATCH',
            'error',
            `${rowKey} (node ${node}): native damage ${nativeDamage} differs from the reference ${evaluation.sum.damage}`,
            'report it; use the reference rows',
            [fatigueCase.id],
          ),
        );
      for (const entry of evaluation.items) {
        const signature = `${entry.code}|${entry.message}`;
        if (!seen.has(signature)) items.push(entry);
        seen.add(signature);
      }
      const at = coordinates.get(node) ?? [0, 0, 0];
      return { rowKey, node, entityId: owners.get(node) ?? '', at: [at[0], at[1], at[2]], nativeDamage, evaluation };
    });
  if (input.skippedNodes > 0)
    items.push(
      item(
        'FAT_NODES_SKIPPED',
        'warning',
        `${input.skippedNodes} mesh node(s) have no finite stress in every load case`,
        'check the results',
        [fatigueCase.id],
      ),
    );
  const inadequate = blocksAssessment(input.adequacy);
  const gated = inadequate && !acceptInadequateMesh;
  if (inadequate)
    items.push(
      item(
        'FEA_MESH_INADEQUATE',
        gated ? 'error' : 'warning',
        `the mesh of analysis '${fatigueCase.analysisId ?? ''}' is inadequate (${inadequacyReasons(input.adequacy).join('; ')}): ${gated ? 'the hot spots are not assessed' : 'hot spots computed anyway on acceptInadequateMesh'}`,
        'refine the mesh (fea_mesh, fea_solve) until the wall has the required element layers, or accept it with acceptInadequateMesh: true on the explicit decision of the engineer',
        [fatigueCase.analysisId ?? fatigueCase.id],
      ),
    );
  if (input.adequacy.verdict === 'marginal')
    items.push(
      item(
        'FEA_MESH_MARGINAL',
        'warning',
        `the mesh of analysis '${fatigueCase.analysisId ?? ''}' is marginal, a thin region is under-resolved but not gated (${inadequacyReasons(input.adequacy).join('; ')})`,
        'refine the mesh on the thin region (fea_mesh, fea_solve)',
        [fatigueCase.analysisId ?? fatigueCase.id],
      ),
    );
  const margins = hotSpots.map((spot) => spot.evaluation.margin);
  const minMargin = margins.some((margin) => margin === null) ? null : Math.min(...(margins as number[]));
  const status = hotSpots.reduce<Evaluation['status']>(
    (worst, spot) => (STATUS_RANK[spot.evaluation.status] > STATUS_RANK[worst] ? spot.evaluation.status : worst),
    'PASS',
  );
  return {
    hotSpots,
    items,
    resultsHash: input.resultsHash,
    fatigueInputHash: input.key,
    nodesEvaluated: input.nodeIds.length,
    skippedNodes: input.skippedNodes,
    minMargin: gated ? null : minMargin,
    status: gated ? 'NOT_ASSESSED' : status,
    adequacy: input.adequacy,
    overrides: inadequate && acceptInadequateMesh ? [ACCEPT_INADEQUATE_MESH] : [],
  };
}
