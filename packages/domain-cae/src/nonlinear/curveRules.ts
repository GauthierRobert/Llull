/** Rules read off the step list and the curves of a nonlinear case: unloading step, snap-back indicator (PHY-05 §5.4, FR-NLS-07). */

import type { NonlinearSettings } from '@core/model/analysis';
import type { CurveData } from './curves';
import { multiplierHistory } from './history';

/**
 * The last step that returns every load case it names to zero after a non-zero start (an unloading step); undefined without one.
 * @invariant a step that names no load case never counts
 */
export function unloadingStep(nonlinear: NonlinearSettings): string | undefined {
  let found: string | undefined;
  for (const { stepId, start } of multiplierHistory(nonlinear)) {
    const named = Object.values(nonlinear.steps[stepId]?.multipliers ?? {});
    if (named.length > 0 && named.every((value) => value === 0) && Object.values(start).some((value) => value !== 0)) found = stepId;
  }
  return found;
}

/** Displacement-control steps that do not unload, as the [start, end] total-time interval of each (step k spans [k, k + 1]). */
function advancingDisplacementIntervals(nonlinear: NonlinearSettings): readonly (readonly [number, number])[] {
  const intervals: (readonly [number, number])[] = [];
  let previous = 0;
  nonlinear.stepOrder.forEach((stepId, index) => {
    const control = nonlinear.steps[stepId]?.control;
    if (control?.kind !== 'displacement') return;
    if (Math.abs(control.value) >= Math.abs(previous)) intervals.push([index, index + 1]);
    previous = control.value;
  });
  return intervals;
}

/**
 * Snap-back indicator: inside a displacement-controlled advancing step the controlled displacement grows, so a probe displacement that falls
 * (in magnitude) while the load magnitude falls means the equilibrium path turns back on itself. An indicator only: CalculiX cannot trace it.
 */
export function snapBackDetected(nonlinear: NonlinearSettings, curve: CurveData): boolean {
  const intervals = advancingDisplacementIntervals(nonlinear);
  for (let index = 1; index < curve.time.length; index++) {
    const [time, before, load, loadBefore, displacement, displacementBefore] = [
      curve.time[index] ?? 0,
      curve.time[index - 1] ?? 0,
      Math.abs(curve.load[index] ?? 0),
      Math.abs(curve.load[index - 1] ?? 0),
      Math.abs(curve.displacement[index] ?? 0),
      Math.abs(curve.displacement[index - 1] ?? 0),
    ];
    const inside = intervals.some(([from, to]) => before >= from - 1e-9 && time <= to + 1e-9);
    if (inside && displacement < displacementBefore && load < loadBefore) return true;
  }
  return false;
}
