/**
 * Dimensions, elevations, coordinates and slopes of a line (plant 05 ISO §5.9, TR-ISO-10 / 11), all from the 3D centreline, never from the drawing: a string dimension
 * per straight run between connection points (flange face, weld, fitting centre) plus the overall, `EL` at horizontal runs and vertical line ends, `E .. N ..` at line
 * ends and branch points, and the slope of a run that falls along a horizontal axis. Every label carries its exact 3D value. Pure.
 */

import type { Vec3 } from '@core/model/vectors';
import { distance3 } from '@lib/vec3';
import type { IsoGraph, IsoRun } from './isoGraph';

/** Display precision of a length label, mm. */
const DISPLAY_STEP = 0.1;

export const roundMm = (value: number): number => Number((Math.round(value / DISPLAY_STEP) * DISPLAY_STEP).toFixed(1)) + 0;

/** Label text of a length: one decimal at most, no trailing zero. */
export const mmText = (value: number): string => String(roundMm(value));

export interface DimensionLabel {
  readonly text: string;
  /** The value the label shows, mm. */
  readonly valueMm: number;
  /** The exact 3D distance, mm. */
  readonly exactMm: number;
  readonly from: Vec3;
  readonly to: Vec3;
}

export interface RunDimension {
  readonly run: number;
  readonly axis: IsoRun['axis'];
  /** Displayed string values, mm. */
  readonly values: readonly number[];
  readonly overall: number;
  readonly labels: readonly DimensionLabel[];
  readonly overallLabel: DimensionLabel;
  readonly points: readonly Vec3[];
  /** Labels whose value differs from the 3D distance by more than the display step, plus a string that does not close to its overall. */
  readonly mismatches: number;
}

export interface IsoAnnotation {
  readonly kind: 'elevation' | 'coordinate' | 'slope' | 'weld' | 'spool' | 'continuation';
  readonly text: string;
  readonly at: Vec3;
  readonly run?: number;
  readonly [extra: string]: unknown;
}

/** Strings of every run with a length, in run order. */
export function runDimensions(graph: IsoGraph): RunDimension[] {
  return graph.runs.flatMap((run): RunDimension[] => {
    const first = run.points[0];
    const last = run.points[run.points.length - 1];
    if (first === undefined || last === undefined || run.points.length < 2) return [];
    const labels = run.points.slice(1).map((to, at): DimensionLabel => {
      const from = run.points[at] as Vec3;
      const exactMm = distance3(from, to);
      return { text: mmText(exactMm), valueMm: roundMm(exactMm), exactMm, from, to };
    });
    const exact = distance3(first, last);
    const overallLabel: DimensionLabel = { text: mmText(exact), valueMm: roundMm(exact), exactMm: exact, from: first, to: last };
    const closure = Math.abs(labels.reduce((sum, label) => sum + label.exactMm, 0) - exact) > 1e-6;
    const off = [...labels, overallLabel].filter((label) => Math.abs(label.valueMm - label.exactMm) > DISPLAY_STEP / 2 + 1e-9).length;
    return [
      {
        run: run.id,
        axis: run.axis,
        values: labels.map((label) => label.valueMm),
        overall: overallLabel.valueMm,
        labels,
        overallLabel,
        points: run.points,
        mismatches: off + (closure ? 1 : 0),
      },
    ];
  });
}

const signed = (value: number): string => (value === 0 ? '0' : `${value > 0 ? '+' : '-'}${mmText(Math.abs(value))}`);
const HORIZONTAL = new Set(['+E', '-E', '+N', '-N', 'slope']);
const AXIS_NAME = ['X', 'Y'] as const;

/** `1:n` when the ratio is within 0.5 % of an integer, else the percent. */
function slopeText(horizontal: number, drop: number): { text: string; ratio: string | null; percent: number; deg: number } {
  const ratio = horizontal / drop;
  const percent = (100 * drop) / horizontal;
  const deg = (Math.atan(drop / horizontal) * 180) / Math.PI;
  const whole = Math.round(ratio);
  const isRatio = whole >= 1 && Math.abs(ratio - whole) <= 0.005 * whole;
  return {
    text: isRatio ? `SLOPE 1:${whole}` : `SLOPE ${Number(percent.toFixed(2))} %`,
    ratio: isRatio ? `1:${whole}` : null,
    percent,
    deg,
  };
}

/** Elevations, coordinates and slopes of a line, in run order. */
export function lineAnnotations(graph: IsoGraph): IsoAnnotation[] {
  const out: IsoAnnotation[] = [];
  const seen = new Set<string>();
  const add = (annotation: IsoAnnotation): void => {
    const key = `${annotation.kind}|${annotation.text}|${annotation.at.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(annotation);
  };
  const elevation = (at: Vec3, run: number): void => add({ kind: 'elevation', text: `EL ${signed(at[2])}`, at, run, elevationMm: at[2] });
  const coordinate = (at: Vec3, run: number): void =>
    add({ kind: 'coordinate', text: `E ${mmText(at[0])} N ${mmText(at[1])}`, at, run, eastMm: at[0], northMm: at[1] });
  for (const run of graph.runs) {
    const first = run.points[0] as Vec3;
    const last = run.points[run.points.length - 1] as Vec3;
    if (HORIZONTAL.has(run.axis)) elevation(first, run.id);
    if (run.axis === 'slope') {
      elevation(last, run.id);
      const horizontal = Math.hypot(last[0] - first[0], last[1] - first[1]);
      const drop = Math.abs(last[2] - first[2]);
      if (horizontal > 0 && drop > 0) {
        const falls = last[2] < first[2];
        const [from, to] = falls ? [first, last] : [last, first];
        const axis = Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]) ? 0 : 1;
        const sign = (to[axis] as number) - (from[axis] as number) >= 0 ? '+' : '-';
        add({
          kind: 'slope',
          ...slopeText(horizontal, drop),
          at: [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2, (first[2] + last[2]) / 2],
          run: run.id,
          fallDirection: `${sign}${AXIS_NAME[axis]}`,
          fallFrom: from,
          fallTo: to,
          horizontalMm: horizontal,
          dropMm: drop,
        });
      }
    }
  }
  const ends = new Set<string>();
  graph.steps.forEach((step, index) => {
    for (const [key, point] of [
      [step.entryKey, step.start],
      [step.exitKey, step.end],
    ] as const) {
      const branchStart =
        key === step.entryKey &&
        step.parent >= 0 &&
        (graph.degree.get(key) ?? 0) >= 3 &&
        (graph.steps[step.parent]?.run ?? step.run) !== step.run;
      if (((graph.degree.get(key) ?? 0) === 1 || branchStart) && !ends.has(key)) {
        ends.add(key);
        coordinate(point, step.run);
        if ((graph.degree.get(key) ?? 0) === 1 && !HORIZONTAL.has(step.axis)) elevation(point, step.run);
      }
    }
    if (index === 0 && !ends.has(step.entryKey)) {
      ends.add(step.entryKey);
      coordinate(step.start, step.run);
    }
  });
  return out;
}
