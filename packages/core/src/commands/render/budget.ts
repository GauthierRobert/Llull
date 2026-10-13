/**
 * Fair polygon budget for render_view: every entity keeps a share of the budget (water-filling),
 * large meshes are decimated instead of starving the entities that follow them.
 */

import type { PreDepthPolygon } from './types';

export const MAX_POLYGONS = 20000;

/** One entity's polygons, in document order. */
export interface EntityPolygons {
  id: string;
  polygons: PreDepthPolygon[];
}

export interface BudgetResult {
  polygons: PreDepthPolygon[];
  simplifiedEntityIds: string[];
  skippedEntityIds: string[];
}

/** Push without spreading (a mesh can exceed the argument limit). */
function append(target: PreDepthPolygon[], source: readonly PreDepthPolygon[]): void {
  for (const poly of source) target.push(poly);
}

/** `keep` polygons spread evenly over `source`, each marked with the decimation ratio. */
function decimate(source: PreDepthPolygon[], keep: number): PreDepthPolygon[] {
  const inflate = source.length / keep;
  const picked: PreDepthPolygon[] = [];
  for (let i = 0; i < keep; i++) {
    const poly = source[Math.floor(i * inflate)] as PreDepthPolygon;
    picked.push({ ...poly, inflate });
  }
  return picked;
}

/**
 * Fit all entities into `budget` filled polygons. Strokes (2D) and cut caps are never dropped.
 * Entities are served smallest first so a big mesh only absorbs what the small ones leave over;
 * when there are more entities than budget, the last ones in document order are skipped.
 */
export function applyBudget(items: readonly EntityPolygons[], budget: number): BudgetResult {
  const filledCount = (item: EntityPolygons): number => item.polygons.filter((p) => !p.stroke && p.loops === undefined).length;
  const order = items.map((item, index) => ({ item, index, count: filledCount(item) })).filter(({ count }) => count > 0);
  order.sort((a, b) => a.count - b.count || a.index - b.index);

  const allowance = new Map<string, number>();
  let remaining = Math.max(0, Math.floor(budget));
  order.forEach(({ item, count }, rank) => {
    const share = Math.floor(remaining / (order.length - rank));
    const granted = Math.min(count, share);
    allowance.set(item.id, granted);
    remaining -= granted;
  });

  const polygons: PreDepthPolygon[] = [];
  const simplifiedEntityIds: string[] = [];
  const skippedEntityIds: string[] = [];
  for (const item of items) {
    const granted = allowance.get(item.id);
    const solids = item.polygons.filter((p) => !p.stroke && p.loops === undefined);
    const extras = item.polygons.filter((p) => p.stroke || p.loops !== undefined);
    if (granted === undefined) {
      append(polygons, extras);
    } else if (granted === 0) {
      skippedEntityIds.push(item.id);
    } else if (granted < solids.length) {
      simplifiedEntityIds.push(item.id);
      append(polygons, decimate(solids, granted));
      append(polygons, extras);
    } else {
      append(polygons, solids);
      append(polygons, extras);
    }
  }
  return { polygons, simplifiedEntityIds, skippedEntityIds };
}
