/** World -> pixel projector of an explicit render view (the one `viewpointView` builds), orthographic or perspective: the overlays of a moving camera use one per frame. */

import type { Vec2, Vec3 } from '../../../model/vectors';
import { lerp3 } from '../../../lib/vec3';
import { cameraBasis, makeProjector, projectPoint, type Projector } from '../camera';
import type { viewpointView } from '../viewSetup';

/** Depth (document units) at which a perspective polyline is clipped: nearer points are behind or on the eye plane. */
const NEAR = 1e-3;

type View = ReturnType<typeof viewpointView>;

/** The projector that places a world point where the raster draws it for `view`. Points at or behind the eye are pinned to the near depth: use `viewProjection` to clip instead. */
export function viewProjector(view: View, width: number, height: number): Projector {
  const { camera } = view;
  if (camera.fovDeg === undefined) return makeProjector(camera, view.orthoHalf, width, height);
  const basis = cameraBasis(camera);
  const focal = height / 2 / Math.tan((camera.fovDeg * Math.PI) / 360);
  return (p: Vec3) => {
    const [u, v, depth] = projectPoint(p, camera, basis);
    const scale = focal / Math.max(depth, NEAR);
    return [width / 2 + u * scale, height / 2 - v * scale];
  };
}

/** What the overlays need of a view: the projector, the visible pixel runs of a path and point visibility. */
export interface ViewProjection {
  readonly project: Projector;
  readonly runs: (path: readonly Vec3[]) => Vec2[][];
  readonly visible: (point: Vec3) => boolean;
}

/**
 * Projection of `view` for overlays. A perspective path is clipped at the near plane and split into runs there, so a trace that crosses the eye plane
 * never draws a segment across the frame; an orthographic view sees everything.
 * @invariant every returned pixel comes from a point at depth >= NEAR (clipped ends lie on it)
 */
export function viewProjection(view: View, width: number, height: number): ViewProjection {
  const project = viewProjector(view, width, height);
  const { camera } = view;
  if (camera.fovDeg === undefined) return { project, runs: (path) => [path.map((p) => project(p))], visible: () => true };
  const basis = cameraBasis(camera);
  const depthOf = (p: Vec3): number => projectPoint(p, camera, basis)[2];
  return {
    project,
    visible: (p) => depthOf(p) >= NEAR,
    runs: (path) => {
      const runs: Vec2[][] = [];
      let current: Vec2[] = [];
      const flush = (): void => {
        if (current.length > 0) runs.push(current);
        current = [];
      };
      path.forEach((point, i) => {
        const depth = depthOf(point);
        const previous = path[i - 1];
        if (previous !== undefined) {
          const before = depthOf(previous);
          if (before >= NEAR !== depth >= NEAR) {
            const t = (NEAR - before) / (depth - before);
            const edge = lerp3(previous, point, t);
            current.push(project(edge));
            if (depth < NEAR) flush();
          }
        }
        if (depth >= NEAR) current.push(project(point));
      });
      flush();
      return clipRunsToImage(runs, width, height);
    },
  };
}

/** Pixels beyond the image edge that a clipped segment is kept for (a stroke's half-width and its end cap). */
const MARGIN = 8;

/** Liang-Barsky: the part of the segment a-b inside the rectangle, or null. */
function clipSegment(a: Vec2, b: Vec2, [x0, y0, x1, y1]: readonly [number, number, number, number]): [Vec2, Vec2] | null {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  let [t0, t1] = [0, 1];
  const edges: readonly [number, number][] = [
    [-d[0], a[0] - x0],
    [d[0], x1 - a[0]],
    [-d[1], a[1] - y0],
    [d[1], y1 - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  return t0 > t1
    ? null
    : [
        [a[0] + d[0] * t0, a[1] + d[1] * t0],
        [a[0] + d[0] * t1, a[1] + d[1] * t1],
      ];
}

/**
 * The runs cut to the image plus a margin: a segment clipped at the near plane can end millions of pixels away, which is a valid direction but must not be stroked at that length.
 * @invariant every returned point lies within MARGIN pixels of the image
 */
function clipRunsToImage(runs: readonly (readonly Vec2[])[], width: number, height: number): Vec2[][] {
  const rect = [-MARGIN, -MARGIN, width + MARGIN, height + MARGIN] as const;
  const out: Vec2[][] = [];
  for (const run of runs) {
    let current: Vec2[] = [];
    for (let i = 1; i < run.length; i += 1) {
      const clipped = clipSegment(run[i - 1] as Vec2, run[i] as Vec2, rect);
      if (clipped === null) {
        if (current.length > 0) out.push(current);
        current = [];
        continue;
      }
      const [start, end] = clipped;
      const last = current[current.length - 1];
      if (last === undefined || last[0] !== start[0] || last[1] !== start[1]) {
        if (current.length > 0) out.push(current);
        current = [start];
      }
      current.push(end);
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}
