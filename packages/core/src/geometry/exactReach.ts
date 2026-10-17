/** Exact refinement of a mesh-measured hole depth through the face-query port (07 FTR §3.1 `up_to_next` on curved exit walls). */

import type { Vec2 } from '../model/types';
import type { FeatureFrame } from '../model/features';
import type { FaceQueryPort } from './kernelPorts';
import type { ShapeHandle } from './kernel';
import { frameToWorld } from './featureFrame';
import { add3, dot3, scale3, sub3 } from '../lib/vec3';

const MAX_ITERATIONS = 8;
const FACE_AGREEMENT = 0.1;

/**
 * The depth at which the centre-line ray of the hole at `point` meets the exact face under the mesh hit at `meshDepth` (Newton on the exact
 * surface through `projectOnFace`), or null when the port cannot confirm it.
 * @invariant the result stays within 10 % of the mesh depth (a different face means the mesh answer stands) and lies on the face to 1e-7 relative
 * @failure no nearest face / projection, a grazing ray, no convergence -> null
 */
export function exactExitDepth(
  port: FaceQueryPort,
  shape: ShapeHandle,
  frame: FeatureFrame,
  point: Vec2,
  meshDepth: number,
): number | null {
  const start = frameToWorld(frame, point);
  const down = scale3(frame.normal, -1);
  const at = (depth: number): readonly [number, number, number] => add3(start, scale3(down, depth));
  const nearest = port.distance(shape, [at(meshDepth)])?.[0];
  if (nearest === undefined) return null;
  const face = nearest.face;
  let depth = meshDepth;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const projection = port.projectOnFace(shape, face, [at(depth)])?.[0];
    if (projection == null) return null;
    const slope = dot3(down, projection.normal);
    if (Math.abs(slope) < 1e-9) return null;
    const step = dot3(sub3(projection.point, at(depth)), projection.normal) / slope;
    depth += step;
    if (Math.abs(step) <= 1e-12 * (1 + Math.abs(depth))) break;
  }
  const settled = port.projectOnFace(shape, face, [at(depth)])?.[0];
  const onFace = settled != null && settled.distance <= 1e-7 * (1 + Math.abs(depth));
  return onFace && depth > 0 && Math.abs(depth - meshDepth) <= FACE_AGREEMENT * (1 + meshDepth) ? depth : null;
}
