/**
 * Prepare stage of the render_view raster: polygons -> the screen-space `RasterScene` (supersampled pixels, flat Lambert colour per face,
 * outline normals and owners, 2D strokes as segments). The per-pixel stage (`raster.ts` `rasterScenePixels`, or a host's `ctx.raster`)
 * only fills, depth-tests, outlines and resolves. Orthographic scenes keep the historical projector arithmetic (bit-identical renders);
 * perspective scenes are clipped at a near plane in camera space and carry z = −1/depth, which is affine in screen space.
 * @pure
 */

import type { Vec3 } from '../../model/types';
import type { RasterScene } from '../../model/raster';
import { type Camera, cameraBasis, makeProjector, projectPoint } from './camera';
import type { Polygon3D } from './types';

const SUPERSAMPLE = 2;
/** Above this many output pixels the render is not supersampled (memory and time stay bounded at 2000 × 2000). */
const SUPERSAMPLE_MAX_PIXELS = 1_200_000;
const LIGHT: Vec3 = (() => {
  const v: Vec3 = [0.6, -0.8, 1.0];
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
})();
const AMBIENT = 0.35;
/** cos of the normal change that draws an outline (≈ 25°). */
const CREASE_COS = Math.cos((25 * Math.PI) / 180);
const FLAG_HATCH = 1;
const FLAG_LINE = 2;

function rgbOf(color: string): [number, number, number] {
  const hex = color.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 2, 4].map((i) => parseInt(hex.substring(i, i + 2), 16)) as [number, number, number];
  const rgb = /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [176, 176, 176];
}

type ScreenPoint = readonly [number, number, number];

/** World point -> screen point, or (perspective) null-safe loop / segment clipping before projection. */
interface Projection {
  readonly loop: (verts: readonly Vec3[]) => ScreenPoint[];
  readonly segment: (a: Vec3, b: Vec3, bias: number) => [ScreenPoint, ScreenPoint, number] | null;
  /** Unit vector from the eye toward `p` (orthographic: the view direction). */
  readonly viewAt: (p: Vec3) => Vec3;
}

function orthographic(cam: Camera, orthoHalf: number, w: number, h: number): Projection {
  const project = makeProjector(cam, orthoHalf, w, h);
  const basis = cameraBasis(cam);
  const toScreen = (p: Vec3): ScreenPoint => {
    const [x, y] = project(p);
    return [x, y, projectPoint(p, cam, basis)[2]];
  };
  return { loop: (verts) => verts.map(toScreen), segment: (a, b, bias) => [toScreen(a), toScreen(b), bias], viewAt: () => basis.fwd };
}

function perspective(cam: Camera, fovDeg: number, w: number, h: number, near: number): Projection {
  const basis = cameraBasis(cam);
  const focal = h / 2 / Math.tan((fovDeg * Math.PI) / 360);
  const screen = ([u, v, d]: readonly number[]): ScreenPoint => [
    w / 2 + (u ?? 0) * (focal / (d ?? 1)),
    h / 2 - (v ?? 0) * (focal / (d ?? 1)),
    -1 / (d ?? 1),
  ];
  const cross = (a: readonly number[], b: readonly number[]): number[] => {
    const t = (near - (a[2] ?? 0)) / ((b[2] ?? 0) - (a[2] ?? 0));
    return [0, 1, 2].map((k) => (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * t);
  };
  return {
    loop: (verts) => {
      const camera = verts.map((p) => projectPoint(p, cam, basis));
      const kept: number[][] = [];
      camera.forEach((current, i) => {
        const previous = camera[(i + camera.length - 1) % camera.length] ?? current;
        const [inside, wasInside] = [current[2] >= near, previous[2] >= near];
        if (inside !== wasInside) kept.push(cross(previous, current));
        if (inside) kept.push(current);
      });
      return kept.length < 3 ? [] : kept.map(screen);
    },
    segment: (a, b, bias) => {
      let [p, q] = [projectPoint(a, cam, basis), projectPoint(b, cam, basis)];
      if (p[2] < near && q[2] < near) return null;
      if (p[2] < near) p = cross(p, q) as [number, number, number];
      if (q[2] < near) q = cross(q, p) as [number, number, number];
      const biased = (c: readonly number[]): ScreenPoint => {
        const [x, y] = screen(c);
        const d = c[2] ?? 1;
        return [x, y, -1 / Math.max(d - bias, d * 0.5)];
      };
      return [biased(p), biased(q), 0];
    },
    viewAt: (p) => {
      const d: Vec3 = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
      const length = Math.hypot(...d) || 1;
      return [d[0] / length, d[1] / length, d[2] / length];
    },
  };
}

/**
 * The raster scene of `polygons` seen by `cam` (orthographic with `orthoHalf`, perspective when `cam.fovDeg` is set), or null when there
 * is nothing to draw. The caller decides whether a strokes-only drawing is rasterised (perspective, frames, native) or stays vector.
 */
export function prepareRasterScene(
  polygons: readonly Polygon3D[],
  cam: Camera,
  orthoHalf: number,
  width: number,
  height: number,
  sceneRadius: number,
): RasterScene | null {
  const filled = polygons.filter((p) => !p.stroke);
  if (polygons.length === 0) return null;
  const samples = width * height > SUPERSAMPLE_MAX_PIXELS ? 1 : SUPERSAMPLE;
  const [w, h] = [width * samples, height * samples];
  const projection =
    cam.fovDeg === undefined ? orthographic(cam, orthoHalf, w, h) : perspective(cam, cam.fovDeg, w, h, Math.max(sceneRadius * 1e-3, 1e-6));
  const faces: number[] = [];
  const fills: number[] = [];
  const loops: number[] = [];
  const points: number[] = [];
  const strokes: number[] = [];
  const owners = new Map<string, number>();
  const addFill = (screenLoops: readonly ScreenPoint[][], color: readonly number[], normal: Vec3, owner: number, flags: number): void => {
    const kept = screenLoops.filter((loop) => loop.length > 0);
    if (kept.length === 0) return;
    fills.push(faces.length / 8, loops.length / 2, kept.length);
    faces.push(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, normal[0], normal[1], normal[2], owner, flags);
    for (const loop of kept) {
      loops.push(points.length / 3, loop.length);
      for (const point of loop) points.push(point[0], point[1], point[2]);
    }
  };
  for (const polygon of filled) {
    const ownerKey = polygon.owner ?? '';
    const owner = owners.get(ownerKey) ?? owners.size;
    owners.set(ownerKey, owner);
    const [r, g, b] = rgbOf(polygon.color);
    if (polygon.loops !== undefined) {
      const cap = [r * 0.55 + 255 * 0.45, g * 0.55 + 255 * 0.45, b * 0.55 + 255 * 0.45];
      addFill(
        polygon.loops.map((loop) => projection.loop(loop)),
        cap,
        polygon.normal,
        owner,
        FLAG_HATCH,
      );
      continue;
    }
    const [nx, ny, nz] = polygon.normal;
    const view = projection.viewAt(polygon.verts[0] ?? [0, 0, 0]);
    const facingAway = nx * view[0] + ny * view[1] + nz * view[2] > 0;
    const facing: Vec3 = facingAway ? [-nx, -ny, -nz] : polygon.normal;
    const diffuse = Math.max(0, facing[0] * LIGHT[0] + facing[1] * LIGHT[1] + facing[2] * LIGHT[2]);
    const factor = AMBIENT + (1 - AMBIENT) * diffuse;
    addFill([projection.loop(polygon.verts)], [r * factor, g * factor, b * factor], facing, owner, 0);
  }
  const bias = sceneRadius * 0.002;
  for (const stroke of polygons.filter((p) => p.stroke)) {
    const face = faces.length / 8;
    faces.push(...rgbOf(stroke.color), 0, 0, 1, -1, FLAG_LINE);
    for (let i = 0; i + 1 < stroke.verts.length; i += 1) {
      const [a, b] = [stroke.verts[i], stroke.verts[i + 1]];
      const segment = a === undefined || b === undefined ? null : projection.segment(a, b, bias);
      if (segment === null) continue;
      const [p, q, segmentBias] = segment;
      strokes.push(face, p[0], p[1], p[2], q[0], q[1], q[2], 0.75 * samples, segmentBias);
    }
  }
  return {
    width,
    height,
    samples,
    projection: cam.fovDeg === undefined ? 'orthographic' : 'perspective',
    depthJump: sceneRadius * 0.01,
    creaseCos: CREASE_COS,
    faces: Float64Array.from(faces),
    fills: Float64Array.from(fills),
    loops: Float64Array.from(loops),
    points: Float64Array.from(points),
    strokes: Float64Array.from(strokes),
  };
}
