/**
 * Z-buffer rasterisation of the filled faces of a render (the default render_view mode): every pixel shows the nearest face, so beams under
 * a roof, columns behind a wall and touching parts never draw through each other as they can with the painter's sort. Faces are filled
 * even-odd per scanline (section caps with holes included) at 2× supersampling, outlined where the normal, the depth or the entity
 * changes, then averaged down and embedded in the SVG as a compressed PNG; empty pixels stay transparent so the ground grid shows only
 * where nothing covers it. `rasterScenePixels` is the reference per-pixel stage (the hash path); the native CPU twin in `llull-raster`
 * reproduces it bit for bit, and a host's `ctx.raster` may replace it (a picture, never a digest).
 */

import type { RasterScene } from '../../model/raster';
import { encodePng } from '../../lib/png';
import { uint8ArrayToBase64 } from '../../lib/base64';
import type { Camera } from './camera';
import type { PixelStage, Polygon3D } from './types';
import { prepareRasterScene } from './rasterScene';

interface ScreenPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface Buffers {
  readonly width: number;
  readonly height: number;
  readonly depth: Float32Array;
  /** Index of the face a pixel shows, -1 = empty. */
  readonly face: Int32Array;
}

/** Depth as an affine function of the screen position (orthographic view of a planar face), or null for an edge-on face. */
function depthPlane(points: readonly ScreenPoint[]): ((x: number, y: number) => number) | null {
  const a = points[0];
  if (a === undefined) return null;
  let best: { det: number; b: ScreenPoint; c: ScreenPoint } | null = null;
  for (let i = 1; i < points.length; i += 1)
    for (let j = i + 1; j < points.length; j += 1) {
      const b = points[i];
      const c = points[j];
      if (b === undefined || c === undefined) continue;
      const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      if (best === null || Math.abs(det) > Math.abs(best.det)) best = { det, b, c };
      if (points.length > 8 && best !== null && Math.abs(best.det) > 1) break;
    }
  if (best === null || Math.abs(best.det) < 1e-9) return null;
  const { det, b, c } = best;
  const dzdx = ((b.z - a.z) * (c.y - a.y) - (c.z - a.z) * (b.y - a.y)) / det;
  const dzdy = ((c.z - a.z) * (b.x - a.x) - (b.z - a.z) * (c.x - a.x)) / det;
  return (x, y) => a.z + dzdx * (x - a.x) + dzdy * (y - a.y);
}

/** Even-odd scanline fill of `loops` with a depth test; nearer pixels take `faceIndex`. */
function fill(buffers: Buffers, loops: readonly (readonly ScreenPoint[])[], faceIndex: number): void {
  const all = loops.flat();
  const depthAt = depthPlane(all);
  if (depthAt === null) return;
  let [top, bottom] = [Infinity, -Infinity];
  for (const p of all) [top, bottom] = [Math.min(top, p.y), Math.max(bottom, p.y)];
  const y0 = Math.max(0, Math.ceil(top - 0.5));
  const y1 = Math.min(buffers.height - 1, Math.floor(bottom - 0.5));
  const crossings: number[] = [];
  for (let y = y0; y <= y1; y += 1) {
    const sy = y + 0.5;
    crossings.length = 0;
    for (const loop of loops)
      for (let i = 0; i < loop.length; i += 1) {
        const p = loop[i];
        const q = loop[(i + 1) % loop.length];
        if (p === undefined || q === undefined || p.y === q.y) continue;
        if ((sy >= p.y && sy < q.y) || (sy >= q.y && sy < p.y)) crossings.push(p.x + ((sy - p.y) / (q.y - p.y)) * (q.x - p.x));
      }
    crossings.sort((m, n) => m - n);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const xa = Math.max(0, Math.ceil((crossings[k] ?? 0) - 0.5));
      const xb = Math.min(buffers.width - 1, Math.floor((crossings[k + 1] ?? 0) - 0.5));
      for (let x = xa; x <= xb; x += 1) {
        const index = y * buffers.width + x;
        const z = depthAt(x + 0.5, sy);
        if (z >= (buffers.depth[index] ?? Infinity)) continue;
        buffers.depth[index] = z;
        buffers.face[index] = faceIndex;
      }
    }
  }
}

/**
 * A stroke from `a` to `b`, `halfWidth` pixels each side, drawn where it is not behind a solid. It is pulled toward the viewer by
 * `bias` so a sketch lying ON a face stays visible.
 */
function strokeSegment(buffers: Buffers, a: ScreenPoint, b: ScreenPoint, faceIndex: number, halfWidth: number, bias: number): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  const radius = Math.ceil(halfWidth);
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    const cx = a.x + (b.x - a.x) * t;
    const cy = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t - bias;
    for (let dy = -radius; dy <= radius; dy += 1)
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = Math.floor(cx) + dx;
        const y = Math.floor(cy) + dy;
        if (x < 0 || y < 0 || x >= buffers.width || y >= buffers.height || dx * dx + dy * dy > halfWidth * halfWidth + 0.5) continue;
        const index = y * buffers.width + x;
        if (z > (buffers.depth[index] ?? Infinity)) continue;
        buffers.face[index] = faceIndex;
      }
  }
}

const value = (array: Float64Array, index: number): number => array[index] ?? 0;

/** Darkens pixels on a crease, a depth jump or an entity boundary (and the silhouette against the background). */
function outline(scene: RasterScene, buffers: Buffers): Uint8Array {
  const { width, height, depth, face } = buffers;
  const { faces, creaseCos, depthJump } = scene;
  const linear = scene.projection === 'perspective' ? (z: number): number => -1 / z : (z: number): number => z;
  const edge = new Uint8Array(width * height);
  const isLine = (f: number): boolean => f >= 0 && (value(faces, f * 8 + 7) & 2) !== 0;
  const differs = (a: number, b: number): boolean => {
    const fa = face[a] ?? -1;
    const fb = face[b] ?? -1;
    if (isLine(fa) || isLine(fb)) return false;
    if (fa < 0 || fb < 0) return fa !== fb;
    if (fa === fb) return false;
    if (value(faces, fa * 8 + 6) !== value(faces, fb * 8 + 6)) return true;
    if (Math.abs(linear(depth[a] ?? 0) - linear(depth[b] ?? 0)) > depthJump) return true;
    let cos = 0;
    for (let k = 3; k < 6; k += 1) cos += value(faces, fa * 8 + k) * value(faces, fb * 8 + k);
    return cos < creaseCos;
  };
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if ((x + 1 < width && differs(index, index + 1)) || (y + 1 < height && differs(index, index + width))) edge[index] = 1;
    }
  return edge;
}

/** The reference per-pixel stage: RGBA of the logical image (the TypeScript renderer, deterministic, the hash path). @pure */
export function rasterScenePixels(scene: RasterScene): Uint8Array {
  const { width, height, samples, faces, fills, loops, points, strokes } = scene;
  const w = width * samples;
  const h = height * samples;
  const buffers: Buffers = { width: w, height: h, depth: new Float32Array(w * h).fill(Infinity), face: new Int32Array(w * h).fill(-1) };
  const point = (index: number): ScreenPoint => ({
    x: value(points, index * 3),
    y: value(points, index * 3 + 1),
    z: value(points, index * 3 + 2),
  });
  for (let f = 0; f < fills.length / 3; f += 1) {
    const [firstLoop, loopCount] = [value(fills, f * 3 + 1), value(fills, f * 3 + 2)];
    const screenLoops: ScreenPoint[][] = [];
    for (let l = firstLoop; l < firstLoop + loopCount; l += 1) {
      const [first, count] = [value(loops, l * 2), value(loops, l * 2 + 1)];
      screenLoops.push(Array.from({ length: count }, (_, k) => point(first + k)));
    }
    fill(buffers, screenLoops, value(fills, f * 3));
  }
  for (let s = 0; s < strokes.length / 9; s += 1) {
    const at = (k: number): number => value(strokes, s * 9 + k);
    strokeSegment(buffers, { x: at(1), y: at(2), z: at(3) }, { x: at(4), y: at(5), z: at(6) }, at(0), at(7), at(8));
  }
  const edges = outline(scene, buffers);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let dy = 0; dy < samples; dy += 1)
        for (let dx = 0; dx < samples; dx += 1) {
          const sx = x * samples + dx;
          const sy = y * samples + dy;
          const index = sy * w + sx;
          const f = buffers.face[index] ?? -1;
          const edge = edges[index] === 1;
          if (f < 0 && !edge) continue;
          const hatch = f >= 0 && (value(faces, f * 8 + 7) & 1) !== 0;
          const shadeBy = (edge ? 0.35 : 1) * (hatch && (sx + sy) % (6 * samples) < samples ? 0.6 : 1);
          r += f < 0 ? 20 : value(faces, f * 8) * shadeBy;
          g += f < 0 ? 20 : value(faces, f * 8 + 1) * shadeBy;
          b += f < 0 ? 30 : value(faces, f * 8 + 2) * shadeBy;
          a += 255;
        }
      const covered = a / 255;
      const out = (y * width + x) * 4;
      if (covered === 0) continue;
      rgba[out] = Math.round(r / covered);
      rgba[out + 1] = Math.round(g / covered);
      rgba[out + 2] = Math.round(b / covered);
      rgba[out + 3] = Math.round(a / (samples * samples));
    }
  return rgba;
}

/** `<image>` element (PNG data URL) of a `width` × `height` RGBA image covering the canvas. */
export function rasterImageSvg(width: number, height: number, rgba: Uint8Array): string {
  const png = encodePng(width, height, rgba, true);
  return `  <image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${uint8ArrayToBase64(png)}"/>`;
}

/**
 * The polygons drawn as an `<image>` element covering the `width` × `height` canvas, or '' when there is nothing to fill (a pure 2D drawing
 * stays vector). Strokes are depth-tested against the solids, so a sketch behind a part is hidden by it. `pixels` replaces the reference
 * per-pixel stage.
 */
export function rasterLayer(
  polygons: readonly Polygon3D[],
  cam: Camera,
  orthoHalf: number,
  width: number,
  height: number,
  sceneRadius: number,
  pixels: PixelStage = rasterScenePixels,
): string {
  const scene = prepareRasterScene(polygons, cam, orthoHalf, width, height, sceneRadius);
  return scene === null ? '' : rasterImageSvg(width, height, pixels(scene));
}
