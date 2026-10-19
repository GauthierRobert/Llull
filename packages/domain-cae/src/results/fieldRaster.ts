/**
 * Z-buffer raster of a nodal result on the plot faces: every pixel shows the nearest face and the nodal value INTERPOLATED at that pixel
 * (barycentric, exact for the orthographic view), coloured by band so iso-band contours stay crisp. Parts never paint through each other.
 * Rendered at 2x supersampling, outlined on silhouettes / part boundaries / creases, and embedded in the SVG as a compressed PNG; pixels
 * showing nothing stay transparent. The depth buffer also answers whether a 3D point is visible (marker dots are depth-tested).
 *
 * Three stages so a host can run the per-pixel one natively (05 TR-FEA-92, `llull-compute raster`, crate `llull-raster`): `prepareRaster`
 * (per face: screen points, depth, value, light, normal, part), `rasterPixels` (the z-buffer, edges and supersample resolve — the
 * reference the Rust CPU twin reproduces bit for bit) and `finishRaster` (PNG + visibility from the depth buffer).
 */

import type { Vec3 } from '@core/model/vectors';
import { uint8ArrayToBase64 } from '@lib/base64';
import { resultColor } from '@lib/isoBands';
import { encodePng } from '@lib/png';
import type { FieldFace } from './fieldFaces';

interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface RasterInput {
  readonly faces: readonly FieldFace[];
  /** Draw a faint silhouette of the undeformed faces where nothing else shows. */
  readonly ghost: boolean;
  /** Unit vector from the part toward the viewer: depth = dot(point, toViewer), larger = nearer. */
  readonly toViewer: Vec3;
  /** Logical pixel of a plotted point. */
  readonly screen: (p: Vec3) => readonly [number, number];
  readonly pixelsPerUnit: number;
  readonly width: number;
  readonly height: number;
  /** Faces are only drawn inside this rectangle (logical pixels). */
  readonly area: PixelRect;
  readonly levels: readonly number[];
  readonly showMesh: boolean;
  /** Model size, for the depth jump that draws an outline. */
  readonly size: number;
}

export interface FieldRaster {
  /** `<image>` element covering the canvas, or '' when nothing is drawn. */
  readonly image: string;
  /** Front-facing faces rasterised. */
  readonly facesDrawn: number;
  /** True when `point` (plotted position) is not hidden behind a nearer face. */
  readonly visible: (point: Vec3) => boolean;
}

/** Everything the per-pixel stage reads (field names as the `llull-raster` job reads them; arrays are its binary buffers). */
export interface PreparedRaster {
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly clip: PixelRect;
  readonly ghost: boolean;
  /** Ghost triangles (undeformed, non-cap faces): x, y of 3 corners in supersampled pixels. */
  readonly ghostTriangles: Float64Array;
  /** Front-facing triangles: x, y, depth, value of 3 corners. */
  readonly triangles: Float64Array;
  readonly light: Float64Array;
  /** Unit normal of each front-facing triangle. */
  readonly normals: Float64Array;
  /** Part index of each front-facing triangle (first appearance order). */
  readonly owners: Float64Array;
  /** 1 for a section (cap) face. */
  readonly caps: Float64Array;
  readonly low: number;
  readonly step: number;
  /** RGB of each band. */
  readonly palette: readonly number[];
  readonly jump: number;
  readonly showMesh: boolean;
  readonly creaseCos: number;
}

/** Output of the per-pixel stage: RGBA of the logical image and the supersampled depth buffer. */
export interface RasterPixels {
  readonly rgba: Uint8Array;
  readonly depth: Float32Array;
}

const SUPERSAMPLE = 2;
const SUPERSAMPLE_MAX_PIXELS = 1_200_000;
const CREASE_COS = Math.cos((30 * Math.PI) / 180);
const GHOST = [154, 154, 184] as const;
const GHOST_ALPHA = 0.3;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function unitNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const [u, v]: [Vec3, Vec3] = [
    [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
  ];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(n[0], n[1], n[2]);
  return length > 0 ? [n[0] / length, n[1] / length, n[2] / length] : [0, 0, 0];
}

/** Calls `visit(pixelIndex, depth, value)` for every pixel centre inside triangle `t` (offset `at`: x, y, z, v per corner) and `clip`. */
function scan(t: Float64Array, at: number, clip: PixelRect, width: number, visit: (index: number, z: number, v: number) => void): void {
  const [ax, ay, az, av] = [t[at] ?? 0, t[at + 1] ?? 0, t[at + 2] ?? 0, t[at + 3] ?? 0];
  const [bx, by, bz, bv] = [t[at + 4] ?? 0, t[at + 5] ?? 0, t[at + 6] ?? 0, t[at + 7] ?? 0];
  const [cx, cy, cz, cv] = [t[at + 8] ?? 0, t[at + 9] ?? 0, t[at + 10] ?? 0, t[at + 11] ?? 0];
  const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(det) < 1e-12) return;
  const x0 = Math.max(clip.left, Math.ceil(Math.min(ax, bx, cx) - 0.5));
  const x1 = Math.min(clip.right - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
  const y0 = Math.max(clip.top, Math.ceil(Math.min(ay, by, cy) - 0.5));
  const y1 = Math.min(clip.bottom - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
  for (let y = y0; y <= y1; y += 1) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x += 1) {
      const px = x + 0.5;
      const l0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / det;
      const l1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / det;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
      visit(y * width + x, l0 * az + l1 * bz + l2 * cz, l0 * av + l1 * bv + l2 * cv);
    }
  }
}

const rgbOfHex = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** Per-face stage: screen points (supersampled), depth, light, normal and part of every front-facing face. @pure */
export function prepareRaster(input: RasterInput): PreparedRaster {
  const { width, height, toViewer } = input;
  const samples = width * height > SUPERSAMPLE_MAX_PIXELS ? 1 : SUPERSAMPLE;
  const [w, h] = [width * samples, height * samples];
  const clip: PixelRect = {
    left: Math.max(0, Math.floor(input.area.left * samples)),
    top: Math.max(0, Math.floor(input.area.top * samples)),
    right: Math.min(w, Math.ceil(input.area.right * samples)),
    bottom: Math.min(h, Math.ceil(input.area.bottom * samples)),
  };
  const ghostTriangles: number[] = [];
  const triangles: number[] = [];
  const light: number[] = [];
  const normals: number[] = [];
  const owners: number[] = [];
  const caps: number[] = [];
  const ownerIds = new Map<string, number>();
  const xy = (p: Vec3): [number, number] => {
    const [x, y] = input.screen(p);
    return [x * samples, y * samples];
  };
  for (const face of input.faces) {
    const [a, b, c] = face.corners;
    if (input.ghost && !face.cap) ghostTriangles.push(...xy(a.u), ...xy(b.u), ...xy(c.u));
    const normal = unitNormal(a.p, b.p, c.p);
    const facing = dot(normal, toViewer);
    if (facing <= 0) continue;
    light.push(0.62 + 0.38 * facing);
    normals.push(...normal);
    caps.push(face.cap ? 1 : 0);
    owners.push(ownerIds.get(face.entityId) ?? ownerIds.set(face.entityId, ownerIds.size).size - 1);
    for (const corner of [a, b, c]) triangles.push(...xy(corner.p), dot(corner.p, toViewer), corner.v);
  }
  const bands = Math.max(1, input.levels.length - 1);
  const [low, high] = [input.levels[0] ?? 0, input.levels.at(-1) ?? 1];
  return {
    width,
    height,
    samples,
    clip,
    ghost: input.ghost,
    ghostTriangles: Float64Array.from(ghostTriangles),
    triangles: Float64Array.from(triangles),
    light: Float64Array.from(light),
    normals: Float64Array.from(normals),
    owners: Float64Array.from(owners),
    caps: Float64Array.from(caps),
    low,
    step: (high - low) / bands,
    palette: Array.from({ length: bands }, (_, band) => rgbOfHex(resultColor((band + 0.5) / bands))).flat(),
    jump: input.size * 0.03,
    showMesh: input.showMesh,
    creaseCos: CREASE_COS,
  };
}

/** Per-pixel stage: z-buffer, edge detection, band colouring and supersample resolve. The reference of `llull-raster`. @pure */
export function rasterPixels(prepared: PreparedRaster): RasterPixels {
  const { width, height, samples, clip, triangles, normals, owners, caps, light } = prepared;
  const [w, h] = [width * samples, height * samples];
  const depth = new Float32Array(w * h).fill(-Infinity);
  const value = new Float32Array(w * h);
  const triangle = new Int32Array(w * h).fill(-1);
  const ghost = prepared.ghost ? new Uint8Array(w * h) : null;
  const rgba = new Uint8Array(width * height * 4);
  if (ghost !== null)
    for (let at = 0; at + 6 <= prepared.ghostTriangles.length; at += 6) {
      const g = prepared.ghostTriangles;
      const corners = Float64Array.from([
        g[at] ?? 0,
        g[at + 1] ?? 0,
        0,
        0,
        g[at + 2] ?? 0,
        g[at + 3] ?? 0,
        0,
        0,
        g[at + 4] ?? 0,
        g[at + 5] ?? 0,
        0,
        0,
      ]);
      scan(corners, 0, clip, w, (index) => void (ghost[index] = 1));
    }
  const drawn = light.length;
  for (let id = 0; id < drawn; id += 1)
    scan(triangles, id * 12, clip, w, (index, z, v) => {
      if (z <= (depth[index] ?? Infinity)) return;
      depth[index] = z;
      value[index] = v;
      triangle[index] = id;
    });
  if (drawn === 0 && ghost === null) return { rgba, depth };
  const bands = prepared.palette.length / 3;
  const { low, step, jump } = prepared;
  const normalDot = (ta: number, tb: number): number =>
    (normals[ta * 3] ?? 0) * (normals[tb * 3] ?? 0) +
    (normals[ta * 3 + 1] ?? 0) * (normals[tb * 3 + 1] ?? 0) +
    (normals[ta * 3 + 2] ?? 0) * (normals[tb * 3 + 2] ?? 0);
  const edgeKind = (a: number, b: number): 0 | 1 | 2 => {
    const [ta, tb] = [triangle[a] ?? -1, triangle[b] ?? -1];
    if (ta < 0 && tb < 0) return 0;
    if (ta < 0 || tb < 0) return 1;
    if (ta === tb) return 0;
    if (owners[ta] !== owners[tb] || Math.abs((depth[a] ?? 0) - (depth[b] ?? 0)) > jump) return 1;
    if ((caps[ta] === 1 || caps[tb] === 1) && normalDot(ta, tb) < prepared.creaseCos) return 1;
    return prepared.showMesh ? 2 : 0;
  };
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let dy = 0; dy < samples; dy += 1)
        for (let dx = 0; dx < samples; dx += 1) {
          const [sx, sy] = [x * samples + dx, y * samples + dy];
          const index = sy * w + sx;
          const id = triangle[index] ?? -1;
          if (id < 0) {
            if (ghost?.[index] !== 1) continue;
            [r, g, b, a] = [r + GHOST[0] * GHOST_ALPHA, g + GHOST[1] * GHOST_ALPHA, b + GHOST[2] * GHOST_ALPHA, a + 255 * GHOST_ALPHA];
            continue;
          }
          const edge = Math.max(
            sx + 1 < w ? edgeKind(index, index + 1) : 0,
            sy + 1 < h ? edgeKind(index, index + w) : 0,
            sx > 0 && edgeKind(index, index - 1) === 1 ? 1 : 0,
            sy > 0 && edgeKind(index, index - w) === 1 ? 1 : 0,
          );
          const band = Math.min(bands - 1, Math.max(0, Math.floor(step > 0 ? ((value[index] ?? low) - low) / step : 0)));
          const shade = (light[id] ?? 1) * (edge === 1 ? 0.3 : edge === 2 ? 0.7 : 1);
          const [pr, pg, pb] = [prepared.palette[band * 3] ?? 0, prepared.palette[band * 3 + 1] ?? 0, prepared.palette[band * 3 + 2] ?? 0];
          [r, g, b, a] = [r + pr * shade, g + pg * shade, b + pb * shade, a + 255];
        }
      const covered = a / 255;
      if (covered === 0) continue;
      const out = (y * width + x) * 4;
      [rgba[out], rgba[out + 1], rgba[out + 2], rgba[out + 3]] = [
        Math.round(r / covered),
        Math.round(g / covered),
        Math.round(b / covered),
        Math.round(a / (samples * samples)),
      ];
    }
  return { rgba, depth };
}

/** PNG image and depth-tested visibility of rasterised pixels (from `rasterPixels` or a native twin). @pure */
export function finishRaster(input: RasterInput, prepared: PreparedRaster, pixels: RasterPixels): FieldRaster {
  const { width, height, samples } = prepared;
  const [w, h] = [width * samples, height * samples];
  const { depth } = pixels;
  const visible = (point: Vec3): boolean => {
    const [sx, sy] = input.screen(point);
    const [ix, iy] = [Math.floor(sx * samples), Math.floor(sy * samples)];
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false;
    const z = dot(point, input.toViewer);
    const tolerance = (4 / (input.pixelsPerUnit * samples)) * Math.max(1, samples) + input.size * 0.002;
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) {
        const [x, y] = [ix + dx, iy + dy];
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if ((depth[y * w + x] ?? -Infinity) <= z + tolerance) return true;
      }
    return false;
  };
  const facesDrawn = prepared.light.length;
  if (facesDrawn === 0 && !prepared.ghost) return { image: '', facesDrawn: 0, visible };
  const png = encodePng(width, height, pixels.rgba, true);
  return {
    image: `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${uint8ArrayToBase64(png)}"/>`,
    facesDrawn,
    visible,
  };
}

/** @pure */
export function rasterField(input: RasterInput): FieldRaster {
  const prepared = prepareRaster(input);
  return finishRaster(input, prepared, rasterPixels(prepared));
}
