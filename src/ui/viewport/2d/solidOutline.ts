/**
 * @layer ui/viewport/2d
 *
 * Top-view outlines of 3D solids for the 2D drafting view, as closed rings of world XY points
 * (the closing segment is implicit). Local geometry comes from core (`localBounds`) and is
 * placed with the entity's full Euler rotation + position, so a tilted solid gets the hull of
 * its projected vertices. Upright solids are exact: circle (cylinder, sphere, cone), outer + inner
 * ring (torus), the rotated profile polygon (extrusion); everything else falls back to the convex
 * hull of its projected bounding box / vertices (mesh, revolution, wedge, pyramid, box, instance).
 */

import { instanceBoundsFromDoc, localBounds } from '@core/commands/sceneBounds';
import { applyEulerXYZ } from '@core/lib/eulerRotation';
import type { CadDocument, Entity, Vec2, Vec3 } from '@core/model/types';
import { is3D } from '@core/model/types';
import { projectOntoSegment } from '@lib/polygon';

export type OutlineRing = ReadonlyArray<Vec2>;

const CIRCLE_SAMPLES = 64;
const TORUS_U_SAMPLES = 48;
const TORUS_V_SAMPLES = 16;
const ORIGIN: Vec3 = [0, 0, 0];

/** Convex hull (Andrew's monotone chain), counter-clockwise, no repeated first point. @pure */
export function convexHull(points: ReadonlyArray<Vec2>): Vec2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (input: ReadonlyArray<Vec2>): Vec2[] => {
    const chain: Vec2[] = [];
    for (const point of input) {
      while (chain.length >= 2) {
        const [a, b] = [chain[chain.length - 2] as Vec2, chain[chain.length - 1] as Vec2];
        if (cross(a, b, point) > 1e-12) break;
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

const isUpright = (e: Entity): boolean =>
  Math.abs(e.rotation[0]) < 1e-9 && Math.abs(e.rotation[1]) < 1e-9;

/** Entity-local 3D points -> world XY (Euler rotation about the entity origin, then position). */
function toWorldXY(e: Entity, points: ReadonlyArray<Vec3>): Vec2[] {
  return points.map((point): Vec2 => {
    const rotated = applyEulerXYZ(point, ORIGIN, e.rotation);
    return [rotated[0] + e.position[0], rotated[1] + e.position[1]];
  });
}

function circlePoints(radius: number, z: number): Vec3[] {
  return Array.from({ length: CIRCLE_SAMPLES }, (_, i): Vec3 => {
    const angle = (2 * Math.PI * i) / CIRCLE_SAMPLES;
    return [radius * Math.cos(angle), radius * Math.sin(angle), z];
  });
}

function boundsCorners(e: Entity): Vec3[] {
  const { min, max } = localBounds(e);
  return [min[2], max[2]].flatMap((z) => [
    [min[0], min[1], z] as Vec3,
    [max[0], min[1], z] as Vec3,
    [max[0], max[1], z] as Vec3,
    [min[0], max[1], z] as Vec3,
  ]);
}

function torusSurface(ringRadius: number, tubeRadius: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < TORUS_U_SAMPLES; i++) {
    const u = (2 * Math.PI * i) / TORUS_U_SAMPLES;
    for (let j = 0; j < TORUS_V_SAMPLES; j++) {
      const v = (2 * Math.PI * j) / TORUS_V_SAMPLES;
      const radial = ringRadius + tubeRadius * Math.cos(v);
      points.push([radial * Math.cos(u), radial * Math.sin(u), tubeRadius * Math.sin(v)]);
    }
  }
  return points;
}

/** Hull of the entity's projected local points; the common fallback. */
const hullRing = (e: Entity, local: ReadonlyArray<Vec3>): OutlineRing[] => [
  convexHull(toWorldXY(e, local)),
];

/**
 * Closed top-view rings of a 3D solid, or null for 2D shapes / empty geometry.
 * @pure
 */
export function solidOutline(document: CadDocument, e: Entity): OutlineRing[] | null {
  if (!is3D(e)) return null;
  const rings = outlineRings(document, e);
  return rings.length > 0 && rings.every((ring) => ring.length >= 2) ? rings : null;
}

function outlineRings(document: CadDocument, e: Entity): OutlineRing[] {
  switch (e.kind) {
    case 'cylinder': {
      const { min, max } = localBounds(e);
      return hullRing(e, [...circlePoints(e.radius, min[2]), ...circlePoints(e.radius, max[2])]);
    }
    case 'cone':
      return hullRing(e, [...circlePoints(e.radius, 0), [0, 0, e.height]]);
    case 'sphere':
      return [circleAround(toWorldXY(e, [ORIGIN])[0] as Vec2, e.radius)];
    case 'torus':
      if (isUpright(e)) {
        const center = toWorldXY(e, [ORIGIN])[0] as Vec2;
        return [
          circleAround(center, e.ringRadius + e.tubeRadius),
          circleAround(center, Math.max(e.ringRadius - e.tubeRadius, 0)),
        ];
      }
      return hullRing(e, torusSurface(e.ringRadius, e.tubeRadius));
    case 'extrusion':
      return isUpright(e)
        ? [
            toWorldXY(
              e,
              e.profile.map(([x, y]): Vec3 => [x, y, 0]),
            ),
          ]
        : hullRing(
            e,
            e.profile.flatMap(([x, y]): Vec3[] => [
              [x, y, 0],
              [x, y, e.depth],
            ]),
          );
    case 'mesh': {
      const points: Vec2[] = [];
      for (let i = 0; i + 2 < e.mesh.positions.length; i += 3) {
        points.push([e.mesh.positions[i] as number, e.mesh.positions[i + 1] as number]);
      }
      return [convexHull(points)];
    }
    case 'instance': {
      const { min, max } = instanceBoundsFromDoc(e, document);
      return [
        [
          [min[0], min[1]],
          [max[0], min[1]],
          [max[0], max[1]],
          [min[0], max[1]],
        ],
      ];
    }
    default:
      // box, wedge, pyramid, revolution: hull of the projected local bounding box.
      return hullRing(e, boundsCorners(e));
  }
}

function circleAround(center: Vec2, radius: number): Vec2[] {
  return circlePoints(radius, 0).map(([x, y]): Vec2 => [center[0] + x, center[1] + y]);
}

/** Squared distance from `point` to the nearest ring segment (rings are closed). @pure */
export function ringsDistSq(rings: ReadonlyArray<OutlineRing>, point: Vec2): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Vec2;
      const b = ring[(i + 1) % ring.length] as Vec2;
      best = Math.min(best, projectOntoSegment(point, a, b).distance ** 2);
    }
  }
  return best;
}

/** Flat xyz segment-pair list (closed rings) for LineSegments rendering. @pure */
export function ringsToSegmentPositions(rings: ReadonlyArray<OutlineRing>): number[] {
  return rings.flatMap((ring) =>
    ring.flatMap((a, i) => {
      const b = ring[(i + 1) % ring.length] as Vec2;
      return [a[0], a[1], 0, b[0], b[1], 0];
    }),
  );
}
