/**
 * Skew boxes of an isometric (plant 05 ISO §5.8, TR-ISO-10): a run that is not parallel to a plant axis is drawn at its projected angle inside a squaring-in figure,
 * the legs along the plant axes that add up to it (a triangle for a horizontal offset or an offset in a vertical plane, three legs for an oblique run), with each leg
 * dimensioned and the angle stated. Lengths and angles come from the 3D centreline, never from the drawing. Pure; the figure is drawn in the sheet frame of `layout`.
 */

import type { Vec2, Vec3 } from '@core/model/vectors';
import { distance3 } from '@lib/vec3';
import { nodeKey } from '../joints';
import { mmText, type IsoAnnotation } from './isoDimensions';
import type { IsoGraph } from './isoGraph';
import type { IsoLayout } from './isoLayout';
import { projectIso, type NorthArrow } from './isoProjection';
import type { IsoPrimitive } from './isoRender';

/** A leg shorter than this (mm) is no leg: the run is a skew by rounding only. */
const MIN_LEG_MM = 0.05;
const AXES = ['E', 'N', 'U'] as const;

export type SkewPlane = 'horizontal' | 'vertical_E' | 'vertical_N' | 'oblique';

export interface SkewMark {
  readonly annotation: IsoAnnotation;
  /** Where the label sits on the sheet, paper mm. */
  readonly anchor: Vec2;
}

export interface SkewFigure {
  readonly primitives: readonly IsoPrimitive[];
  readonly marks: readonly SkewMark[];
}

const degrees = (radians: number): number => Number(((radians * 180) / Math.PI).toFixed(9));

/** Plane, angle (degrees) and legs of a skew vector: a triangle's angle is measured from its longer leg, an oblique run's from the horizontal plane. */
export function skewGeometry(d: Vec3): { plane: SkewPlane; angleDeg: number; legs: ReadonlyArray<{ axis: 0 | 1 | 2; mm: number }> } {
  const legs = ([0, 1, 2] as const).flatMap((axis) => (Math.abs(d[axis]) > MIN_LEG_MM ? [{ axis, mm: Math.abs(d[axis]) }] : []));
  if (legs.length === 3) return { plane: 'oblique', angleDeg: degrees(Math.atan2(Math.abs(d[2]), Math.hypot(d[0], d[1]))), legs };
  const [first, second] = [legs[0], legs[1]];
  const plane: SkewPlane = first?.axis === 0 && second?.axis === 1 ? 'horizontal' : first?.axis === 0 ? 'vertical_E' : 'vertical_N';
  const [long, short] = (second?.mm ?? 0) > (first?.mm ?? 0) ? [second?.mm ?? 0, first?.mm ?? 0] : [first?.mm ?? 0, second?.mm ?? 0];
  return { plane, angleDeg: degrees(Math.atan2(short, long)), legs };
}

export function skewFigures(graph: IsoGraph, layout: IsoLayout, northArrow: NorthArrow): SkewFigure {
  const primitives: IsoPrimitive[] = [];
  const marks: SkewMark[] = [];
  for (const run of graph.runs) {
    if (run.axis !== 'skew') continue;
    const first = run.points[0];
    const last = run.points[run.points.length - 1];
    if (first === undefined || last === undefined) continue;
    const [from, to] = [layout.nodes.get(nodeKey(first)), layout.nodes.get(nodeKey(last))];
    if (from === undefined || to === undefined) continue;
    const d: Vec3 = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
    const geometry = skewGeometry(d);
    if (geometry.legs.length < 2) continue;
    const projected = projectIso(d, northArrow);
    const factor = Math.hypot(to[0] - from[0], to[1] - from[1]) / (Math.hypot(...projected) || 1);
    const corners: Vec2[] = [from];
    for (const leg of geometry.legs) {
      const sign = Math.sign(d[leg.axis]);
      const step = projectIso([leg.axis === 0 ? sign : 0, leg.axis === 1 ? sign : 0, leg.axis === 2 ? sign : 0], northArrow);
      const previous = corners[corners.length - 1] as Vec2;
      corners.push([previous[0] + step[0] * leg.mm * factor, previous[1] + step[1] * leg.mm * factor]);
    }
    primitives.push({ t: 'poly', layer: 'ISO-DIM', points: corners, closed: false });
    const lengthMm = distance3(first, last);
    marks.push({
      anchor: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
      annotation: {
        kind: 'skew',
        text: `SKEW ${mmText(lengthMm)} ${Number(geometry.angleDeg.toFixed(2))} DEG`,
        at: [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2, (first[2] + last[2]) / 2],
        run: run.id,
        lengthMm,
        legsMm: geometry.legs.map((leg) => Number(leg.mm.toFixed(6))),
        legAxes: geometry.legs.map((leg) => AXES[leg.axis]),
        angleDeg: geometry.angleDeg,
        plane: geometry.plane,
      },
    });
    geometry.legs.forEach((leg, at) => {
      const [p, q] = [corners[at] as Vec2, corners[at + 1] as Vec2];
      marks.push({
        anchor: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
        annotation: {
          kind: 'skew_leg',
          text: mmText(leg.mm),
          at: first,
          run: run.id,
          axis: AXES[leg.axis],
          valueMm: Number(leg.mm.toFixed(6)),
        },
      });
    });
  }
  return { primitives, marks };
}
