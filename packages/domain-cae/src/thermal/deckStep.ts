/** `*STEP` / `*HEAT TRANSFER` lines and the result-time control of the thermal deck (PHY-03 TR-THM-13). */

import type { ThermalSetup } from '@core/model/analysis';
import { significantNumber } from '@lib/compactNumber';
import { num, row } from '../decks/format';
import { OUTPUT_TIME_POINTS } from './deckNames';
import { siOf } from './quantities';

/** Named deck rule: the initial increment when none is set is the end time divided by this. */
const DEFAULT_INCREMENTS = 100;
/** Named deck rule: increment budget (`*STEP, INC=`) of steady and automatic-increment steps. */
const INCREMENT_BUDGET = 10000;
const MAX_OUTPUT_TIMES = 20000;

export interface StepPlan {
  /** `*TIME POINTS` block placed before the step (empty when result times are not given as times). */
  readonly timePoints: readonly string[];
  /** Parameter appended to `*NODE FILE` / `*EL FILE` / `*NODE PRINT` (`FREQUENCY=n`, `TIME POINTS=TP_OUT`), or ''. */
  readonly output: string;
  readonly stepLines: readonly string[];
  readonly notes: readonly string[];
}

const wrap = (values: readonly number[], perLine: number): string[] => {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += perLine) lines.push(row(...values.slice(i, i + perLine)));
  return lines;
};

/** Result times for `outputEveryS`: every multiple up to the end, and the end itself. */
function everyTimes(every: number, end: number): number[] | null {
  const count = Math.floor(end / every + 1e-9);
  if (count + 1 > MAX_OUTPUT_TIMES) return null;
  const times = Array.from({ length: count }, (_, i) => Number(significantNumber((i + 1) * every, 12)));
  if (end - (times[times.length - 1] ?? 0) > 1e-9 * end) times.push(end);
  else times[times.length - 1] = end;
  return times;
}

/**
 * The step lines and result-time control. Decision (PHY-03 open question 2, tested against ccx 2.21): fixed increments (`DIRECT`) cannot be
 * combined with `TIME POINTS`, so they use `FREQUENCY=every/increment`; automatic increments use a `*TIME POINTS` set (`outputTimesS`, or the
 * multiples of `outputEveryS`), which makes ccx land exactly on each requested time; with no request every increment is written.
 * @failure more than 20000 result times -> null
 */
export function planStep(
  thermal: ThermalSetup,
  steady: boolean,
  procedure: 'HEAT TRANSFER' | 'COUPLED TEMPERATURE-DISPLACEMENT' = 'HEAT TRANSFER',
): StepPlan | null {
  if (steady) return { timePoints: [], output: '', stepLines: ['*STEP, INC=200', `*${procedure}, STEADY STATE`, row(1, 1)], notes: [] };
  const step = thermal.step;
  const end = step.endTimeS ?? 0;
  const notes: string[] = [];
  const initial = step.initialIncrementS ?? end / DEFAULT_INCREMENTS;
  if (step.initialIncrementS === undefined)
    notes.push(`** initial increment defaulted to endTimeS/${DEFAULT_INCREMENTS} (llull deck rule)`);
  const fixed = step.fixedIncrements === true;
  let timePoints: string[] = [];
  let output = '';
  if (fixed) {
    if (step.outputEveryS !== undefined) output = `FREQUENCY=${Math.max(1, Math.round(step.outputEveryS / initial))}`;
  } else {
    const times =
      step.outputTimesS !== undefined ? [...step.outputTimesS] : step.outputEveryS !== undefined ? everyTimes(step.outputEveryS, end) : [];
    if (times === null) return null;
    if (times.length > 0) {
      timePoints = [`*TIME POINTS, NAME=${OUTPUT_TIME_POINTS}`, ...wrap(times, 8)];
      output = `TIME POINTS=${OUTPUT_TIME_POINTS}`;
    }
  }
  const deltmx = step.maxTemperatureChangePerIncrement;
  const heat = [
    `*${procedure}`,
    fixed ? 'DIRECT' : null,
    deltmx !== undefined ? `DELTMX=${num(siOf('temperatureDifference', deltmx))}` : null,
  ];
  const limits =
    !fixed && (step.minIncrementS !== undefined || step.maxIncrementS !== undefined)
      ? [
          `${row(initial, end, step.minIncrementS ?? Math.min(initial, 1e-5 * end))}, ${step.maxIncrementS === undefined ? '1e30' : num(step.maxIncrementS)}`,
        ]
      : [row(initial, end)];
  const budget = fixed ? Math.ceil(end / initial) + 1 : INCREMENT_BUDGET;
  return { timePoints, output, notes, stepLines: [`*STEP, INC=${budget}`, heat.filter((part) => part !== null).join(', '), ...limits] };
}
