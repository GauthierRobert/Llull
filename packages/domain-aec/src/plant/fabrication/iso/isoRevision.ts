/**
 * Revision clouds and delta triangles (plant 05 ISO §13.6, VC-ISO-23): the components and welds that are new or changed since the last issued revision are circled by a
 * scalloped cloud on layer ISO-REV, with a triangle carrying the revision label at its top right corner. Clouds that overlap are merged. Pure, deterministic.
 */

import type { Vec2, Vec3 } from '@core/model/vectors';
import type { IsoGraph } from './isoGraph';
import type { IsoPrimitive } from './isoRender';

/** What to circle on a sheet: component ids and numbered welds (with their 3D point) that differ from the issued revision. */
export interface RevisionDelta {
  readonly label: string;
  readonly componentIds: ReadonlySet<string>;
  readonly welds: ReadonlyMap<string, Vec3>;
}

export interface RevisionMark {
  readonly componentIds: readonly string[];
  readonly welds: readonly string[];
  /** Cloud centre, paper mm. */
  readonly sheet: Vec2;
  readonly at: Vec3;
}

type Box = { x0: number; y0: number; x1: number; y1: number; componentIds: string[]; welds: string[]; at: Vec3 };

const PAD = 4;
const BUMP = 4;
const TRIANGLE = 3.4;

const overlaps = (a: Box, b: Box): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Scalloped closed outline of a box: bumps of about BUMP mm, each a half circle bulging outward (counter-clockwise walk). */
function cloudOutline(box: Box): Vec2[] {
  const corners: Vec2[] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  const out: Vec2[] = [];
  corners.forEach((from, index) => {
    const to = corners[(index + 1) % 4] as Vec2;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const bumps = Math.max(1, Math.round(length / BUMP));
    const ux = (to[0] - from[0]) / length;
    const uy = (to[1] - from[1]) / length;
    const radius = length / bumps / 2;
    for (let bump = 0; bump < bumps; bump++) {
      const centre: Vec2 = [from[0] + ux * radius * (2 * bump + 1), from[1] + uy * radius * (2 * bump + 1)];
      for (let step = 0; step <= 6; step++) {
        const angle = Math.PI - (Math.PI * step) / 6;
        const along = Math.cos(angle) * radius;
        const outward = Math.sin(angle) * radius;
        out.push([centre[0] + ux * along + uy * outward, centre[1] + uy * along - ux * outward]);
      }
    }
  });
  return out;
}

export function revisionMarks(
  graph: IsoGraph,
  nodes: ReadonlyMap<string, Vec2>,
  starts: readonly Vec2[],
  ends: readonly Vec2[],
  delta: RevisionDelta,
  nodeKeyOf: (xyz: Vec3) => string,
): { primitives: IsoPrimitive[]; marks: RevisionMark[] } {
  const boxes: Box[] = [];
  graph.steps.forEach((walked, step) => {
    const id = walked.segment.componentId;
    if (!delta.componentIds.has(id)) return;
    const a = starts[step] as Vec2;
    const b = ends[step] as Vec2;
    boxes.push({
      x0: Math.min(a[0], b[0]) - PAD,
      y0: Math.min(a[1], b[1]) - PAD,
      x1: Math.max(a[0], b[0]) + PAD,
      y1: Math.max(a[1], b[1]) + PAD,
      componentIds: [id],
      welds: [],
      at: walked.start,
    });
  });
  for (const [number, xyz] of delta.welds) {
    const point = nodes.get(nodeKeyOf(xyz));
    if (point === undefined) continue;
    boxes.push({
      x0: point[0] - PAD,
      y0: point[1] - PAD,
      x1: point[0] + PAD,
      y1: point[1] + PAD,
      componentIds: [],
      welds: [number],
      at: xyz,
    });
  }
  const merged: Box[] = [];
  for (const box of boxes) {
    let current = box;
    for (let at = merged.length - 1; at >= 0; at--) {
      const other = merged[at] as Box;
      if (!overlaps(current, other)) continue;
      merged.splice(at, 1);
      current = {
        x0: Math.min(current.x0, other.x0),
        y0: Math.min(current.y0, other.y0),
        x1: Math.max(current.x1, other.x1),
        y1: Math.max(current.y1, other.y1),
        componentIds: [...other.componentIds, ...current.componentIds],
        welds: [...other.welds, ...current.welds],
        at: other.at,
      };
    }
    merged.push(current);
  }
  const primitives: IsoPrimitive[] = [];
  const marks: RevisionMark[] = [];
  for (const box of merged) {
    primitives.push({ t: 'poly', layer: 'ISO-REV', points: cloudOutline(box), closed: true });
    const base: Vec2 = [box.x1 + TRIANGLE * 0.6, box.y1 + TRIANGLE * 0.2];
    primitives.push(
      {
        t: 'poly',
        layer: 'ISO-REV',
        points: [
          [base[0] - TRIANGLE, base[1]],
          [base[0] + TRIANGLE, base[1]],
          [base[0], base[1] + TRIANGLE * 1.7],
        ],
        closed: true,
      },
      { t: 'text', layer: 'ISO-REV', at: [base[0], base[1] + 0.4], size: 2, text: delta.label, anchor: 'middle' },
    );
    marks.push({
      componentIds: box.componentIds,
      welds: box.welds,
      sheet: [Number(((box.x0 + box.x1) / 2).toFixed(2)), Number(((box.y0 + box.y1) / 2).toFixed(2))],
      at: box.at,
    });
  }
  return { primitives, marks };
}
