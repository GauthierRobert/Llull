// Factor drag of a loop cut: the loop slides along the edges it crosses, measured from the first vertex of the picked edge (the order of its
// id, which the command uses). Pure: a world ray in, a factor in (0, 1) out.

import type { SubdivisionEntity, Vec3 } from '@core/model/types';
import { len3, normalize3, sub3 } from '@lib/vec3';
import { axisParamFromRay } from '../manipulators/manipulatorMath';
import type { WorldRay } from './dragMath';
import { localToWorld, parseEdgeId } from './cageSelection';

/** The loop never reaches an end vertex (the command refuses 0 and 1). */
const MARGIN = 0.02;

export interface LoopCutEdge {
  /** World position of the first vertex of the id pair and of the second. */
  readonly a: Vec3;
  readonly b: Vec3;
}

export function loopCutEdge(cage: SubdivisionEntity, edgeId: string): LoopCutEdge | null {
  const ends = parseEdgeId(edgeId);
  if (ends === null) return null;
  const [a, b] = ends.map((id) => cage.vertices[cage.elementIds.vertices.indexOf(id)]);
  return a === undefined || b === undefined ? null : { a: localToWorld(cage, a), b: localToWorld(cage, b) };
}

/** Factor of the point of the edge line closest to the pointer ray, rounded to 0.01 and kept off the end vertices; null for a degenerate or edge-on view. */
export function loopCutFactor(edge: LoopCutEdge, ray: WorldRay): number | null {
  const length = len3(sub3(edge.b, edge.a));
  if (length < 1e-12) return null;
  const t = axisParamFromRay(edge.a, normalize3(sub3(edge.b, edge.a)), ray.origin, ray.direction);
  if (t === null) return null;
  return Math.round(Math.min(1 - MARGIN, Math.max(MARGIN, t / length)) * 100) / 100;
}

/** Does losing the pointer capture end the press with a cancelled gesture? A loop-cut press sets its gesture (and ghost) on pointerdown, so it always does; a drag only once it moved. */
export const cancelsOnCaptureLoss = (press: { readonly kind: 'drag' | 'loopcut' | 'background'; readonly active?: boolean }): boolean =>
  press.kind === 'loopcut' || (press.kind === 'drag' && press.active === true);
