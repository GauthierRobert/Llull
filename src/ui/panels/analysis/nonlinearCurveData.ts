// Typed readers over the `data` of nonlinear_report and limit_load (PHY-05) plus the screen mapping of one load-displacement curve.
// Nothing is computed here beyond scaling to pixels: every number is the commands'. A reader returns null when the command refused.

import { isRecord } from '@lib/isRecord';

export interface CurveView {
  readonly probeId: string;
  readonly name: string;
  readonly loadUnit: string;
  readonly displacementUnit: string;
  /** Points of the whole curve (the arrays hold at most 100 evenly spread samples of them in the summary view). */
  readonly points: number;
  readonly maxLoad: number;
  readonly snapBack: boolean;
  readonly load: readonly number[];
  readonly displacement: readonly number[];
}

export interface StepView {
  readonly stepId: string;
  readonly increments: number;
  readonly cutbacks: number;
  readonly completed: boolean;
}

export interface NonlinearReportView {
  readonly completed: boolean;
  readonly nlgeom: boolean;
  readonly curves: readonly CurveView[];
  readonly steps: readonly StepView[];
  readonly maxPeeq: number | null;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
}

export interface LimitView {
  /** `limit`: a limit load was found; `lowerBound`: the curve never peaks, the load is only a lower bound. */
  readonly kind: 'limit' | 'lowerBound';
  readonly value: number;
  readonly method: string;
  readonly atDisplacement: number;
  readonly loadUnit: string;
  readonly lengthUnit: string;
}

const numbers = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) ? (value as number[]) : null;

function curveOf(entry: unknown): CurveView | null {
  if (!isRecord(entry)) return null;
  const { probeId, name, loadUnit, displacementUnit, points, maxLoad, snapBack } = entry;
  const load = numbers(entry['load']);
  const displacement = numbers(entry['displacement']);
  if (typeof probeId !== 'string' || typeof name !== 'string' || typeof loadUnit !== 'string' || typeof displacementUnit !== 'string')
    return null;
  if (typeof points !== 'number' || typeof maxLoad !== 'number' || load === null || displacement === null) return null;
  if (load.length !== displacement.length) return null;
  return { probeId, name, loadUnit, displacementUnit, points, maxLoad, snapBack: snapBack === true, load, displacement };
}

export function parseNonlinearReport(data: unknown): NonlinearReportView | null {
  if (!isRecord(data) || !Array.isArray(data['curves']) || typeof data['completed'] !== 'boolean') return null;
  const peeq = data['maxPeeq'];
  const reasons = data['unverifiedReasons'];
  return {
    completed: data['completed'],
    nlgeom: data['nlgeom'] === true,
    curves: data['curves'].flatMap((entry) => curveOf(entry) ?? []),
    steps: (Array.isArray(data['steps']) ? data['steps'] : []).flatMap((entry): StepView[] => {
      if (!isRecord(entry) || typeof entry['stepId'] !== 'string') return [];
      const { stepId, increments, cutbacks, completed } = entry;
      return typeof increments === 'number' && typeof cutbacks === 'number'
        ? [{ stepId, increments, cutbacks, completed: completed === true }]
        : [];
    }),
    maxPeeq: isRecord(peeq) && typeof peeq['value'] === 'number' ? peeq['value'] : null,
    unverified: data['unverified'] === true,
    unverifiedReasons: Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === 'string') : [],
  };
}

export function parseLimitLoad(data: unknown): LimitView | null {
  if (!isRecord(data) || typeof data['atDisplacement'] !== 'number') return null;
  const found = data['found'];
  const limit = data['limitLoad'];
  const bound = data['lowerBound'];
  const kind = found === 'not_reached' ? 'lowerBound' : 'limit';
  const value = kind === 'limit' ? limit : bound;
  if (typeof value !== 'number' || typeof data['loadUnit'] !== 'string' || typeof data['lengthUnit'] !== 'string') return null;
  return {
    kind,
    value,
    method: typeof found === 'string' ? found : '',
    atDisplacement: data['atDisplacement'],
    loadUnit: data['loadUnit'],
    lengthUnit: data['lengthUnit'],
  };
}

export interface PlotSize {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
}

export interface CurvePlot {
  /** `points` attribute of the polyline: magnitudes of displacement (x) against load (y), y up. */
  readonly polyline: string;
  readonly at: (index: number) => { readonly x: number; readonly y: number };
  readonly maxDisplacement: number;
  readonly maxLoad: number;
}

/** Screen mapping of the curve magnitudes (a reaction is signed by its direction: the plot shows |load| against |displacement|). */
export function plotCurve(curve: CurveView, size: PlotSize): CurvePlot {
  const xs = curve.displacement.map(Math.abs);
  const ys = curve.load.map(Math.abs);
  const maxDisplacement = Math.max(0, ...xs);
  const maxLoad = Math.max(0, ...ys);
  const inner = { width: size.width - 2 * size.margin, height: size.height - 2 * size.margin };
  const at = (index: number): { x: number; y: number } => ({
    x: size.margin + (maxDisplacement === 0 ? 0 : ((xs[index] ?? 0) / maxDisplacement) * inner.width),
    y: size.height - size.margin - (maxLoad === 0 ? 0 : ((ys[index] ?? 0) / maxLoad) * inner.height),
  });
  const polyline = xs
    .map((_, index) => {
      const point = at(index);
      return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    })
    .join(' ');
  return { polyline, at, maxDisplacement, maxLoad };
}
