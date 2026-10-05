import type { Vec3 } from '../model/types';
import { sub3, dot3, cross3, normalize3 } from '../lib/vec3';
import type { Bounds } from './sceneTypes';

export type ViewName = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

/** Camera described in world space (all Z-up). */
export interface Camera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
}

/** Build an orthographic camera for a named view at a given scene radius. */
export function cameraForView(view: ViewName, center: Vec3, radius: number): Camera {
  const d = radius * 2.5;
  const [cx, cy, cz] = center;
  const target: [number, number, number] = [cx, cy, cz];

  const at = (offset: Vec3, up: Camera['up']): Camera => ({
    position: [cx + offset[0] * d, cy + offset[1] * d, cz + offset[2] * d],
    target,
    up,
  });
  switch (view) {
    case 'top':
      return at([0, 0, 1], [0, 1, 0]);
    case 'bottom':
      return at([0, 0, -1], [0, 1, 0]);
    case 'front':
      return at([0, -1, 0], [0, 0, 1]);
    case 'back':
      return at([0, 1, 0], [0, 0, 1]);
    case 'left':
      return at([-1, 0, 0], [0, 0, 1]);
    case 'right':
      return at([1, 0, 0], [0, 0, 1]);
    case 'iso':
      // Fixed isometric direction: roughly from (+1, -1.4, +1) relative to center.
      return at(normalize3([1, -1.4, 1]), [0, 0, 1]);
  }
}

/** Build a right-hand orthographic camera basis (forward, right, up vectors). */
export function cameraBasis(cam: Camera): { fwd: Vec3; right: Vec3; up: Vec3 } {
  const fwd = normalize3(sub3(cam.target, cam.position));
  const right = normalize3(cross3(fwd, cam.up));
  const up = normalize3(cross3(right, fwd));
  return { fwd, right, up };
}

/** Project a world-space point to camera space [u, v, depth]. */
export function projectPoint(
  p: Vec3,
  cam: Camera,
  basis: { fwd: Vec3; right: Vec3; up: Vec3 },
): [number, number, number] {
  const d = sub3(p, cam.position);
  const u = dot3(d, basis.right);
  const v = dot3(d, basis.up);
  const depth = dot3(d, basis.fwd);
  return [u, v, depth];
}

export type Projector = (p: Vec3) => [number, number];

/** World→screen projector (SVG pixels, Y down) fitting `orthoHalf` world units into 90 % of the canvas. @pure */
export function makeProjector(
  cam: Camera,
  orthoHalf: number,
  width: number,
  height: number,
): Projector {
  const basis = cameraBasis(cam);
  const margin = 0.9;
  const scale = Math.min(((width / 2) * margin) / orthoHalf, ((height / 2) * margin) / orthoHalf);
  return (p) => {
    const [u, v] = projectPoint(p, cam, basis);
    return [width / 2 + u * scale, height / 2 - v * scale];
  };
}

/** Largest side of an AABB. */
export function boundsExtent({ min, max }: Bounds): number {
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** Radius of the sphere framing `bounds`: half the largest extent, 1 for a (near-)point scene. */
export function boundsRadius(bounds: Bounds): number {
  const radius = boundsExtent(bounds) / 2 + 1e-3;
  return radius < 0.1 ? 1 : radius;
}

/** Half-width of the orthographic frustum (world units) the SVG overlays project with. */
export function computeOrthoHalf(bounds: Bounds | null): number {
  return bounds ? boundsRadius(bounds) * 1.2 * 1.2 : 1;
}

/** Fixed directional light direction in world space (Z-up). */
const LIGHT_DIR: Vec3 = normalize3([0.6, -0.8, 1.0]);
const AMBIENT = 0.35;

/** Lambert-shade `baseColor` (`#rrggbb`) for a face with unit `normal`; returns `rgb(r,g,b)`. */
export function shade(normal: Vec3, baseColor: string): string {
  const diff = Math.max(0, dot3(normal, LIGHT_DIR));
  const factor = AMBIENT + (1 - AMBIENT) * diff;
  const hex = baseColor.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) =>
    Math.min(255, Math.round(parseInt(hex.substring(i, i + 2), 16) * factor)),
  );
  return `rgb(${r},${g},${b})`;
}
