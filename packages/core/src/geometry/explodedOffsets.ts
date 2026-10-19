import type { ActiveExplodedView, ExplodedView } from '../model/joints';
import type { Vec3 } from '../model/vectors';

/**
 * Render-time displacement per entity id for the active exploded view (offsets whose step <= the active step); empty when none is active
 * or the view is unknown. Placements in the document are never changed: the viewport adds these to the entity positions it draws.
 * @pure
 */
export function activeExplodeOffsets(
  views: Readonly<Record<string, ExplodedView>> | undefined,
  active: ActiveExplodedView | undefined,
): Map<string, Vec3> {
  const result = new Map<string, Vec3>();
  const view = active === undefined || views === undefined ? undefined : views[active.id];
  if (active === undefined || view === undefined) return result;
  for (const offset of view.offsets) if (offset.step <= (active.step ?? Infinity)) result.set(offset.target, offset.vector);
  return result;
}
