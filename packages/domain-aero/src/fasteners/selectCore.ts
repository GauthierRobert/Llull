/**
 * Grip, shim, length and protrusion selection (08 MAT TECHNICAL_SPEC §5.2). Pure integer arithmetic on ticks (1e-6 of the working unit,
 * see ./units), so 1/16 in and 1/32 in rules are exact.
 */

export interface Reason {
  readonly code: string;
  readonly message: string;
}

export interface BoltInput {
  readonly stackTicks: number;
  readonly gripTicks: number;
  readonly gripMin: number;
  readonly gripMax: number;
  readonly threadLengthTicks: number;
  readonly washerOptions: readonly number[] | null;
  readonly maxWasherTicks: number;
  readonly nutHeightMaxTicks: number | null;
  readonly pitchTicks: number | null;
  readonly nutGiven: boolean;
}

export interface BoltSelection {
  readonly ok: boolean;
  readonly gripDash: number;
  readonly gripValueTicks: number;
  readonly lengthTicks: number;
  readonly gapTicks: number;
  readonly washers: readonly number[];
  readonly protrusion: {
    readonly status: 'ok' | 'short' | 'unknown' | 'not_checked';
    readonly ticks?: number;
    readonly requiredTicks?: number;
  };
  readonly reasons: readonly Reason[];
  readonly warnings: readonly Reason[];
}

const ceilDiv = (numerator: number, denominator: number): number =>
  Math.floor(numerator / denominator) + (numerator % denominator === 0 ? 0 : 1);

/** Length listed for a grip: the grip truncated to 0.001 of the unit plus the thread length, rounded to 0.001 (distributor listing rule). */
export function listedLengthTicks(gripValueTicks: number, threadLengthTicks: number): number {
  const truncated = Math.floor(gripValueTicks / 1000) * 1000;
  return Math.round((truncated + threadLengthTicks) / 1000) * 1000;
}

/**
 * Smallest-cardinality multiset (at most 3) of `options` whose sum is >= `gap` and <= `max`; ties go to the smallest sum.
 * @returns the thicknesses in ascending order, or null when none exists
 */
function shimWashers(gap: number, options: readonly number[], max: number): number[] | null {
  if (gap <= 0) return [];
  const sorted = [...new Set(options)].filter((option) => option > 0).sort((a, b) => a - b);
  for (let count = 1; count <= 3; count += 1) {
    let best: number[] | null = null;
    let bestSum = Infinity;
    const walk = (from: number, chosen: number[]): void => {
      if (chosen.length === count) {
        const sum = chosen.reduce((total, value) => total + value, 0);
        if (sum >= gap && sum <= max && sum < bestSum) {
          best = [...chosen];
          bestSum = sum;
        }
        return;
      }
      for (let index = from; index < sorted.length; index += 1) walk(index, [...chosen, sorted[index] as number]);
    };
    walk(0, []);
    if (best !== null) return best;
  }
  return null;
}

/** Bolt/pin with a minimum grip >= stack (NAS/AN style). */
export function selectBolt(input: BoltInput): BoltSelection {
  const reasons: Reason[] = [];
  const warnings: Reason[] = [];
  const needed = ceilDiv(input.stackTicks, input.gripTicks);
  const gripDash = Math.max(input.gripMin, needed);
  const gripValueTicks = gripDash * input.gripTicks;
  const lengthTicks = listedLengthTicks(gripValueTicks, input.threadLengthTicks);
  const gapTicks = gripValueTicks - input.stackTicks;
  const base = { gripDash, gripValueTicks, lengthTicks, gapTicks };
  if (gripDash > input.gripMax) {
    reasons.push({
      code: 'FAST_STACK_OUT_OF_RANGE',
      message: `stack needs grip dash ${gripDash}, the largest in the catalogue is ${input.gripMax}`,
    });
    return { ...base, ok: false, washers: [], protrusion: { status: 'not_checked' }, reasons, warnings };
  }
  const washers =
    input.washerOptions === null ? (gapTicks === 0 ? [] : null) : shimWashers(gapTicks, input.washerOptions, input.maxWasherTicks);
  if (washers === null) {
    reasons.push({
      code: 'FAST_WASHER_GAP',
      message:
        input.washerOptions === null
          ? 'grip leaves a gap but no washer family was given to shim it'
          : 'no washer set (at most 3) fills the gap within the maximum washer total',
    });
    return { ...base, ok: false, washers: [], protrusion: { status: 'not_checked' }, reasons, warnings };
  }
  if (!input.nutGiven) return { ...base, ok: true, washers, protrusion: { status: 'not_checked' }, reasons, warnings };
  if (input.nutHeightMaxTicks === null || input.pitchTicks === null) {
    warnings.push({
      code: 'FAST_PROTRUSION_UNKNOWN',
      message: 'nut maximum height or thread pitch is not in the catalogue: protrusion is not checked',
    });
    return { ...base, ok: true, washers, protrusion: { status: 'unknown' }, reasons, warnings };
  }
  const washerTotal = washers.reduce((sum, value) => sum + value, 0);
  const ticks = lengthTicks - input.stackTicks - washerTotal - input.nutHeightMaxTicks;
  if (ticks < input.pitchTicks) {
    reasons.push({ code: 'FAST_PROTRUSION_SHORT', message: 'protrusion beyond the nut maximum height is less than one thread pitch' });
    return { ...base, ok: false, washers, protrusion: { status: 'short', ticks, requiredTicks: input.pitchTicks }, reasons, warnings };
  }
  return { ...base, ok: true, washers, protrusion: { status: 'ok', ticks, requiredTicks: input.pitchTicks }, reasons, warnings };
}

/** Hi-Lok style: the pin whose range ((n-1)·Δ, n·Δ] contains the stack. */
export function selectMaxGripPin(
  stackTicks: number,
  gripTicks: number,
  gripMin: number,
  gripMax: number,
): { ok: boolean; gripDash: number; rangeTicks: [number, number]; reasons: Reason[] } {
  const gripDash = Math.max(gripMin, ceilDiv(stackTicks, gripTicks));
  const rangeTicks: [number, number] = [(gripDash - 1) * gripTicks, gripDash * gripTicks];
  const ok = gripDash <= gripMax;
  return {
    ok,
    gripDash,
    rangeTicks,
    reasons: ok
      ? []
      : [{ code: 'FAST_STACK_OUT_OF_RANGE', message: `stack needs grip dash ${gripDash}, the largest in the catalogue is ${gripMax}` }],
  };
}

/** Solid rivet: length = stack + k·D rounded to a step (up or nearest); returns the length and its dash. */
export function selectRivetLength(
  stackTicks: number,
  diameterTicks: number,
  k: number,
  stepTicks: number,
  round: 'up' | 'nearest',
): { rawTicks: number; lengthTicks: number; lengthDash: number } {
  const rawTicks = stackTicks + Math.round(k * diameterTicks);
  const lengthDash = round === 'up' ? ceilDiv(rawTicks, stepTicks) : Math.round(rawTicks / stepTicks);
  return { rawTicks, lengthTicks: lengthDash * stepTicks, lengthDash };
}
