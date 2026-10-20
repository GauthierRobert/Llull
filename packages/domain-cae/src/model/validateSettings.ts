/** Value validation of the optional settings of an analysis case: result view, buckling preload and marginal band (raw, untrusted file data). */

import { isRecord } from '@lib/isRecord';
import { RESULT_VIEW_FIELDS } from '../commands/resultView';

const isNonNegative = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Errors of `view`, `preloadLoadCase` and `marginalBand` of one raw case; empty when they are absent or well formed. */
export function settingsErrors(analysisCase: Record<string, unknown>, where: string): string[] {
  const errors: string[] = [];
  const view = analysisCase['view'];
  if (view !== undefined) {
    if (!isRecord(view)) errors.push(`${where}: view must be a record`);
    else {
      if (!(RESULT_VIEW_FIELDS as readonly unknown[]).includes(view['field'])) errors.push(`${where}: view.field is not a result field`);
      if (view['mode'] !== undefined && !(Number.isInteger(view['mode']) && (view['mode'] as number) >= 1))
        errors.push(`${where}: view.mode must be an integer >= 1`);
      if (!isNonNegative(view['deformationScale'])) errors.push(`${where}: view.deformationScale must be a finite number >= 0`);
      if (view['loadCase'] !== undefined && typeof view['loadCase'] !== 'string') errors.push(`${where}: view.loadCase must be text`);
    }
  }
  const preload = analysisCase['preloadLoadCase'];
  if (preload !== undefined) {
    const loads = isRecord(analysisCase['loads']) ? Object.values(analysisCase['loads']) : [];
    if (analysisCase['type'] !== 'buckling') errors.push(`${where}: only buckling cases carry a preloadLoadCase`);
    else if (typeof preload !== 'string') errors.push(`${where}: preloadLoadCase must be text`);
    else if (!loads.some((load) => isRecord(load) && load['loadCase'] === preload))
      errors.push(`${where}: preloadLoadCase '${preload}' names no load case of the analysis`);
  }
  if (analysisCase['marginalBand'] !== undefined && !isNonNegative(analysisCase['marginalBand']))
    errors.push(`${where}: marginalBand must be a finite number >= 0`);
  return errors;
}
