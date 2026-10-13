/**
 * @layer ui/viewport/2d
 *
 * The 2D drawing of ONE solid, as the interaction layer sees it: the same `technicalView` the
 * viewport renders (frame `TOP_VIEW`), taken on its own — occlusion by other solids is irrelevant
 * to picking, box selection and snapping. Snapping, picking and box selection all read this one
 * result; there is no second projection of a solid.
 */

import { technicalView } from '@core/geometry/technicalView';
import { TOP_VIEW } from '@core/geometry/viewProjection';
import type { DrawingPrimitive } from '@core/model/drawing';
import { type CadDocument, type Entity, is3D } from '@core/model/types';

interface CachedDrawing {
  readonly primitives: DrawingPrimitive[];
  /** The component an instance was expanded from (a cache entry is stale once it changes). */
  readonly component: unknown;
}

/** Entities are immutable: an edit yields a new object, hence a new key. */
const drawingCache = new WeakMap<Entity, CachedDrawing>();

const NO_PRIMITIVES: DrawingPrimitive[] = [];

/**
 * Top-view drawing primitives of a 3D solid (no occlusion by other solids); `[]` for 2D shapes,
 * empty geometry and derived `bim` geometry (drawn per level elsewhere). Memoized per entity.
 */
export function solidDrawing(
  document: Partial<Pick<CadDocument, 'components'>>,
  entity: Entity,
): DrawingPrimitive[] {
  if (!is3D(entity) || entity.tags?.includes('bim') === true) return NO_PRIMITIVES;
  const components = document.components ?? {};
  const component = entity.kind === 'instance' ? components[entity.componentId] : undefined;
  const cached = drawingCache.get(entity);
  if (cached && cached.component === component) return cached.primitives;
  const primitives = technicalView({ components }, [entity], { frame: TOP_VIEW }).flatMap(
    (drawing) => drawing.primitives,
  );
  drawingCache.set(entity, { primitives, component });
  return primitives;
}
