import type { Vec3 } from '../../model/types';
import { sub3, dot3, cross3, normalize3 } from '../../lib/vec3';
import type { ShadowPlan } from './shadowTypes';

export type ViewName = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso' | 'custom';

/** Camera described in world space (all Z-up). */
export interface Camera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** Vertical field of view in degrees: a perspective camera (raster mode only; `position` is the eye). Absent = orthographic. */
  fovDeg?: number;
}

/** Build an orthographic camera for a named view at a given scene radius. */
export function cameraForView(view: ViewName, center: Vec3, radius: number, direction?: Vec3): Camera {
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
    case 'custom': {
      const dir = normalize3(direction ?? [1, -1.4, 1]);
      // Looking (almost) straight along Z leaves "up" undefined: fall back to +Y.
      return at(dir, Math.abs(dir[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1]);
    }
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
export function projectPoint(p: Vec3, cam: Camera, basis: { fwd: Vec3; right: Vec3; up: Vec3 }): [number, number, number] {
  const d = sub3(p, cam.position);
  const u = dot3(d, basis.right);
  const v = dot3(d, basis.up);
  const depth = dot3(d, basis.fwd);
  return [u, v, depth];
}

export type Projector = (p: Vec3) => [number, number];

/** World→screen projector (SVG pixels, Y down) fitting `orthoHalf` world units into 90 % of the canvas. @pure */
export function makeProjector(cam: Camera, orthoHalf: number, width: number, height: number): Projector {
  const basis = cameraBasis(cam);
  const margin = 0.9;
  const scale = Math.min(((width / 2) * margin) / orthoHalf, ((height / 2) * margin) / orthoHalf);
  return (p) => {
    const [u, v] = projectPoint(p, cam, basis);
    return [width / 2 + u * scale, height / 2 - v * scale];
  };
}

/** Fixed directional light direction in world space (Z-up). */
const LIGHT_DIR: Vec3 = normalize3([0.6, -0.8, 1.0]);
const AMBIENT = 0.35;

/** Key light override of a render (site-context sun): `direction` is the unit vector toward the light in model axes; null = sky light only (sun below the horizon). */
export interface RenderLight {
  readonly direction: Vec3 | null;
  /** Present = raster sun shadows (when the sun is up) and the ground plane at `groundElevation` (null = none); see `sunShadows.ts`. */
  readonly shadows?: {
    readonly groundElevation: number | null;
    /** World AABB the ground plane is fitted to (a static document extent across the frames of an animation); absent = the drawn faces' own bounds. */
    readonly groundBounds?: { readonly min: Vec3; readonly max: Vec3 };
    /** The shadow pass already run for these polygons (`planShadows`); absent = the raster stage runs it. */
    readonly plan?: ShadowPlan;
  };
}

/** Lambert-shade `baseColor` (`#rrggbb`) for a face with unit `normal`; returns `rgb(r,g,b)`. Default light unless `light` overrides it. */
export function shade(normal: Vec3, baseColor: string, light?: RenderLight): string {
  const toLight = light === undefined ? LIGHT_DIR : light.direction;
  const diff = toLight === null ? 0 : Math.max(0, dot3(normal, toLight));
  const factor = AMBIENT + (1 - AMBIENT) * diff;
  const hex = baseColor.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => Math.min(255, Math.round(parseInt(hex.substring(i, i + 2), 16) * factor)));
  return `rgb(${r},${g},${b})`;
}
