/** Rainflow cycle counting per ASTM E1049-85 (5.4.4 three-point, 5.4.5 repeating history) plus a four-point variant (TR-FAT-20/21). */

export interface Cycle {
  readonly from: number;
  readonly to: number;
  readonly range: number;
  readonly mean: number;
  /** 1 = full cycle, 0.5 = half cycle. */
  readonly count: number;
}

const cycleOf = (from: number, to: number, count: number): Cycle => ({
  from,
  to,
  range: Math.abs(to - from),
  mean: (from + to) / 2,
  count,
});

/** Peaks and valleys of a series: first and last points kept, plateaus collapsed; `gate` drops reversals smaller than the hysteresis band. */
export function reversalsOf(series: readonly number[], gate = 0): number[] {
  const points: number[] = [];
  for (const x of series) {
    const last = points.at(-1);
    if (last === undefined) points.push(x);
    else if (x === last) continue;
    else if (points.length >= 2 && (last - (points.at(-2) ?? last)) * (x - last) > 0) points[points.length - 1] = x;
    else points.push(x);
  }
  if (gate <= 0) return points;
  const gated: number[] = [];
  for (const x of points) {
    const last = gated.at(-1);
    if (last === undefined || Math.abs(x - last) >= gate) gated.push(x);
  }
  return gated.length < 2 ? points.slice(0, 1) : reversalsOf(gated);
}

/** Three-point rule; the residue is counted as half cycles. */
export function rainflowThreePoint(series: readonly number[], gate = 0): Cycle[] {
  const stack: number[] = [];
  const cycles: Cycle[] = [];
  for (const point of reversalsOf(series, gate)) {
    stack.push(point);
    while (stack.length >= 3) {
      const last = stack[stack.length - 1] ?? 0;
      const middle = stack[stack.length - 2] ?? 0;
      const first = stack[stack.length - 3] ?? 0;
      if (Math.abs(last - middle) < Math.abs(middle - first)) break;
      if (stack.length === 3) {
        cycles.push(cycleOf(first, middle, 0.5));
        stack.shift();
      } else {
        cycles.push(cycleOf(first, middle, 1));
        stack.splice(stack.length - 3, 2);
      }
    }
  }
  for (let i = 0; i + 1 < stack.length; i += 1) cycles.push(cycleOf(stack[i] ?? 0, stack[i + 1] ?? 0, 0.5));
  return cycles;
}

/** Four-point rule: full cycles only, plus the residue (not yet counted). */
export function rainflowFourPoint(series: readonly number[], gate = 0): { readonly full: Cycle[]; readonly residue: number[] } {
  const stack: number[] = [];
  const full: Cycle[] = [];
  for (const point of reversalsOf(series, gate)) {
    stack.push(point);
    while (stack.length >= 4) {
      const [s1 = 0, s2 = 0, s3 = 0, s4 = 0] = stack.slice(-4);
      const inner = Math.abs(s3 - s2);
      if (inner > Math.abs(s2 - s1) || inner > Math.abs(s4 - s3)) break;
      full.push(cycleOf(s2, s3, 1));
      stack.splice(stack.length - 3, 2);
    }
  }
  return { full, residue: stack };
}

/** Repeating-history rule (E1049 5.4.5): restart at the largest |value|, close the loop; every cycle is a full cycle. */
export function rainflowRepeating(series: readonly number[], gate = 0): Cycle[] {
  let reversals = reversalsOf(series, gate);
  if (reversals.length >= 2 && reversals[0] === reversals.at(-1)) reversals = reversals.slice(0, -1);
  if (reversals.length < 2) return [];
  let start = 0;
  reversals.forEach((value, index) => {
    if (Math.abs(value) > Math.abs(reversals[start] ?? 0)) start = index;
  });
  const loop = [...reversals.slice(start), ...reversals.slice(0, start), reversals[start] ?? 0];
  const stack: number[] = [];
  const cycles: Cycle[] = [];
  for (const point of reversalsOf(loop)) {
    stack.push(point);
    while (stack.length >= 3) {
      const last = stack[stack.length - 1] ?? 0;
      const middle = stack[stack.length - 2] ?? 0;
      const first = stack[stack.length - 3] ?? 0;
      if (Math.abs(last - middle) < Math.abs(middle - first)) break;
      cycles.push(cycleOf(first, middle, 1));
      stack.splice(stack.length - 3, 2);
    }
  }
  return cycles;
}

export type CountingMethod = 'rainflow_3pt' | 'rainflow_4pt' | 'rainflow_repeating';
export type ResidueRule = 'half_cycles' | 'repeat';

/** Cycles of `series` by `method`; `residue: 'repeat'` closes the history as a repeating block. */
export function countCycles(series: readonly number[], method: CountingMethod, residue: ResidueRule, gate = 0): Cycle[] {
  if (method === 'rainflow_repeating' || residue === 'repeat') return rainflowRepeating(series, gate);
  if (method === 'rainflow_3pt') return rainflowThreePoint(series, gate);
  const { full, residue: left } = rainflowFourPoint(series, gate);
  return [...full, ...rainflowThreePoint(left)];
}

/** [range, count] totals sorted by range. */
export function totalsOf(cycles: readonly Cycle[]): Array<[number, number]> {
  const sums = new Map<number, number>();
  for (const cycle of cycles) sums.set(cycle.range, (sums.get(cycle.range) ?? 0) + cycle.count);
  return [...sums.entries()].sort((a, b) => a[0] - b[0]);
}
