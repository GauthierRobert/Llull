/** Load-case multiplier history of a nonlinear case: the values every step starts from and ends at (pure; step time = 1). */

import type { FeaLoad, NonlinearSettings } from '@core/model/analysis';

export interface StepMultipliers {
  readonly stepId: string;
  readonly start: Readonly<Record<string, number>>;
  readonly end: Readonly<Record<string, number>>;
}

/** Per step in order: multipliers at its start and end; a load case a step omits keeps its previous value (0 before the first mention). */
export function multiplierHistory(nonlinear: NonlinearSettings): StepMultipliers[] {
  const history: StepMultipliers[] = [];
  let current: Record<string, number> = {};
  for (const stepId of nonlinear.stepOrder) {
    const step = nonlinear.steps[stepId];
    if (step === undefined) continue;
    const start = current;
    current = { ...current, ...step.multipliers };
    history.push({ stepId, start, end: current });
  }
  return history;
}

/** Base value of a load: pressure magnitude, force / moment / gravity vector length (the multiplier scales this). */
export function loadBaseValue(load: FeaLoad): number {
  if (load.kind === 'pressure' || load.magnitude !== undefined) return load.magnitude ?? 0;
  return load.vector === undefined ? 0 : Math.hypot(...load.vector);
}

/**
 * Multiplier of `loadCase` at the cumulative total time `time` (steps occupy [0, 1], [1, 2], ...): linear inside a ramp step, the end value
 * at any time after the start of a `step` amplitude step; times past the last step hold the last value; 0 before the first step.
 */
export function multiplierAt(nonlinear: NonlinearSettings, loadCase: string, time: number): number {
  const history = multiplierHistory(nonlinear);
  if (history.length === 0 || !(time > 0)) return 0;
  const index = Math.min(history.length - 1, Math.max(0, Math.ceil(time - 1e-12) - 1));
  const entry = history[index];
  if (entry === undefined) return 0;
  const from = entry.start[loadCase] ?? 0;
  const to = entry.end[loadCase] ?? 0;
  if (nonlinear.steps[entry.stepId]?.amplitude === 'step') return to;
  const fraction = Math.min(1, Math.max(0, time - index));
  return from + (to - from) * fraction;
}
