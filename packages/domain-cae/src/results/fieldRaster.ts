/**
 * Z-buffer raster of a nodal result on the plot faces: every pixel shows the nearest face and the nodal value INTERPOLATED at that pixel
 * (barycentric, exact for the orthographic view), coloured by band so iso-band contours stay crisp. Parts never paint through each other.
 * Rendered at 2x supersampling, outlined on silhouettes / part boundaries / creases, and embedded in the SVG as a compressed PNG; pixels
 * showing nothing stay transparent. The depth buffer also answers whether a 3D point is visible (marker dots are depth-tested).
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

const SUPERSAMPLE = 2;
const SUPERSAMPLE_MAX_PIXELS = 1_200_000;
const CREASE_COS = Math.cos((30 * Math.PI) / 180);
const GHOST = [154, 154, 184] as const;
const GHOST_ALPHA = 0.3;

interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly v: number;
}

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

/** Calls `visit(pixelIndex, depth, value)` for every pixel centre inside the triangle and the clip rectangle. */
function scan(a: Point, b: Point, c: Point, clip: PixelRect, width: number, visit: (index: number, z: number, v: number) => void): void {
  const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (Math.abs(det) < 1e-12) return;
  const x0 = Math.max(clip.left, Math.ceil(Math.min(a.x, b.x, c.x) - 0.5));
  const x1 = Math.min(clip.right - 1, Math.floor(Math.max(a.x, b.x, c.x) - 0.5));
  const y0 = Math.max(clip.top, Math.ceil(Math.min(a.y, b.y, c.y) - 0.5));
  const y1 = Math.min(clip.bottom - 1, Math.floor(Math.max(a.y, b.y, c.y) - 0.5));
  for (let y = y0; y <= y1; y += 1) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x += 1) {
      const px = x + 0.5;
      const l0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / det;
      const l1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / det;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
      visit(y * width + x, l0 * a.z + l1 * b.z + l2 * c.z, l0 * a.v + l1 * b.v + l2 * c.v);
    }
  }
}

const rgbOfHex = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** @pure */
export function rasterField(input: RasterInput): FieldRaster {
  const { width, height, toViewer } = input;
  const samples = width * height > SUPERSAMPLE_MAX_PIXELS ? 1 : SUPERSAMPLE;
  const [w, h] = [width * samples, height * samples];
  const clip: PixelRect = {
    left: Math.max(0, Math.floor(input.area.left * samples)),
    top: Math.max(0, Math.floor(input.area.top * samples)),
    right: Math.min(w, Math.ceil(input.area.right * samples)),
    bottom: Math.min(h, Math.ceil(input.area.bottom * samples)),
  };
  const depth = new Float32Array(w * h).fill(-Infinity);
  const value = new Float32Array(w * h);
  const triangle = new Int32Array(w * h).fill(-1);
  const ghost = input.ghost ? new Uint8Array(w * h) : null;
  const light: number[] = [];
  const normals: Vec3[] = [];
  const owners: number[] = [];
  const caps: boolean[] = [];
  const ownerIds = new Map<string, number>();
  const toPoint = (p: Vec3, v: number): Point => {
    const [x, y] = input.screen(p);
    return { x: x * samples, y: y * samples, z: dot(p, toViewer), v };
  };
  for (const face of input.faces) {
    const [a, b, c] = face.corners;
    if (ghost !== null && !face.cap) scan(toPoint(a.u, 0), toPoint(b.u, 0), toPoint(c.u, 0), clip, w, (index) => void (ghost[index] = 1));
    const normal = unitNormal(a.p, b.p, c.p);
    const facing = dot(normal, toViewer);
    if (facing <= 0) continue;
    const id = light.length;
    light.push(0.62 + 0.38 * facing);
    normals.push(normal);
    caps.push(face.cap);
    owners.push(ownerIds.get(face.entityId) ?? ownerIds.set(face.entityId, ownerIds.size).size - 1);
    scan(toPoint(a.p, a.v), toPoint(b.p, b.v), toPoint(c.p, c.v), clip, w, (index, z, v) => {
      if (z <= (depth[index] ?? Infinity)) return;
      depth[index] = z;
      value[index] = v;
      triangle[index] = id;
    });
  }
  const drawn = light.length;
  const visible = (point: Vec3): boolean => {
    const [sx, sy] = input.screen(point);
    const [ix, iy] = [Math.floor(sx * samples), Math.floor(sy * samples)];
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false;
    const z = dot(point, toViewer);
    const tolerance = (4 / (input.pixelsPerUnit * samples)) * Math.max(1, samples) + input.size * 0.002;
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) {
        const [x, y] = [ix + dx, iy + dy];
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if ((depth[y * w + x] ?? -Infinity) <= z + tolerance) return true;
      }
    return false;
  };
  if (drawn === 0 && ghost === null) return { image: '', facesDrawn: 0, visible };
  const bands = Math.max(1, input.levels.length - 1);
  const [low, high] = [input.levels[0] ?? 0, input.levels.at(-1) ?? 1];
  const step = (high - low) / bands;
  const palette = Array.from({ length: bands }, (_, band) => rgbOfHex(resultColor((band + 0.5) / bands)));
  const jump = input.size * 0.03;
  const edgeKind = (a: number, b: number): 0 | 1 | 2 => {
    const [ta, tb] = [triangle[a] ?? -1, triangle[b] ?? -1];
    if (ta < 0 && tb < 0) return 0;
    if (ta < 0 || tb < 0) return 1;
    if (ta === tb) return 0;
    if (owners[ta] !== owners[tb] || Math.abs((depth[a] ?? 0) - (depth[b] ?? 0)) > jump) return 1;
    const [na, nb] = [normals[ta], normals[tb]];
    if ((caps[ta] === true || caps[tb] === true) && (na === undefined || nb === undefined || dot(na, nb) < CREASE_COS)) return 1;
    return input.showMesh ? 2 : 0;
  };
  const rgba = new Uint8Array(width * height * 4);
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
          const [pr, pg, pb] = palette[band] ?? [0, 0, 0];
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
  const png = encodePng(width, height, rgba, true);
  return {
    image: `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${uint8ArrayToBase64(png)}"/>`,
    facesDrawn: drawn,
    visible,
  };
}
