/** Values of one result field at mesh nodes (05 §4 `fea_result_field`): statistics over the result set and the selected nodes, from a verified results artifact. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { lengthUnitName } from '../decks/units';
import { nodeCoordinates, nodeEntities } from './fields';
import { selectStep } from './plotSetup';
import { QUANTITY_FIELDS, quantityScale, quantityUnit } from './probes';

/** Fields `fea_result_field` reads (the non-cylindrical probe quantities). */
export const RESULT_FIELDS = Object.keys(QUANTITY_FIELDS) as readonly (keyof typeof QUANTITY_FIELDS)[];

interface FieldRow {
  readonly node: number;
  /** Node position in the analysis length unit. */
  readonly at: Vec3;
  readonly value: number;
  readonly entityId: string;
  /** Distance from the requested point (analysis length unit), for `points` / `probes` selections. */
  readonly distance?: number;
}

export interface ResultFieldData {
  readonly field: string;
  readonly unit: string;
  readonly lengthUnit: string;
  readonly resultSet: string;
  readonly selection: 'extremes' | 'nodes' | 'points' | 'probes';
  readonly count: number;
  readonly min: { readonly value: number; readonly node: number; readonly at: Vec3 } | null;
  readonly max: { readonly value: number; readonly node: number; readonly at: Vec3 } | null;
  readonly mean: number | null;
  readonly rows: readonly FieldRow[];
  /** Requested node ids that are not in the mesh or have no value in this result set. */
  readonly missingNodes: readonly number[];
}

export interface FieldQuery {
  readonly field: (typeof RESULT_FIELDS)[number];
  readonly loadCase?: string | undefined;
  readonly mode?: number | undefined;
  readonly nodes?: readonly number[] | undefined;
  /** Points in ANALYSIS length units (the caller converts from document units). */
  readonly points?: readonly Vec3[] | undefined;
  readonly probes?: boolean | undefined;
  readonly order: 'largest' | 'smallest';
  readonly limit: number;
}

/**
 * The field at the selected nodes and its statistics over the whole result set. Selection: explicit `nodes`, nearest nodes of `points`, nearest nodes of the
 * case's probes, else the `limit` nodes with the largest (or smallest) value (ties by node id).
 * @failure unselectable result set / field absent in it -> `{ code, message }`
 */
export function resultField(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  query: FieldQuery,
  lengthToAnalysis: number,
): ResultFieldData | { readonly code: string; readonly message: string } {
  const selected = selectStep(analysis, results, query.loadCase, undefined, query.mode);
  if (typeof selected === 'string') return { code: 'FEA_RESULTS_MISSING', message: selected };
  const spec = QUANTITY_FIELDS[query.field];
  const raw = selected.step.fields[spec.field]?.values;
  if (raw === undefined)
    return { code: 'FEA_FIELD_MISSING', message: `the ${selected.label} result set has no ${spec.field} field for ${query.field}` };
  const scale = quantityScale(analysis, query.field);
  const coordinates = nodeCoordinates(mesh);
  const entities = nodeEntities(mesh);
  const valueOf = (node: number): number | null => {
    const values = raw[String(node)];
    return values === undefined ? null : spec.scalar(values) * scale;
  };
  const all: FieldRow[] = [];
  for (const [node, at] of coordinates) {
    const value = valueOf(node);
    if (value !== null && Number.isFinite(value)) all.push({ node, at, value, entityId: entities.get(node) ?? '' });
  }
  const nearest = (point: Vec3): FieldRow | null => {
    let best: FieldRow | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of all) {
      const distance = Math.hypot(row.at[0] - point[0], row.at[1] - point[1], row.at[2] - point[2]);
      if (distance < bestDistance) {
        best = { ...row, distance };
        bestDistance = distance;
      }
    }
    return best;
  };
  const byNode = new Map(all.map((row) => [row.node, row]));
  const missingNodes: number[] = [];
  let rows: FieldRow[];
  let selection: ResultFieldData['selection'] = 'extremes';
  if (query.nodes !== undefined) {
    selection = 'nodes';
    rows = query.nodes.flatMap((node) => {
      const row = byNode.get(node);
      if (row === undefined) missingNodes.push(node);
      return row === undefined ? [] : [row];
    });
  } else if (query.points !== undefined) {
    selection = 'points';
    rows = query.points.flatMap((point) => nearest(point) ?? []);
  } else if (query.probes === true) {
    selection = 'probes';
    rows = Object.values(analysis.probes).flatMap(
      (probe) => nearest([probe.point[0] * lengthToAnalysis, probe.point[1] * lengthToAnalysis, probe.point[2] * lengthToAnalysis]) ?? [],
    );
  } else {
    const sign = query.order === 'largest' ? -1 : 1;
    rows = [...all].sort((a, b) => sign * (a.value - b.value) || a.node - b.node).slice(0, query.limit);
  }
  const extreme = (pick: (a: number, b: number) => boolean): ResultFieldData['min'] => {
    let best: FieldRow | null = null;
    for (const row of all) if (best === null || pick(row.value, best.value)) best = row;
    return best === null ? null : { value: best.value, node: best.node, at: best.at };
  };
  return {
    field: query.field,
    unit: quantityUnit(analysis, query.field),
    lengthUnit: lengthUnitName(analysis.unitSystem),
    resultSet: selected.label,
    selection,
    count: all.length,
    min: extreme((a, b) => a < b),
    max: extreme((a, b) => a > b),
    mean: all.length === 0 ? null : all.reduce((sum, row) => sum + row.value, 0) / all.length,
    rows,
    missingNodes,
  };
}
