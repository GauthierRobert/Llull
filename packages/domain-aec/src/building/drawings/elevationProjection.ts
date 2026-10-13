/**
 * Elevations and sections of the 3D model: the core technical view (hidden lines removed, cut
 * faces hatched) seen from a compass side, hidden edges omitted (building convention), steel cut
 * faces filled solid.
 */

import type { CadDocument, Entity, Vec3 } from '@core/model/types';
import { type DrawingPrimitive, drawingBounds } from '@core/model/drawing';
import { technicalView } from '@core/geometry/technicalView';
import type { ViewFrame } from '@core/geometry/viewProjection';

export const ELEVATION_DIRECTIONS = ['north', 'south', 'east', 'west'] as const;
export type ElevationDirection = (typeof ELEVATION_DIRECTIONS)[number];

/** Viewer side → screen axis u (left→right as seen by the viewer) and depth (grows toward viewer). */
interface Projection {
  /** World axis measured by depth (0 = x, 1 = y). */
  readonly axis: 0 | 1;
  /** depth = sign · p[axis]. */
  readonly sign: 1 | -1;
  readonly u: (point: Vec3) => number;
}

const PROJECTIONS: Readonly<Record<ElevationDirection, Projection>> = {
  north: { axis: 1, sign: 1, u: (p) => -p[0] },
  south: { axis: 1, sign: -1, u: (p) => p[0] },
  east: { axis: 0, sign: 1, u: (p) => p[1] },
  west: { axis: 0, sign: -1, u: (p) => -p[1] },
};

interface ElevationDrawing {
  readonly primitives: DrawingPrimitive[];
  /** [minU, minZ, maxU, maxZ] of the drawn view. */
  readonly bounds: readonly [number, number, number, number];
  readonly projection: Projection;
}

/** Steel cut faces are filled solid; concrete, masonry and the rest keep the 45° hatch. */
const isSteel = (category: string | null): boolean => category === 'member' || category === 'plate';

function categoryOf(tags: ReadonlyArray<string> | undefined): string | null {
  return tags?.includes('bim') === true ? (tags[1] ?? null) : null;
}

/** @returns the elevation / section line drawing, or null when no 3D geometry remains */
export function buildElevationDrawing(
  doc: CadDocument,
  options: {
    direction: ElevationDirection;
    cutAt?: number | undefined;
    exclude?: ReadonlyArray<string> | undefined;
  },
): ElevationDrawing | null {
  const projection = PROJECTIONS[options.direction];
  const frame: ViewFrame = {
    toViewer: projection.axis === 0 ? [projection.sign, 0, 0] : [0, projection.sign, 0],
    project: (p) => [projection.u(p), p[2]],
  };
  const excluded = new Set(options.exclude ?? []);
  const solids = doc.order.flatMap((id): Entity[] => {
    const entity = doc.entities[id];
    if (!entity || doc.layers[entity.layerId]?.visible === false) return [];
    const category = categoryOf(entity.tags);
    return category !== null && excluded.has(category) ? [] : [entity];
  });
  const cutDepth = options.cutAt !== undefined ? projection.sign * options.cutAt : undefined;
  const primitives = technicalView(doc, solids, { frame, cutDepth }).flatMap(({ entityId, primitives: drawn }) => {
    const steel = isSteel(categoryOf(doc.entities[entityId]?.tags));
    return drawn.flatMap((primitive): DrawingPrimitive[] => {
      if (primitive.style === 'hidden') return [];
      return steel && primitive.type === 'polygon' && primitive.fill === 'hatch' ? [{ ...primitive, fill: 'solid' }] : [primitive];
    });
  });
  if (primitives.length === 0) return null;
  return { primitives, bounds: drawingBounds(primitives), projection };
}
