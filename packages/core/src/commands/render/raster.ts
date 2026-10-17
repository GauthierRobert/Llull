/**
 * Z-buffer rasterisation of the filled faces of a render (the default render_view mode): every pixel shows the nearest face, so beams under
 * a roof, columns behind a wall and touching parts never draw through each other as they can with the painter's sort. Faces are filled
 * even-odd per scanline (section caps with holes included) at 2× supersampling, outlined where the normal, the depth or the entity
 * changes, then averaged down and embedded in the SVG as a compressed PNG; empty pixels stay transparent so the ground grid shows only
 * where nothing covers it.
 */

import type { Vec3 } from '../../model/types';
import { encodePng } from '../../lib/png';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { type Camera, cameraBasis, makeProjector, projectPoint } from './camera';
import type { Polygon3D } from './types';

const SUPERSAMPLE = 2;
const LIGHT: Vec3 = (() => {
  const v: Vec3 = [0.6, -0.8, 1.0];
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
})();
const AMBIENT = 0.35;
/** cos of the normal change that draws an outline (≈ 25°). */
const CREASE_COS = Math.cos((25 * Math.PI) / 180);

function rgbOf(color: string): [number, number, number] {
  const hex = color.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 2, 4].map((i) => parseInt(hex.substring(i, i + 2), 16)) as [number, number, number];
  const rgb = /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [176, 176, 176];
}

/** One drawn face: what a pixel that shows it needs (one table entry per face, one index per pixel keeps memory low). */
interface Face {
  readonly color: readonly [number, number, number];
  readonly normal: Vec3;
  readonly owner: number;
  readonly hatch: boolean;
  /** A 2D stroke: depth-tested against the solids but never outlined. */
  readonly line?: true;
}

interface Buffers {
  readonly width: number;
  readonly height: number;
  readonly depth: Float32Array;
  /** Index into `faces` of the face a pixel shows, -1 = empty. */
  readonly face: Int32Array;
  readonly faces: Face[];
}

interface ScreenPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
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

/** Even-odd scanline fill of `loops` with a depth test; nearer pixels take the index of `face`. */
function fill(buffers: Buffers, loops: readonly (readonly ScreenPoint[])[], face: Face): void {
  const all = loops.flat();
  const depthAt = depthPlane(all);
  if (depthAt === null) return;
  let [top, bottom] = [Infinity, -Infinity];
  for (const p of all) [top, bottom] = [Math.min(top, p.y), Math.max(bottom, p.y)];
  const y0 = Math.max(0, Math.ceil(top - 0.5));
  const y1 = Math.min(buffers.height - 1, Math.floor(bottom - 0.5));
  if (y0 > y1) return;
  const faceIndex = buffers.faces.length;
  buffers.faces.push(face);
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

/** Darkens pixels on a crease, a depth jump or an entity boundary (and the silhouette against the background). */
function outline(buffers: Buffers, depthJump: number): Uint8Array {
  const { width, height, depth, face, faces } = buffers;
  const edge = new Uint8Array(width * height);
  const differs = (a: number, b: number): boolean => {
    const faceA = faces[face[a] ?? -1];
    const faceB = faces[face[b] ?? -1];
    if (faceA?.line === true || faceB?.line === true) return false;
    if (faceA === undefined || faceB === undefined) return faceA !== faceB;
    if (faceA === faceB) return false;
    if (faceA.owner !== faceB.owner) return true;
    if (Math.abs((depth[a] ?? 0) - (depth[b] ?? 0)) > depthJump) return true;
    const cos = faceA.normal[0] * faceB.normal[0] + faceA.normal[1] * faceB.normal[1] + faceA.normal[2] * faceB.normal[2];
    return cos < CREASE_COS;
  };
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if ((x + 1 < width && differs(index, index + 1)) || (y + 1 < height && differs(index, index + width))) edge[index] = 1;
    }
  return edge;
}

/** Above this many output pixels the render is not supersampled (memory and time stay bounded at 2000 × 2000). */
const SUPERSAMPLE_MAX_PIXELS = 1_200_000;

/**
 * The polygons drawn as an `<image>` element (PNG data URL) covering the `width` × `height` canvas, or '' when there is nothing to fill
 * (a pure 2D drawing stays vector). Strokes are depth-tested against the solids, so a sketch behind a part is hidden by it.
 * @pure
 */
export function rasterLayer(
  polygons: readonly Polygon3D[],
  cam: Camera,
  orthoHalf: number,
  width: number,
  height: number,
  sceneRadius: number,
): string {
  const filled = polygons.filter((p) => !p.stroke);
  if (filled.length === 0) return '';
  const strokes = polygons.filter((p) => p.stroke);
  const samples = width * height > SUPERSAMPLE_MAX_PIXELS ? 1 : SUPERSAMPLE;
  const w = width * samples;
  const h = height * samples;
  const project = makeProjector(cam, orthoHalf, w, h);
  const basis = cameraBasis(cam);
  const buffers: Buffers = {
    width: w,
    height: h,
    depth: new Float32Array(w * h).fill(Infinity),
    face: new Int32Array(w * h).fill(-1),
    faces: [],
  };
  const owners = new Map<string, number>();
  const toScreen = (p: Vec3): ScreenPoint => {
    const [x, y] = project(p);
    return { x, y, z: projectPoint(p, cam, basis)[2] };
  };
  for (const polygon of filled) {
    const ownerKey = polygon.owner ?? '';
    const owner = owners.get(ownerKey) ?? owners.size;
    owners.set(ownerKey, owner);
    const [r, g, b] = rgbOf(polygon.color);
    if (polygon.loops !== undefined) {
      const cap: [number, number, number] = [r * 0.55 + 255 * 0.45, g * 0.55 + 255 * 0.45, b * 0.55 + 255 * 0.45];
      fill(
        buffers,
        polygon.loops.map((loop) => loop.map(toScreen)),
        { color: cap, normal: polygon.normal, owner, hatch: true },
      );
      continue;
    }
    const [nx, ny, nz] = polygon.normal;
    const facingAway = nx * basis.fwd[0] + ny * basis.fwd[1] + nz * basis.fwd[2] > 0;
    const facing: Vec3 = facingAway ? [-nx, -ny, -nz] : polygon.normal;
    const diffuse = Math.max(0, facing[0] * LIGHT[0] + facing[1] * LIGHT[1] + facing[2] * LIGHT[2]);
    const factor = AMBIENT + (1 - AMBIENT) * diffuse;
    fill(buffers, [polygon.verts.map(toScreen)], { color: [r * factor, g * factor, b * factor], normal: facing, owner, hatch: false });
  }
  for (const stroke of strokes) {
    const faceIndex = buffers.faces.length;
    buffers.faces.push({ color: rgbOf(stroke.color), normal: [0, 0, 1], owner: -1, hatch: false, line: true });
    const points = stroke.verts.map(toScreen);
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (a !== undefined && b !== undefined) strokeSegment(buffers, a, b, faceIndex, 0.75 * samples, sceneRadius * 0.002);
    }
  }
  const edges = outline(buffers, sceneRadius * 0.01);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let dy = 0; dy < samples; dy += 1)
        for (let dx = 0; dx < samples; dx += 1) {
          const sx = x * samples + dx;
          const sy = y * samples + dy;
          const index = sy * w + sx;
          const face = buffers.faces[buffers.face[index] ?? -1];
          if (face === undefined && edges[index] !== 1) continue;
          const shadeBy = (edges[index] === 1 ? 0.35 : 1) * (face?.hatch === true && (sx + sy) % (6 * samples) < samples ? 0.6 : 1);
          r += face === undefined ? 20 : face.color[0] * shadeBy;
          g += face === undefined ? 20 : face.color[1] * shadeBy;
          b += face === undefined ? 30 : face.color[2] * shadeBy;
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
  const png = encodePng(width, height, rgba, true);
  return `  <image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${uint8ArrayToBase64(png)}"/>`;
}
