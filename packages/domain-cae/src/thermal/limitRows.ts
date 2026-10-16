/** Rows of check_temperature_limits: one per limit and bound, computed from the temperature field of the results artifact (PHY-03 FR-THM-13). */

import type { FeMeshArtifact, FeResultsArtifact, Q, TemperatureLimit } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { toMetres } from '@core/model/units';
import type { CadDocument } from '@core/model/types';
import { analysisLengthMetres } from '../shared/defaults';
import { problem, type Problem, type ThermalCase } from './access';
import { inScale } from './quantities';
import { indexMesh, type MeshIndex } from './meshGeometry';

export type Bound = 'max' | 'min';
type RowStatus = 'PASS' | 'MARGINAL' | 'FAIL';

export interface LimitRow {
  readonly rowId: string;
  readonly limitId: string;
  readonly name: string;
  readonly scope: TemperatureLimit['scope'];
  readonly bound: Bound;
  readonly limit: Q;
  readonly computed: { readonly value: number; readonly unit: string };
  readonly marginK: number;
  readonly at: Vec3;
  readonly timeS: number;
  readonly status: RowStatus;
  readonly code?: string;
  readonly provenance: TemperatureLimit['source'];
}

export const rowIdOf = (limitId: string, bound: Bound): string => `${limitId}:${bound}`;

/** Nodes a limit applies to: the nodes of the part's elements, or the target's node set (else the nodes of its faces). */
function scopeNodes(limit: TemperatureLimit, index: MeshIndex, mesh: FeMeshArtifact): readonly number[] | Problem {
  if ('entityId' in limit.scope) {
    const entityId = limit.scope.entityId;
    const nodes = new Set<number>();
    for (const element of index.elements.values()) if (element.entityId === entityId) element.nodes.forEach((node) => nodes.add(node));
    return nodes.size === 0
      ? problem('FEA_TARGET_UNRESOLVED', `limit '${limit.id}': part '${entityId}' has no elements in the mesh`, [limit.id])
      : [...nodes].sort((a, b) => a - b);
  }
  const key = `T_${limit.id}`;
  const direct = Object.hasOwn(mesh.nodeSets, key) ? (mesh.nodeSets[key] ?? []) : [];
  if (direct.length > 0) return direct;
  const nodes = new Set<number>();
  for (const [elementId] of Object.hasOwn(mesh.faceSets, key) ? (mesh.faceSets[key] ?? []) : [])
    index.elements.get(elementId)?.nodes.forEach((node) => nodes.add(node));
  return nodes.size === 0
    ? problem('FEA_TARGET_UNRESOLVED', `limit '${limit.id}': its target has no nodes in the mesh`, [limit.id])
    : [...nodes].sort((a, b) => a - b);
}

/**
 * Rows for every limit and bound over all result times: the extreme temperature of the scope (first node, earliest time on a tie), the
 * margin in K (limit - T for max, T - limit for min) and the status. A band of `marginalBandK` makes margins below it MARGINAL.
 * @failure a limit whose scope has no nodes in the mesh -> FEA_TARGET_UNRESOLVED
 */
export function limitRows(
  doc: CadDocument,
  found: ThermalCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  marginalBandK: number | undefined,
): LimitRow[] | Problem {
  const { thermal } = found;
  const steady = found.analysisCase.type === 'heat_steady';
  const index = indexMesh(mesh);
  const scale = thermal.temperatureScale;
  const toDocument = toMetres(doc, 1) / analysisLengthMetres(found.analysisCase.unitSystem);
  const steps = results.steps.filter((step) => Object.hasOwn(step.fields, 'NDTEMP'));
  const rows: LimitRow[] = [];
  for (const limitId of thermal.limitOrder) {
    const limit = Object.hasOwn(thermal.limits, limitId) ? thermal.limits[limitId] : undefined;
    if (limit === undefined) continue;
    const nodes = scopeNodes(limit, index, mesh);
    if ('code' in nodes) return nodes;
    for (const bound of ['max', 'min'] as const) {
      const q = limit[bound];
      if (q === undefined) continue;
      let best = { value: bound === 'max' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY, node: nodes[0] ?? 0, time: 0 };
      for (const step of steps) {
        const values = step.fields['NDTEMP']?.values ?? {};
        for (const node of nodes) {
          const t = Object.hasOwn(values, String(node)) ? values[String(node)]?.[0] : undefined;
          if (t !== undefined && (bound === 'max' ? t > best.value : t < best.value)) best = { value: t, node, time: step.time };
        }
      }
      const limitValue = inScale(q, scale);
      const marginK = bound === 'max' ? limitValue - best.value : best.value - limitValue;
      const status: RowStatus = marginK < 0 ? 'FAIL' : marginalBandK !== undefined && marginK < marginalBandK ? 'MARGINAL' : 'PASS';
      const at = index.coordinates.get(best.node) ?? [0, 0, 0];
      rows.push({
        rowId: rowIdOf(limitId, bound),
        limitId,
        name: limit.name,
        scope: limit.scope,
        bound,
        limit: q,
        computed: { value: best.value, unit: scale },
        marginK,
        at: [at[0] / toDocument, at[1] / toDocument, at[2] / toDocument],
        timeS: steady ? 0 : best.time,
        status,
        ...(status === 'FAIL' ? { code: 'THM_LIMIT_EXCEEDED' } : status === 'MARGINAL' ? { code: 'THM_LIMIT_MARGINAL' } : {}),
        provenance: limit.source,
      });
    }
  }
  return rows;
}
