/**
 * Hidden-line projection of the 3D model onto an elevation / section plane (painter's algorithm
 * over the core view projection: front faces, feature + silhouette edges, cut outlines).
 * @layer domain-aec
 */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import {
  type ProjectedFace,
  type Segment2,
  type ViewFrame,
  cutSegments,
  facesOf,
  projectFaces,
  weldTolerance,
} from '@core/geometry/viewProjection';
import { chainLoops } from '@core/geometry/planeEdges';

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

/** Poché class of a cut region. */
type CutMaterial = 'steel' | 'concrete' | 'other';

/** Filled cut face of one entity: closed loops (even-odd, so hollow sections stay hollow). */
interface CutRegion {
  readonly material: CutMaterial;
  readonly loops: Vec2[][];
}

interface ElevationDrawing {
  readonly items: ProjectedFace[];
  readonly cutLines: Segment2[];
  readonly cutRegions: CutRegion[];
  /** [minU, minZ, maxU, maxZ] of the projected geometry. */
  readonly bounds: readonly [number, number, number, number];
  readonly projection: Projection;
}

const CONCRETE_CATEGORIES: ReadonlySet<string> = new Set([
  'wall',
  'slab',
  'column',
  'beam',
  'stair',
  'footing',
  'curvedWall',
]);

function cutMaterial(category: string | null): CutMaterial {
  if (category === 'member' || category === 'plate') return 'steel';
  return category !== null && CONCRETE_CATEGORIES.has(category) ? 'concrete' : 'other';
}

function categoryOf(tags: ReadonlyArray<string> | undefined): string | null {
  return tags?.includes('bim') === true ? (tags[1] ?? null) : null;
}

/**
 * @pure
 * @returns the projected hidden-line drawing, or null when no 3D geometry remains
 */
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
  const limit = options.cutAt !== undefined ? projection.sign * options.cutAt : Infinity;
  const excluded = new Set(options.exclude ?? []);
  const hiddenLayers = new Set(
    Object.values(doc.layers)
      .filter((layer) => !layer.visible)
      .map((layer) => layer.id),
  );
  const items: ProjectedFace[] = [];
  const cutLines: Segment2[] = [];
  const cutRegions: CutRegion[] = [];
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (point: Vec2): void => {
    bounds[0] = Math.min(bounds[0], point[0]);
    bounds[1] = Math.min(bounds[1], point[1]);
    bounds[2] = Math.max(bounds[2], point[0]);
    bounds[3] = Math.max(bounds[3], point[1]);
  };
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (!entity || hiddenLayers.has(entity.layerId)) continue;
    const category = categoryOf(entity.tags);
    if (category !== null && excluded.has(category)) continue;
    const faces = facesOf(entityToTriangles(entity, doc), frame);
    const entityCuts = limit !== Infinity ? cutSegments(faces, frame, limit) : [];
    for (const segment of entityCuts) segment.forEach(grow);
    cutLines.push(...entityCuts);
    for (const face of projectFaces(faces, frame, limit)) {
      face.polygon.forEach(grow);
      items.push(face);
    }
    const loops = chainLoops(entityCuts, weldTolerance(faces));
    if (loops.length > 0) cutRegions.push({ material: cutMaterial(category), loops });
  }
  if (items.length === 0 && cutLines.length === 0) return null;
  items.sort((a, b) => a.depth - b.depth);
  return { items, cutLines, cutRegions, bounds, projection };
}
