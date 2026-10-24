/**
 * Where a deformation acts and at what scale (01 DEF §5.7): the mesh path refines only the edges the map bends, and splits big triangles near a
 * local feature (a point push or a lattice cell) that no edge of theirs would reveal.
 */

import type { Vec3 } from '../../model/vectors';
import { type DeformNode } from './laws';
import { type LocalFrame, toLocal } from './frame';
import { rbfFeatureSize } from './rbf';

type Segment = (p: Vec3, q: Vec3, margin?: number) => boolean;

/** Edges must be at most this fraction of the feature size inside the influence zone. */
const FEATURE_FRACTION = 1 / 6;

/** Length scale of the smallest feature of the map (point push: its radius; lattice: its smallest cell), or null for maps with no local feature. */
function featureSize(node: Pick<DeformNode, 'law'>): number | null {
  const { law } = node;
  if (law.kind === 'point') return law.radius;
  if (law.kind === 'rbf') return rbfFeatureSize(law);
  if (law.kind !== 'lattice') return null;
  const cells = [0, 1, 2].map((a) => ((law.box.max[a] as number) - (law.box.min[a] as number)) / (law.degrees[a] as number));
  return Math.min(...cells);
}

/** Longest edge the mesh path keeps inside the influence zone of a local feature, or Infinity. */
export function featureEdgeLength(node: Pick<DeformNode, 'law'>): number {
  const size = featureSize(node);
  return size === null ? Infinity : size * FEATURE_FRACTION;
}

function distanceToSegment(point: Vec3, p: Vec3, q: Vec3): number {
  const d: Vec3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const length2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const t =
    length2 === 0
      ? 0
      : Math.min(1, Math.max(0, ((point[0] - p[0]) * d[0] + (point[1] - p[1]) * d[1] + (point[2] - p[2]) * d[2]) / length2));
  return Math.hypot(p[0] + t * d[0] - point[0], p[1] + t * d[1] - point[1], p[2] + t * d[2] - point[2]);
}

/**
 * Whether the edge pq (world points) can be bent by the map: its local bounding box (grown by `margin`) meets the zone the law acts in.
 * The axis laws act between the region ends, a lattice inside its box, a point push inside its support sphere, a flow everywhere.
 */
export function edgeActive(node: Pick<DeformNode, 'law' | 'region'>, frame: LocalFrame): Segment {
  const { law, region } = node;
  {
    switch (law.kind) {
      case 'affine':
        return () => false;
      case 'flowCurve':
      case 'flowSurface':
      case 'rbf':
        return () => true;
      case 'point':
        return (p, q, margin = 0) => distanceToSegment(law.center, toLocal(frame, p), toLocal(frame, q)) < law.radius + margin;
      case 'lattice':
        return (p, q, margin = 0) => {
          const [a, b] = [toLocal(frame, p), toLocal(frame, q)];
          return [0, 1, 2].every(
            (axis) =>
              Math.max(a[axis] as number, b[axis] as number) > (law.box.min[axis] as number) - margin &&
              Math.min(a[axis] as number, b[axis] as number) < (law.box.max[axis] as number) + margin,
          );
        };
      default:
        return (p, q) => {
          if (region === undefined) return false;
          const [za, zb] = [toLocal(frame, p)[2], toLocal(frame, q)[2]];
          return !(Math.max(za, zb) <= region.start || Math.min(za, zb) >= region.end);
        };
    }
  }
}
