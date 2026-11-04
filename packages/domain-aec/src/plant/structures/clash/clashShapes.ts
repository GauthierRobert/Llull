/**
 * Oriented boxes for the clash bodies of structures and access (06 STA): a straight run with a rectangular section, and a convex plan plate cut into
 * strips whose boxes hug the outline. Pure geometry in document units.
 * @invariant a plate that is a rectangle in its own frame is one box; any other convex plate is at most `MAX_STRIPS` boxes that cover it
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type { OrientedBox } from '../../../industrial/clash/clashBoxes';
import { sweepFrame } from '../../../shared/mesh';

const MAX_STRIPS = 8;

/** The box of the straight run `from` -> `to` with a section of half sizes `halfU` (across) and `halfV` (depth); null for a zero-length run. */
export function runBox(from: Vec3, to: Vec3, halfU: number, halfV: number, roll = 0): OrientedBox | null {
  const frame = sweepFrame(from, to, roll);
  if (frame === null) return null;
  return {
    center: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2],
    axes: [frame.u, frame.v, frame.d],
    half: [halfU, halfV, frame.length / 2],
  };
}

/** Sutherland-Hodgman clip of `polygon` to `keep(point) >= 0`, where `keep` is affine. */
function clip(polygon: ReadonlyArray<Vec2>, keep: (point: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  polygon.forEach((current, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length] as Vec2;
    const [a, b] = [keep(previous), keep(current)];
    if (a >= 0 !== b >= 0) {
      const t = a / (a - b);
      out.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t]);
    }
    if (b >= 0) out.push(current);
  });
  return out;
}

const area = (points: ReadonlyArray<Vec2>): number =>
  Math.abs(
    points.reduce(
      (sum, point, index) =>
        sum + point[0] * (points[(index + 1) % points.length] as Vec2)[1] - point[1] * (points[(index + 1) % points.length] as Vec2)[0],
      0,
    ),
  ) / 2;

/**
 * Boxes covering the convex plan polygon `outline` between the heights `zBottom` and `zTop`, in the frame turned by `angle` (radians from +X):
 * the polygon is expressed in that frame, cut into strips along the frame's x axis and each strip boxed by its own y extent.
 */
export function plateBoxes(outline: ReadonlyArray<Vec2>, angle: number, zBottom: number, zTop: number): OrientedBox[] {
  if (outline.length < 3 || !(zTop > zBottom)) return [];
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const local = outline.map((point): Vec2 => [point[0] * cos + point[1] * sin, -point[0] * sin + point[1] * cos]);
  const xs = local.map((point) => point[0]);
  const ys = local.map((point) => point[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  if (!(x1 > x0) || !(y1 > y0)) return [];
  const rectangular = Math.abs(area(local) - (x1 - x0) * (y1 - y0)) <= 1e-6 * (x1 - x0) * (y1 - y0);
  const strips = rectangular ? 1 : MAX_STRIPS;
  const boxes: OrientedBox[] = [];
  for (let strip = 0; strip < strips; strip++) {
    const [from, to] = [x0 + ((x1 - x0) * strip) / strips, x0 + ((x1 - x0) * (strip + 1)) / strips];
    const piece = rectangular
      ? local
      : clip(
          clip(local, (point) => point[0] - from),
          (point) => to - point[0],
        );
    if (piece.length < 3) continue;
    const [px, py] = [piece.map((point) => point[0]), piece.map((point) => point[1])];
    const [minX, maxX, minY, maxY] = [Math.min(...px), Math.max(...px), Math.min(...py), Math.max(...py)];
    if (!(maxX > minX) || !(maxY > minY)) continue;
    const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
    boxes.push({
      center: [cx * cos - cy * sin, cx * sin + cy * cos, (zBottom + zTop) / 2],
      axes: [
        [cos, sin, 0],
        [-sin, cos, 0],
        [0, 0, 1],
      ],
      half: [(maxX - minX) / 2, (maxY - minY) / 2, (zTop - zBottom) / 2],
    });
  }
  return boxes;
}
