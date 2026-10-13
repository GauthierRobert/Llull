/**
 * @layer ui/viewport/2d
 *
 * The 2D drawing of ONE solid, as the interaction layer sees it: the same `technicalView` the
 * viewport renders (frame `TOP_VIEW`, same section `cutDepth`), taken on its own — occlusion by
 * other solids is irrelevant to picking, box selection and snapping. Snapping, picking and box
 * selection all read this one result (primitives, edge segments, snap points: memoized together).
 */

import { expansionDependency } from '@core/geometry/instanceExpansion';
import { technicalView } from '@core/geometry/technicalView';
import { type Segment2, TOP_VIEW } from '@core/geometry/viewProjection';
import type { DrawingPrimitive } from '@core/model/drawing';
import { type CadDocument, type Entity, is3D } from '@core/model/types';
import type { SnapPoint } from './snapping/types';
import { drawingSegments } from './solidDrawingEdges';
import { drawingSnapPoints } from './solidDrawingSnaps';

interface CachedDrawing {
  readonly primitives: DrawingPrimitive[];
  readonly cutDepth: number | undefined;
  /** What the expansion depends on beyond the entity (see `expansionDependency`). */
  readonly dependency: unknown;
  segments?: Segment2[];
  snaps?: SnapPoint[];
}

/** Entities are immutable: an edit yields a new object, hence a new key. */
const drawingCache = new WeakMap<Entity, CachedDrawing>();

const EMPTY: CachedDrawing = { primitives: [], cutDepth: undefined, dependency: undefined };

function cachedDrawing(document: Pick<CadDocument, 'components'>, entity: Entity, cutDepth: number | undefined): CachedDrawing {
  if (!is3D(entity) || entity.tags?.includes('bim') === true) return EMPTY;
  const dependency = expansionDependency(entity, document);
  const cached = drawingCache.get(entity);
  if (cached && cached.cutDepth === cutDepth && cached.dependency === dependency) return cached;
  const primitives = technicalView(document, [entity], { frame: TOP_VIEW, cutDepth }).flatMap((drawing) => drawing.primitives);
  const fresh: CachedDrawing = { primitives, cutDepth, dependency };
  drawingCache.set(entity, fresh);
  return fresh;
}

/**
 * Top-view drawing primitives of a 3D solid (no occlusion by other solids), sectioned at
 * `cutDepth` when given; `[]` for 2D shapes, empty geometry and derived `bim` geometry (drawn per
 * level elsewhere). Memoized per entity.
 */
export function solidDrawing(document: Pick<CadDocument, 'components'>, entity: Entity, cutDepth?: number): DrawingPrimitive[] {
  return cachedDrawing(document, entity, cutDepth).primitives;
}

/** Edge segments of `solidDrawing` (visible / hidden / cut). Memoized with it. */
export function solidSegments(document: Pick<CadDocument, 'components'>, entity: Entity, cutDepth?: number): Segment2[] {
  const entry = cachedDrawing(document, entity, cutDepth);
  entry.segments ??= drawingSegments(entry.primitives);
  return entry.segments;
}

/** Snap points of `solidDrawing`. Memoized with it. */
export function solidSnaps(document: Pick<CadDocument, 'components'>, entity: Entity, cutDepth?: number): SnapPoint[] {
  const entry = cachedDrawing(document, entity, cutDepth);
  entry.snaps ??= drawingSnapPoints(entry.primitives);
  return entry.snaps;
}
