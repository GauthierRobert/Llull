import type { ActiveExplodedView, ExplodedView } from '../model/joints';
import type { CadDocument } from '../model/types';
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

/**
 * `doc` with every entity of the active exploded view drawn at its exploded position (render-only copy; the input is untouched and
 * returned as is when no view is active). Shared by renderers that must match the viewport (render_view).
 * @pure
 */
export function withExplodedPositions(doc: CadDocument): CadDocument {
  const offsets = activeExplodeOffsets(doc.explodedViews, doc.activeExplodedView);
  if (offsets.size === 0) return doc;
  const entities = { ...doc.entities };
  for (const [id, shift] of offsets) {
    const entity = entities[id];
    if (entity === undefined) continue;
    const position: Vec3 = [entity.position[0] + shift[0], entity.position[1] + shift[1], entity.position[2] + shift[2]];
    entities[id] = { ...entity, position };
  }
  return { ...doc, entities };
}
