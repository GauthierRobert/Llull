/**
 * The timestep study of check_motion_truth (PHY-23 TR-DRV-23 (b)): runs at dt, dt/2 (quick) and dt/4 (full), the observed order and the grid-convergence
 * index of every output (the arithmetic of `@lib/convergence`, Celik et al. with the 1.25 safety factor), and one coded item per output.
 */

import { gciTriplet, richardson } from '@lib/convergence';
import type { CheckThreshold } from '@core/model/checkResult';
import { type ReviewItem, reviewItem } from '@core/model/reviewEnvelope';
import { elementAt } from '@lib/elementAt';
import type { OutputDef } from './outputs';
import type { RunData } from '../runData';

/** GCI of the finest pair at or under which an output passes: 1 % of its value (TR-DRV-23). */
const GCI_GATE = 0.01;
/** GCI above which an output fails instead of warning. */
const GCI_FAIL = 0.1;
/** Observed order outside this range is reported (DRV_CONVERGENCE_IRREGULAR, spec 5.6). */
const ORDER_RANGE: readonly [number, number] = [0.5, 4];
/** An error-type output may exceed the range's top: the numerical error of an order-4 integrator reads 4.0 +- noise. */
const ERROR_ORDER_TOP = 4.5;
/** Safety factor of a grid study (Celik et al. 2008). */
const SAFETY = 1.25;
/** Outputs equal to this relative round-off are converged to the arithmetic. */
const ROUND_OFF = 1e-9;
/** A numerical error under this fraction of the energy scale is round-off, not discretisation. */
const ERROR_FLOOR = 1e-12;
/** A numerical error that does not fall with the step passes when it sits under this fraction of the energy scale (a step-independent floor). */
const FLOOR_PASS = 1e-4;

export interface StudyRow {
  readonly key: string;
  readonly kind: OutputDef['kind'];
  readonly unit: string;
  /** Value at each step size, coarse to fine. */
  readonly values: readonly number[];
  readonly steps: readonly number[];
  readonly order: number | null;
  /** True when no order could be observed (two levels): the first-order GCI of the pair is used. */
  readonly orderAssumed: boolean;
  readonly gci: number | null;
  readonly status: ReviewItem['status'];
  readonly note: string;
  /** The order (or the lack of one) is outside what the scheme should show: DRV_CONVERGENCE_IRREGULAR. */
  readonly irregular: boolean;
}

const threshold: CheckThreshold = {
  value: GCI_GATE,
  unit: 'GCI / value',
  source: 'TR-DRV-23 (b): GCI of the finest pair at most 1 % of the value (PHY-00 vocabulary, Celik et al. 2008)',
  grade: 'C',
  defaulted: true,
};

const FIX_STEP = 'Refine the timestep (simulate_motion timestep, set_dynamics_solver) until the result stops moving, or report it with its GCI.';

const byGci = (gci: number): ReviewItem['status'] => (gci <= GCI_GATE ? 'pass' : gci <= GCI_FAIL ? 'warn' : 'fail');

type Base = Pick<StudyRow, 'key' | 'kind' | 'unit' | 'values' | 'steps'>;
const row = (base: Base, rest: Omit<StudyRow, keyof Base>): StudyRow => ({ ...base, ...rest });

/** Value-type output: GCI of the finest pair (relative to its value). */
function valueRow(base: Base): StudyRow {
  const { values, steps } = base;
  const fine = [...values].reverse();
  const fineSteps = [...steps].reverse();
  const scale = Math.max(...values.map(Math.abs));
  if (Math.max(...values) - Math.min(...values) <= ROUND_OFF * Math.max(scale, Number.MIN_VALUE))
    return row(base, { order: null, orderAssumed: false, gci: 0, status: 'pass', note: 'identical at every step to round-off', irregular: false });
  const [f1, f2, f3] = fine;
  if (f1 === undefined || f2 === undefined)
    return row(base, { order: null, orderAssumed: false, gci: null, status: 'not_run', note: 'fewer than two levels', irregular: false });
  if (f3 === undefined) {
    // two levels: no observed order, the conservative first-order GCI of the pair
    const pair = richardson(f1, f2, elementAt(fineSteps, 1) / elementAt(fineSteps, 0), 1, SAFETY);
    const gci = pair.gci21Fine ?? pair.gciAbs ?? Number.NaN;
    return row(base, {
      order: null,
      orderAssumed: true,
      gci,
      status: byGci(gci),
      note: 'two levels: order assumed 1 (conservative); run level full for the observed order',
      irregular: false,
    });
  }
  const triplet = gciTriplet(
    [
      { h: elementAt(fineSteps, 0), value: f1 },
      { h: elementAt(fineSteps, 1), value: f2 },
      { h: elementAt(fineSteps, 2), value: f3 },
    ],
    SAFETY,
  );
  if ('orderNotConverged' in triplet)
    return row(base, { order: null, orderAssumed: false, gci: null, status: 'warn', note: 'the observed order did not converge', irregular: true });
  if (triplet.status === 'converged_exactly')
    return row(base, { order: null, orderAssumed: false, gci: 0, status: 'pass', note: 'two levels agree exactly', irregular: false });
  if (triplet.status !== 'monotone' || triplet.p === undefined) {
    // oscillatory / divergent: no order, judged by the relative change of the finest pair
    const change = f1 !== 0 ? Math.abs((f1 - f2) / f1) : Math.abs(f1 - f2);
    return row(base, {
      order: null,
      orderAssumed: false,
      gci: change,
      status: byGci(change),
      note: `${triplet.status} convergence (ratio ${triplet.ratio.toPrecision(3)}): no order; judged by the relative change of the two finest levels`,
      irregular: true,
    });
  }
  const gci = triplet.gci21Fine ?? triplet.gciAbs ?? Number.NaN;
  return row(base, {
    order: triplet.p,
    orderAssumed: false,
    gci,
    status: byGci(gci),
    note: `observed order ${triplet.p.toPrecision(3)}, GCI ${(gci * 100).toPrecision(3)} %`,
    irregular: triplet.p < ORDER_RANGE[0] || triplet.p > ORDER_RANGE[1],
  });
}

/**
 * Error-type output (a numerical error such as the energy balance): when it falls with the step its slope is the order; when it does not it is a
 * step-independent floor, judged against the energy scale.
 */
function errorRow(base: Base, scale: number): StudyRow {
  const { values, steps } = base;
  if (Math.max(...values) <= ERROR_FLOOR * scale)
    return row(base, { order: null, orderAssumed: false, gci: null, status: 'pass', note: 'at round-off of the energy scale at every step', irregular: false });
  const [coarse, mid, fine] = values;
  if (coarse === undefined || mid === undefined)
    return row(base, { order: null, orderAssumed: false, gci: null, status: 'not_run', note: 'fewer than two levels', irregular: false });
  const finest = fine === undefined ? mid : fine;
  const falling = fine === undefined ? mid < coarse : fine < mid && mid < coarse;
  if (!falling) {
    const floor = finest / scale;
    return row(base, {
      order: null,
      orderAssumed: false,
      gci: null,
      status: floor <= FLOOR_PASS ? 'pass' : 'warn',
      note: `the error does not fall with the step: it sits at a step-independent floor of ${finest.toExponential(2)} (${floor.toExponential(2)} of the energy scale)`,
      irregular: false,
    });
  }
  if (fine === undefined) {
    const order = Math.log2(coarse / mid);
    return row(base, { order, orderAssumed: false, gci: null, status: 'pass', note: `two levels: the error falls with the step, slope ${order.toPrecision(3)}`, irregular: false });
  }
  const triplet = gciTriplet(
    [
      { h: elementAt(steps, 2), value: fine },
      { h: elementAt(steps, 1), value: mid },
      { h: elementAt(steps, 0), value: coarse },
    ],
    SAFETY,
  );
  if ('orderNotConverged' in triplet || triplet.status !== 'monotone' || triplet.p === undefined)
    return row(base, { order: null, orderAssumed: false, gci: null, status: 'warn', note: 'the error falls but its order is undefined', irregular: true });
  const inside = triplet.p >= ORDER_RANGE[0] && triplet.p <= ERROR_ORDER_TOP;
  return row(base, {
    order: triplet.p,
    orderAssumed: false,
    gci: null,
    status: inside ? 'pass' : 'warn',
    note: `the error falls with order ${triplet.p.toPrecision(3)}`,
    irregular: !inside,
  });
}

/** The study rows of `defs` over `runs` (coarse to fine, one per step in `steps`); an output a run does not report gives a not_run row. */
export function studyRows(defs: readonly OutputDef[], runs: readonly RunData[], steps: readonly number[], scale: number): StudyRow[] {
  return defs.map((def): StudyRow => {
    const read = runs.map((run) => def.read(run));
    const values = read.filter((value): value is number => value !== null);
    const base: Base = { key: def.key, kind: def.kind, unit: def.unit, values, steps };
    if (values.length !== read.length)
      return row(base, { order: null, orderAssumed: false, gci: null, status: 'not_run', note: 'a run did not report this output', irregular: false });
    return def.kind === 'error' ? errorRow(base, scale) : valueRow(base);
  });
}

/** One review item per row, plus DRV_CONVERGENCE_IRREGULAR for a row whose order is outside [0.5, 4] or undefined. */
export function studyItems(rows: readonly StudyRow[]): ReviewItem[] {
  return rows.flatMap((entry): ReviewItem[] => {
    const numbers = {
      ...Object.fromEntries(entry.steps.map((step, k) => [`step${k}`, step])),
      ...Object.fromEntries(entry.values.map((value, k) => [`value${k}`, value])),
      ...(entry.order === null ? {} : { observedOrder: entry.order }),
      ...(entry.gci === null ? {} : { gci: entry.gci }),
    };
    const main = reviewItem('dynamics', 'DRV_TIMESTEP_STUDY', entry.status, [entry.key], entry.status === 'pass' ? 'None.' : FIX_STEP, {
      values: numbers,
      threshold,
      note: `${entry.key} [${entry.unit}]: ${entry.note}`,
      ...(entry.status === 'pass' ? {} : { unverified: true }),
    });
    if (!entry.irregular) return [main];
    return [
      main,
      reviewItem(
        'dynamics',
        'DRV_CONVERGENCE_IRREGULAR',
        'warn',
        [entry.key],
        'Refine the timestep or look for a discontinuity (a stop, a friction switch, a profile corner): the order of convergence is outside [0.5, 4] or undefined.',
        { values: entry.order === null ? {} : { observedOrder: entry.order }, note: `${entry.key}: ${entry.note}`, unverified: true },
      ),
    ];
  });
}
