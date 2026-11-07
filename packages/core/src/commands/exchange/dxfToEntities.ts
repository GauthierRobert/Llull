/** DXF primitives (already in document units) as model entities, for `import_dxf`. */

import { type BaseEntity, type Entity, type Vec2, type Vec3 } from '../../model/types';
import type { RegionHatch } from '../../model/regionHatch';
import { nextId } from '../../lib/id';
import { newEntity } from '../entity/newEntity';
import type { DxfPrimitive } from '../../lib/dxfRead';
import { polygonArea } from '../../lib/polygon';
import { regionLoopsIssue } from '../../geometry/region';

/** Largest deviation from a right angle / equal opposite sides (relative to the side) still read as a rectangle. */
const RECTANGLE_TOLERANCE = 1e-9;

/** The validity check of a region is quadratic in its loops / points: bigger hatches stay polylines. */
const MAX_REGION_LOOPS = 64;
const MAX_REGION_POINTS = 20000;

/** Pattern spacing of a solid hatch, whose spacing the DXF does not carry: 1/40 of the loop diagonal. */
const SOLID_SPACING_DIVISOR = 40;

/** Default hatch angle, 45° (ANSI31). */
const DEFAULT_HATCH_ANGLE = Math.PI / 4;

export interface Converted {
  readonly entities: Entity[];
  /** Counted label per created entity kind (a hatch that is not a valid region counts as polylines). */
  readonly labels: string[];
  /** True when 3D data was lost (elevation kept from the first point only). */
  readonly flattened: boolean;
}

const isFlat = (points: readonly Vec3[]): boolean => {
  const z = (points[0] as Vec3)[2];
  return points.every((point) => Math.abs(point[2] - z) < 1e-9);
};

const xy = (point: Vec3): Vec2 => [point[0], point[1]];

/** A closed rectangle written by `export_dxf` as `[origin, +width, +width +height, +height]`; null when the corners are not one. */
function rectangleOf(points: readonly Vec3[]): { width: number; height: number; angle: number } | null {
  if (points.length !== 4) return null;
  const [a, b, c, d] = points as [Vec3, Vec3, Vec3, Vec3];
  const [u, v] = [[b[0] - a[0], b[1] - a[1]] as const, [d[0] - a[0], d[1] - a[1]] as const];
  const [width, height] = [Math.hypot(u[0], u[1]), Math.hypot(v[0], v[1])];
  const scale = Math.max(width, height);
  const closes = Math.hypot(c[0] - b[0] - v[0], c[1] - b[1] - v[1]) <= RECTANGLE_TOLERANCE * scale;
  const square = Math.abs(u[0] * v[0] + u[1] * v[1]) <= RECTANGLE_TOLERANCE * width * height;
  const counterClockwise = u[0] * v[1] - u[1] * v[0] > 0;
  return closes && square && counterClockwise && width > 0 && height > 0 ? { width, height, angle: Math.atan2(u[1], u[0]) } : null;
}

/** The region of `loops` (xy), largest first, or null when they do not form a valid even-odd region. */
export function regionGeometry(loops: readonly (readonly Vec2[])[]): ReadonlyArray<ReadonlyArray<Vec2>> | null {
  if (loops.length > MAX_REGION_LOOPS || loops.reduce((sum, loop) => sum + loop.length, 0) > MAX_REGION_POINTS) return null;
  const sorted = [...loops].sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  return sorted.length > 0 && regionLoopsIssue(sorted) === null ? sorted : null;
}

function hatchOf(primitive: Extract<DxfPrimitive, { kind: 'hatch' }>, loops: ReadonlyArray<ReadonlyArray<Vec2>>): RegionHatch {
  if (!primitive.solid) return { pattern: primitive.cross ? 'cross' : 'lines', angle: primitive.angle, spacing: primitive.spacing };
  const xs = loops.flat().map((point) => point[0]);
  const ys = loops.flat().map((point) => point[1]);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return { pattern: 'solid', angle: DEFAULT_HATCH_ANGLE, spacing: diagonal / SOLID_SPACING_DIVISOR };
}

/** One region entity of `loops` at elevation `z` (loops already validated by `regionGeometry`). */
export function makeRegion(
  loops: ReadonlyArray<ReadonlyArray<Vec2>>,
  z: number,
  layerId: string,
  color: string,
  hatch: RegionHatch | null,
): Entity {
  return newEntity('region', nextId('region'), { loops, ...(hatch === null ? {} : { hatch }) }, [0, 0, z], color, { layerId });
}

/**
 * Converts one non-face primitive.
 * @returns the entities (none for degenerate input) and whether 3D data was flattened
 */
export function toEntities(primitive: DxfPrimitive, layerId: string, color: string): Converted {
  const make = <K extends Entity['kind']>(
    kind: K,
    geometry: Omit<Extract<Entity, { kind: K }>, keyof BaseEntity>,
    at: Vec3,
    rotation?: Vec3,
  ): Entity => newEntity(kind, nextId(kind), geometry, at, color, { layerId, ...(rotation ? { rotation } : {}) });
  const one = (entity: Entity, flattened = false): Converted => ({ entities: [entity], labels: [entity.kind], flattened });
  switch (primitive.kind) {
    case 'line': {
      const { a, b } = primitive;
      return one(make('line', { start: xy(a), end: xy(b) }, [0, 0, a[2]]), !isFlat([a, b]));
    }
    case 'polyline': {
      const rectangle = primitive.mark?.kind === 'rectangle' ? rectangleOf(primitive.points) : null;
      if (rectangle !== null) {
        const origin = primitive.points[0] as Vec3;
        return one(make('rectangle', { width: rectangle.width, height: rectangle.height }, origin, [0, 0, rectangle.angle]));
      }
      let points = primitive.points.map(xy);
      const first = points[0] as Vec2;
      const last = points[points.length - 1] as Vec2;
      const closed = primitive.closed || (points.length > 3 && first[0] === last[0] && first[1] === last[1]);
      if (closed && points.length > 3 && first[0] === last[0] && first[1] === last[1]) points = points.slice(0, -1);
      return one(make('polyline', { points, closed }, [0, 0, (primitive.points[0] as Vec3)[2]]), !isFlat(primitive.points));
    }
    case 'arc': {
      const { center, radius, start, end } = primitive;
      return one(make('arc', { center: xy(center), radius, startAngle: start, endAngle: end }, [0, 0, center[2]]));
    }
    case 'circle':
      return one(make('circle', { center: xy(primitive.center), radius: primitive.radius }, [0, 0, primitive.center[2]]));
    case 'point':
      return one(make('point', {}, primitive.at));
    case 'text':
      return one(
        make('text', { content: primitive.content, height: primitive.height, anchor: primitive.anchor }, primitive.at, [
          0,
          0,
          primitive.rotation,
        ]),
      );
    case 'ellipse': {
      const radiusX = Math.hypot(primitive.major[0], primitive.major[1]);
      const angle = Math.atan2(primitive.major[1], primitive.major[0]);
      return one(make('ellipse', { center: [0, 0], radiusX, radiusY: radiusX * primitive.ratio }, primitive.center, [0, 0, angle]));
    }
    case 'spline': {
      const points = primitive.points.map(xy);
      return one(make('spline', { points, closed: primitive.closed }, [0, 0, (primitive.points[0] as Vec3)[2]]), !isFlat(primitive.points));
    }
    case 'hatch': {
      const loops = primitive.loops.map((loop) => loop.map(xy));
      const z = (primitive.loops[0]?.[0] as Vec3)[2];
      const region = regionGeometry(loops);
      if (region !== null)
        return { entities: [makeRegion(region, z, layerId, color, hatchOf(primitive, region))], labels: ['region'], flattened: false };
      const polylines = loops.map((points) => make('polyline', { points, closed: true }, [0, 0, z]));
      return { entities: polylines, labels: polylines.map(() => 'polyline (hatch loop)'), flattened: false };
    }
    case 'face':
      return { entities: [], labels: [], flattened: false };
  }
}

/** The primitive with every length multiplied by `factor` (unit conversion). */
export function scalePrimitive(primitive: DxfPrimitive, factor: number): DxfPrimitive {
  const s = (point: Vec3): Vec3 => [point[0] * factor, point[1] * factor, point[2] * factor];
  switch (primitive.kind) {
    case 'line':
      return { ...primitive, a: s(primitive.a), b: s(primitive.b) };
    case 'polyline':
    case 'spline':
      return { ...primitive, points: primitive.points.map(s) };
    case 'arc':
    case 'circle':
      return { ...primitive, center: s(primitive.center), radius: primitive.radius * factor };
    case 'point':
      return { ...primitive, at: s(primitive.at) };
    case 'text':
      return { ...primitive, at: s(primitive.at), height: primitive.height * factor };
    case 'ellipse':
      return { ...primitive, center: s(primitive.center), major: s(primitive.major) };
    case 'hatch':
      return { ...primitive, loops: primitive.loops.map((loop) => loop.map(s)), spacing: primitive.spacing * factor };
    case 'face':
      return { ...primitive, corners: primitive.corners.map(s) };
  }
}
