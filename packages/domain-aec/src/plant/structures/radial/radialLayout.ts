/**
 * Pure plan layouts of winder and spiral stairs (06 STA §13.15), document units, z relative to the level. Treads: riser i tops at i x riserHeight.
 * Winder: F straight treads of depth `going`, W wedge treads turning 90 degrees round the inner corner of a width x width square, then B straight
 * treads of the second flight leaving through the side edge. Spiral: sector treads of `treadAngle` round a centre column, inner radius = column radius.
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type { RadialStairPlate, RadialStairRun } from '@aec/building/types';

export interface RadialGeometry {
  readonly plates: RadialStairPlate[];
  readonly runs: RadialStairRun[];
  /** Plan point of the top of the stair (last riser). */
  readonly end: Vec2;
}

export interface WinderInput {
  readonly start: Vec3;
  readonly angle: number;
  readonly sign: 1 | -1;
  readonly width: number;
  readonly going: number;
  readonly riserCount: number;
  readonly riserHeight: number;
  readonly straightTreads: number;
  readonly winders: number;
  readonly stringerWeb: number;
  readonly stringerDepth: number;
}

/** Most risers of a radial stair (a larger count is a unit mistake). */
export const MAX_RADIAL_RISERS = 200;

/** Plan arc step of a sector tread (tessellation of the outline, not an engineering value). */
const ARC_STEP = Math.PI / 18;

/** Straight treads of the second flight (what is left of the risers once the first flight and the winders are placed). */
export const secondFlightTreads = (riserCount: number, straightTreads: number, winders: number): number =>
  riserCount - 1 - straightTreads - winders;

const toPlan = (start: Vec3, angle: number, sign: 1 | -1): ((x: number, y: number) => Vec2) => {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return (x, y) => {
    const side = sign * y;
    return [start[0] + cos * x - sin * side, start[1] + sin * x + cos * side];
  };
};

/** Where a ray from the pivot at `theta` (in -90..0 degrees) leaves the square [0, w] x [-w, 0] measured from the pivot. */
const squareHit = (theta: number, width: number): Vec2 => {
  const [cos, sin] = [Math.cos(theta), Math.sin(theta)];
  const t = Math.min(cos > 1e-12 ? width / cos : Infinity, sin < -1e-12 ? width / -sin : Infinity);
  return [t * cos, t * sin];
};

/** Wedge `index` (0-based) of `count`: pivot, the two boundary hits and the square corner when the wedge spans it, local to the pivot. */
export function winderWedge(index: number, count: number, width: number): Vec2[] {
  const [a, b] = [-Math.PI / 2 + (index * Math.PI) / 2 / count, -Math.PI / 2 + ((index + 1) * Math.PI) / 2 / count];
  const corner = -Math.PI / 4;
  const points: Vec2[] = [[0, 0], squareHit(a, width)];
  if (a < corner - 1e-12 && corner < b - 1e-12) points.push([width, -width]);
  points.push(squareHit(b, width));
  return points;
}

export function winderGeometry(input: WinderInput): RadialGeometry {
  const { width: w, going: g, riserHeight: h, straightTreads: f, winders: n, riserCount } = input;
  const plan = toPlan(input.start, input.angle, input.sign);
  const base = input.start[2];
  const second = secondFlightTreads(riserCount, f, n);
  const plate = (local: ReadonlyArray<Vec2>, riser: number): RadialStairPlate => ({
    corners: local.map(([x, y]) => plan(x, y)),
    top: base + riser * h,
  });
  const plates: RadialStairPlate[] = [];
  for (let i = 1; i <= f; i++)
    plates.push(
      plate(
        [
          [(i - 1) * g, -w / 2],
          [i * g, -w / 2],
          [i * g, w / 2],
          [(i - 1) * g, w / 2],
        ],
        i,
      ),
    );
  const pivot: Vec2 = [f * g, w / 2];
  for (let j = 0; j < n; j++) {
    const wedge = winderWedge(j, n, w).map(([x, y]): Vec2 => [pivot[0] + x, pivot[1] + y]);
    plates.push(plate(wedge, f + j + 1));
  }
  const across = f * g + w / 2;
  for (let k = 1; k <= second; k++)
    plates.push(
      plate(
        [
          [across - w / 2, w / 2 + (k - 1) * g],
          [across + w / 2, w / 2 + (k - 1) * g],
          [across + w / 2, w / 2 + k * g],
          [across - w / 2, w / 2 + k * g],
        ],
        f + n + k,
      ),
    );

  const offset = w / 2 + input.stringerWeb / 2;
  const drop = input.stringerDepth / 2 / Math.cos(Math.atan2(h, g));
  const at = (x: number, y: number, riserHeights: number): Vec3 => {
    const [px, py] = plan(x, y);
    return [px, py, base + riserHeights * h - drop];
  };
  const runs: RadialStairRun[] = [];
  for (const side of [offset, -offset]) {
    runs.push({ from: at(0, side, 1), to: at(f * g, side, f + 1) });
    runs.push({ from: at(across + side, w / 2, f + n + 1), to: at(across + side, w / 2 + second * g, riserCount) });
  }
  const outer = { toCorner: across + offset - f * g, toEnd: offset + w / 2 };
  const middle = f + 1 + (n * outer.toCorner) / (outer.toCorner + outer.toEnd);
  runs.push({ from: at(f * g, -offset, f + 1), to: at(across + offset, -offset, middle) });
  runs.push({ from: at(across + offset, -offset, middle), to: at(across + offset, w / 2, f + n + 1) });
  return { plates, runs, end: plan(across, w / 2 + second * g) };
}

export interface SpiralInput {
  readonly start: Vec3;
  readonly angle: number;
  readonly sign: 1 | -1;
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly treadAngle: number;
  readonly riserCount: number;
  readonly riserHeight: number;
}

export function spiralGeometry(input: SpiralInput): RadialGeometry {
  const { start, innerRadius: r0, outerRadius: r1, treadAngle: step, riserHeight: h, riserCount } = input;
  const point = (radius: number, theta: number): Vec2 => [start[0] + radius * Math.cos(theta), start[1] + radius * Math.sin(theta)];
  const plates: RadialStairPlate[] = [];
  const segments = Math.max(1, Math.ceil(step / ARC_STEP - 1e-9));
  for (let i = 1; i < riserCount; i++) {
    const from = input.angle + input.sign * (i - 1) * step;
    const arc = (radius: number, reverse: boolean): Vec2[] => {
      const points = Array.from({ length: segments + 1 }, (_, k) => point(radius, from + (input.sign * step * k) / segments));
      return reverse ? points.reverse() : points;
    };
    plates.push({ corners: [...arc(r0, false), ...arc(r1, true)], top: start[2] + i * h });
  }
  const column: RadialStairRun = { from: [start[0], start[1], start[2]], to: [start[0], start[1], start[2] + riserCount * h] };
  return { plates, runs: [column], end: point((r0 + r1) / 2, input.angle + input.sign * (riserCount - 1) * step) };
}
