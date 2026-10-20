/** Warnings of the margin table about what it leaves out: composite shells (no ply criteria), singular zones that swallow a group or a large share of a part. */

import type { AnalysisCase, FeMeshArtifact } from '@core/model/analysis';
import { nodeEntities } from '../results/fields';

/** Excluded share of a part's nodes above which the singular screening is reported as large. */
const LARGE_EXCLUSION_FRACTION = 0.25;

/** The part is a composite shell: an isotropic von Mises margin against the entity's Ftu / Fty would be meaningless. */
export function isCompositeEntity(analysis: AnalysisCase, entityId: string): boolean {
  const idealization = Object.hasOwn(analysis.parts, entityId) ? analysis.parts[entityId] : undefined;
  return idealization?.kind === 'shell' && idealization.laminate !== undefined;
}

/**
 * One warning per composite shell part left out of the table, with the reason it got no ply-failure rows (`reasons` by entity id; without one the
 * part is reported with a generic reason). A composite shell that produced rows has no warning.
 */
export function compositeWarnings(analysis: AnalysisCase, reasons?: ReadonlyMap<string, string>): string[] {
  return Object.keys(analysis.parts)
    .filter((entityId) => isCompositeEntity(analysis, entityId) && (reasons === undefined || reasons.has(entityId)))
    .map(
      (entityId) =>
        `FEA_COMPOSITE_MARGINS_UNSUPPORTED: composite shell '${entityId}' has no margin rows (${reasons?.get(entityId) ?? 'ply failure margins were not computed'}; an isotropic von Mises margin would be wrong)`,
    );
}

/** One warning per part whose singular-excluded node share exceeds LARGE_EXCLUSION_FRACTION. */
export function exclusionWarnings(mesh: FeMeshArtifact, excluded: ReadonlySet<number>): string[] {
  if (excluded.size === 0) return [];
  const total = new Map<string, number>();
  const out = new Map<string, number>();
  for (const [node, entityId] of nodeEntities(mesh)) {
    total.set(entityId, (total.get(entityId) ?? 0) + 1);
    if (excluded.has(node)) out.set(entityId, (out.get(entityId) ?? 0) + 1);
  }
  return [...out]
    .filter(([entityId, count]) => count / (total.get(entityId) ?? count) > LARGE_EXCLUSION_FRACTION)
    .map(
      ([entityId, count]) =>
        `FEA_SINGULAR_EXCLUSION_LARGE: ${Math.round((100 * count) / (total.get(entityId) ?? count))} % of the nodes of '${entityId}' are excluded as singular (more than ${LARGE_EXCLUSION_FRACTION * 100} %)`,
    );
}

/** Singular rows whose group has no regular row (every node of the group is excluded): rowKeys without the `|singular` suffix. */
export function orphanSingularKeys(rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  const regular = new Set(rows.filter((row) => row['singular'] !== true).map((row) => String(row['rowKey'])));
  return rows
    .filter((row) => row['singular'] === true)
    .map((row) => String(row['rowKey']).replace(/\|singular$/, ''))
    .filter((key) => !regular.has(key));
}
