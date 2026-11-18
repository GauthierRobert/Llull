/**
 * Harness of the performance gate (docs/decisions/PERF1-performance-budgets.md). A budget is a wall-clock ceiling at the speed of the
 * reference machine; `machineFactor` scales it to the machine the gate runs on, so a slow CI runner does not fail a healthy build and a
 * fast workstation does not hide a regression.
 */
import { expect } from 'vitest';
import { BUDGETS, type BudgetId } from './budgets';

/** Milliseconds of `calibrationWorkload` on the reference machine (PERF1 §2). */
const REFERENCE_CALIBRATION_MS = 110;
/** The factor never leaves this range: outside it the machine is not a place to judge budgets, only to report. */
const FACTOR_RANGE = { min: 0.6, max: 3 } as const;

/** A fixed single-thread mix of integer hashing, float arithmetic, map inserts and string building. */
function calibrationWorkload(): number {
  let state = 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const values = new Float64Array(400_000);
  for (let index = 0; index < values.length; index += 1) values[index] = next() * 2 - 1;
  let sum = 0;
  for (let pass = 0; pass < 12; pass += 1)
    for (let index = 1; index < values.length; index += 1)
      sum += Math.sqrt(Math.abs((values[index] ?? 0) * (values[index - 1] ?? 0))) * 0.5;
  const table = new Map<number, number[]>();
  for (let index = 0; index < 300_000; index += 1) {
    const key = Math.floor(next() * 60_000);
    const bucket = table.get(key);
    if (bucket === undefined) table.set(key, [index]);
    else bucket.push(index);
  }
  const parts: string[] = [];
  for (let index = 0; index < 150_000; index += 1) parts.push(`${index}:${(values[index] ?? 0).toFixed(4)}`);
  return sum + table.size + parts.join(',').length;
}

let factor: number | null = null;

/** Speed of this machine against the reference (1 = the reference; 2 = half as fast), from the best of five calibration runs. */
export function machineFactor(): number {
  if (factor !== null) return factor;
  calibrationWorkload();
  let best = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    calibrationWorkload();
    best = Math.min(best, performance.now() - started);
  }
  if (process.env['LLULL_PERF_DEBUG'] === '1') console.warn(`calibration ${best.toFixed(1)} ms`);
  factor = Math.min(FACTOR_RANGE.max, Math.max(FACTOR_RANGE.min, best / REFERENCE_CALIBRATION_MS));
  return factor;
}

export interface Measurement {
  readonly id: BudgetId;
  readonly milliseconds: number;
  readonly allowedMs: number;
}

const measurements: Measurement[] = [];

/** Median wall time of `runs` calls of `fn` (awaited), in milliseconds. */
export async function medianMs(fn: () => unknown, runs = 5): Promise<number> {
  const times: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await fn();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}

/** Records `milliseconds` for budget `id` and fails the test when it is over the budget scaled to this machine. */
export function expectWithinBudget(id: BudgetId, milliseconds: number): void {
  const allowedMs = BUDGETS[id].budgetMs * machineFactor();
  measurements.push({ id, milliseconds, allowedMs });
  expect(
    milliseconds,
    `${id} (${BUDGETS[id].title}): ${milliseconds.toFixed(0)} ms over its budget of ${allowedMs.toFixed(0)} ms`,
  ).toBeLessThanOrEqual(allowedMs);
}

/** The table of every measurement taken in this file, one line per budget (printed by each gate file when it ends). */
export function reportMeasurements(): string {
  const lines = measurements.map(({ id, milliseconds, allowedMs }) => {
    const budget = BUDGETS[id];
    const verdict = milliseconds <= allowedMs ? 'ok  ' : 'OVER';
    return `${verdict} ${id.padEnd(34)} ${milliseconds.toFixed(0).padStart(7)} ms  budget ${allowedMs.toFixed(0).padStart(6)} ms  (before PERF1: ${budget.baselineMs === null ? 'not measured' : `${budget.baselineMs} ms`})`;
  });
  return [`performance gate, machine factor ${machineFactor().toFixed(2)} (1 = reference)`, ...lines].join('\n');
}
