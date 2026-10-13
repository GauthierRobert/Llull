// ONE solid's 2D drawing as interaction sees it: the viewport's `technicalView` (TOP_VIEW, same `cutDepth`) without
// occlusion by other solids. Picking, box selection and snapping read this one memoized result.

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
  /** Expansion inputs beyond the entity (`expansionDependency`). */
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

/** Sectioned at `cutDepth` when given; [] for 2D shapes, empty geometry and `bim` geometry (drawn per level). Memoized. */
export function solidDrawing(document: Pick<CadDocument, 'components'>, entity: Entity, cutDepth?: number): DrawingPrimitive[] {
  return cachedDrawing(document, entity, cutDepth).primitives;
}

/** Visible / hidden / cut edges. */
export function solidSegments(document: Pick<CadDocument, 'components'>, entity: Entity, cutDepth?: number): Segment2[] {
  const entry = cachedDrawing(document, entity, cutDepth);
  entry.segments ??= drawingSegments(entry.primitives);
  return entry.segments;
}

export function solidSnaps(document: Pick<CadDocument, 'components'>, entity: Entity, cutDepth?: number): SnapPoint[] {
  const entry = cachedDrawing(document, entity, cutDepth);
  entry.snaps ??= drawingSnapPoints(entry.primitives);
  return entry.snaps;
}
