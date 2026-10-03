import type { Vec3 } from '../model/types';
import { sub3, dot3, cross3, normalize3 } from '../lib/vec3';

// ---------------------------------------------------------------------------
// Camera / view
// ---------------------------------------------------------------------------

export type ViewName = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';
export const VALID_VIEWS: ReadonlySet<string> = new Set<ViewName>([
  'top',
  'bottom',
  'front',
  'back',
  'left',
  'right',
  'iso',
]);

/** Camera described in world space (all Z-up). */
export interface Camera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** Orthographic half-extents; if null, derive from scene bounds. */
  ortho: number | null;
}

/** Build an orthographic camera for a named view at a given scene radius. */
export function cameraForView(view: ViewName, center: Vec3, radius: number): Camera {
  const d = radius * 2.5;
  const [cx, cy, cz] = center;
  const target: [number, number, number] = [cx, cy, cz];

  switch (view) {
    case 'top':
      return { position: [cx, cy, cz + d], target, up: [0, 1, 0], ortho: radius };
    case 'bottom':
      return { position: [cx, cy, cz - d], target, up: [0, 1, 0], ortho: radius };
    case 'front':
      return { position: [cx, cy - d, cz], target, up: [0, 0, 1], ortho: radius };
    case 'back':
      return { position: [cx, cy + d, cz], target, up: [0, 0, 1], ortho: radius };
    case 'left':
      return { position: [cx - d, cy, cz], target, up: [0, 0, 1], ortho: radius };
    case 'right':
      return { position: [cx + d, cy, cz], target, up: [0, 0, 1], ortho: radius };
    case 'iso': {
      // Fixed isometric direction: roughly from (+1, -1.4, +1) relative to center.
      const iso = normalize3([1, -1.4, 1]);
      const pos: [number, number, number] = [cx + iso[0] * d, cy + iso[1] * d, cz + iso[2] * d];
      return { position: pos, target, up: [0, 0, 1], ortho: radius };
    }
  }
}

// ---------------------------------------------------------------------------
// Projection (orthographic)
// ---------------------------------------------------------------------------

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

/** Map camera [u,v] to SVG pixel coords with scaling to fit width×height. */
export function toScreenCoords(
  u: number,
  v: number,
  orthoHalf: number,
  width: number,
  height: number,
): [number, number] {
  const margin = 0.9; // 90 % of canvas used
  const scaleX = ((width / 2) * margin) / orthoHalf;
  const scaleY = ((height / 2) * margin) / orthoHalf;
  const scale = Math.min(scaleX, scaleY);
  const sx = width / 2 + u * scale;
  const sy = height / 2 - v * scale; // flip Y (SVG Y grows down)
  return [sx, sy];
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

/** Fixed directional light direction in world space (Z-up). */
const LIGHT_DIR: Vec3 = normalize3([0.6, -0.8, 1.0]);
const AMBIENT = 0.35;

export function shade(normal: Vec3, baseColor: string): string {
  const diff = Math.max(0, dot3(normal, LIGHT_DIR));
  const factor = AMBIENT + (1 - AMBIENT) * diff;
  return tintHex(baseColor, factor);
}

/** Shade a back-face (face pointing away from light) darker. */
function tintHex(hex: string, factor: number): string {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const ri = Math.min(255, Math.round(r * factor));
  const gi = Math.min(255, Math.round(g * factor));
  const bi = Math.min(255, Math.round(b * factor));
  return `rgb(${ri},${gi},${bi})`;
}
