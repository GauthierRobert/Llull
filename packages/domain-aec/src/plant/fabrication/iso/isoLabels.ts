/**
 * Dimension lines and label placement of an isometric (plant 05 ISO §5.8 / §5.9, TR-ISO-10): each run gets a string of dimension lines on the side with fewer
 * neighbouring nodes, plus an overall line, with oblique ticks and text rotated to read along the line; other labels (EL, coordinates, weld and spool marks, slope)
 * go to the first of a fixed candidate list whose box meets no placed label and no drawn line. Positions are paper mm (y up). Pure, deterministic.
 */

import type { Vec2 } from '@core/model/vectors';
import { nodeKey } from '../joints';
import type { IsoLayout } from './isoLayout';
import type { RunDimension } from './isoDimensions';
import type { IsoPrimitive } from './isoRender';

export const TEXT_SIZE = 2.5;
const CHAR_WIDTH = 0.58;

type Segment = readonly [Vec2, Vec2];
interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Liang-Barsky: does the segment touch the box? */
function segmentHitsBox([p, q]: Segment, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const d: Vec2 = [q[0] - p[0], q[1] - p[1]];
  const checks: Array<[number, number]> = [
    [-d[0], p[0] - box.x0],
    [d[0], box.x1 - p[0]],
    [-d[1], p[1] - box.y0],
    [d[1], box.y1 - p[1]],
  ];
  for (const [pk, qk] of checks) {
    if (pk === 0) {
      if (qk < 0) return false;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

const CANDIDATES: ReadonlyArray<readonly [number, number, 'start' | 'middle' | 'end']> = [
  [2.5, 2.5, 'start'],
  [-2.5, 2.5, 'end'],
  [2.5, -4.5, 'start'],
  [-2.5, -4.5, 'end'],
  [0, 5, 'middle'],
  [0, -7.5, 'middle'],
  [6, 0, 'start'],
  [-6, 0, 'end'],
];

export class LabelPlacer {
  private readonly boxes: Box[] = [];

  constructor(private readonly segments: Segment[]) {}

  /** Adds a drawn line that later labels must avoid. */
  avoid(segment: Segment): void {
    this.segments.push(segment);
  }

  /** The text anchor point and alignment of the least-overlapping candidate around `anchor`; the box is reserved. */
  place(anchor: Vec2, text: string, size = TEXT_SIZE): { readonly at: Vec2; readonly align: 'start' | 'middle' | 'end' } {
    const width = text.length * size * CHAR_WIDTH;
    let best: { score: number; at: Vec2; align: 'start' | 'middle' | 'end'; box: Box } | null = null;
    for (const [dx, dy, align] of CANDIDATES) {
      const x = anchor[0] + dx;
      const y = anchor[1] + dy;
      const left = align === 'start' ? x : align === 'middle' ? x - width / 2 : x - width;
      const box: Box = { x0: left, y0: y - 0.2 * size, x1: left + width, y1: y + size };
      const score =
        this.boxes.filter((other) => overlaps(box, other)).length * 10 +
        this.segments.filter((segment) => segmentHitsBox(segment, box)).length;
      if (best === null || score < best.score) best = { score, at: [x, y], align, box };
      if (score === 0) break;
    }
    const chosen = best as NonNullable<typeof best>;
    this.boxes.push(chosen.box);
    return { at: chosen.at, align: chosen.align };
  }
}

const OFFSET = 6;
const OVERALL_OFFSET = 11;

/** Dimension lines, ticks and rotated labels of every run (a string line, and an overall line when the run has more than one piece). */
export function dimensionPrimitives(dimensions: readonly RunDimension[], layout: IsoLayout, shift: (point: Vec2) => Vec2): IsoPrimitive[] {
  const out: IsoPrimitive[] = [];
  const nodes = [...layout.nodes.values()];
  for (const dimension of dimensions) {
    const points = dimension.points.map((point) => layout.nodes.get(nodeKey(point))).filter((point): point is Vec2 => point !== undefined);
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined || points.length !== dimension.points.length) continue;
    const length = Math.hypot(last[0] - first[0], last[1] - first[1]);
    if (length < 1e-6) continue;
    const u: Vec2 = [(last[0] - first[0]) / length, (last[1] - first[1]) / length];
    const normals: Vec2[] = [
      [-u[1], u[0]],
      [u[1], -u[0]],
    ];
    const crowd = (normal: Vec2): number => {
      const centre: Vec2 = [(first[0] + last[0]) / 2 + normal[0] * OFFSET, (first[1] + last[1]) / 2 + normal[1] * OFFSET];
      return nodes.filter(
        (node) =>
          Math.hypot(node[0] - centre[0], node[1] - centre[1]) < Math.max(4, length / 2 + 2) &&
          Math.abs((node[0] - centre[0]) * normal[0] + (node[1] - centre[1]) * normal[1]) < 3.5,
      ).length;
    };
    const [a, b] = normals as [Vec2, Vec2];
    const normal = crowd(a) < crowd(b) || (crowd(a) === crowd(b) && (a[1] > 0 || (a[1] === 0 && a[0] > 0))) ? a : b;
    const draw = (stations: readonly Vec2[], offset: number, texts: readonly string[]): void => {
      const along = (p: Vec2): Vec2 => shift([p[0] + normal[0] * offset, p[1] + normal[1] * offset]);
      stations.forEach((station) => {
        out.push({
          t: 'line',
          layer: 'ISO-DIM',
          a: shift(station),
          b: shift([station[0] + normal[0] * (offset + 1.5), station[1] + normal[1] * (offset + 1.5)]),
        });
        const at = along(station);
        out.push({ t: 'line', layer: 'ISO-DIM', a: [at[0] - 0.9, at[1] - 0.9], b: [at[0] + 0.9, at[1] + 0.9] });
      });
      for (let k = 1; k < stations.length; k++) {
        const [from, to] = [along(stations[k - 1] as Vec2), along(stations[k] as Vec2)];
        out.push({ t: 'line', layer: 'ISO-DIM', a: from, b: to });
        let angle = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
        if (angle > 90 || angle <= -90) angle += angle > 0 ? -180 : 180;
        const radians = (angle * Math.PI) / 180;
        const up: Vec2 = [-Math.sin(radians), Math.cos(radians)];
        const lift = up[0] * normal[0] + up[1] * normal[1] > 0 ? 0.8 : 0.8 + TEXT_SIZE;
        out.push({
          t: 'text',
          layer: 'ISO-TEXT',
          at: [(from[0] + to[0]) / 2 + normal[0] * lift, (from[1] + to[1]) / 2 + normal[1] * lift],
          size: TEXT_SIZE,
          text: texts[k - 1] as string,
          anchor: 'middle',
          rotation: angle,
        });
      }
    };
    draw(
      points,
      OFFSET,
      dimension.labels.map((label) => label.text),
    );
    if (dimension.labels.length > 1) draw([first, last], OVERALL_OFFSET, [dimension.overallLabel.text]);
  }
  return out;
}
