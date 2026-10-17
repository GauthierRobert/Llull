/** set_modeling_tolerance: the document's linear / angular / import-warning tolerances (aerospace 01 TR-KRN-11). */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, commandError, noop } from '../noop';
import { currentContext } from '../context';
import { LINEAR_TOLERANCE_RANGE_MM, modelingToleranceOf } from '../../model/kernelSettings';
import { kernelStampOf } from '../persistence/kernelStamp';
import type { DocumentKernelSettings } from '../../model/types';

const ANGULAR_RANGE_RAD: readonly [number, number] = [1e-12, 1e-3];
const MAX_IMPORT_RANGE_MM: readonly [number, number] = [1e-7, 1];

const inRange = (value: number, [low, high]: readonly [number, number]): boolean => Number.isFinite(value) && value >= low && value <= high;

/**
 * @affects replaces `kernelSettings.modelingTolerance`; a document without `kernelSettings` gets one naming the active kernel ('manifold' when none is
 *   installed; the next save restamps it from the kernel that saves)
 * @invariant linear in [1e-7, 1e-2] mm, angular in [1e-12, 1e-3] rad, maxImportTolerance in [1e-7, 1] mm and not below linear; omitted keys keep their value
 * @failure nothing given, a value out of range or maxImportTolerance < linear -> no-op, affected:[], error.code KRN_TOLERANCE_OUT_OF_RANGE with the param paths
 */
export const setModelingTolerance = defineCommand({
  name: 'set_modeling_tolerance',
  description:
    'Set the document modelling tolerances used by exact (B-rep) work. linear (mm, range 1e-7 to 1e-2, default 1e-4) is the heal / sew / STEP import precision; ' +
    'angular (rad, range 1e-12 to 1e-3, default 1e-9); maxImportTolerance (mm, range 1e-7 to 1, default 0.01, not below linear) is the threshold above which ' +
    'import_step_exact warns KRN_IMPORT_TOLERANCE_HIGH. Pass only the values to change. Out-of-range values are refused with KRN_TOLERANCE_OUT_OF_RANGE. ' +
    'Read the current values with kernel_info.',
  annotations: { idempotent: true },
  params: z.object({
    linear: z.number().optional().describe('Linear modelling tolerance in millimetres (NOT document units); 1e-7 to 1e-2. Default 1e-4.'),
    angular: z.number().optional().describe('Angular modelling tolerance in radians; 1e-12 to 1e-3. Default 1e-9.'),
    maxImportTolerance: z
      .number()
      .optional()
      .describe(
        'Warn threshold in millimetres for sub-shape tolerances after STEP import / heal; 1e-7 to 1, at least linear. Default 0.01.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const given = (['linear', 'angular', 'maxImportTolerance'] as const).filter((key) => params[key] !== undefined);
    if (given.length === 0)
      return noop(doc, 'set_modeling_tolerance: give at least one of linear (mm), angular (rad), maxImportTolerance (mm); no-op.');
    const next = { ...modelingToleranceOf(doc), ...Object.fromEntries(given.map((key) => [key, params[key]])) };
    const ranges = { linear: LINEAR_TOLERANCE_RANGE_MM, angular: ANGULAR_RANGE_RAD, maxImportTolerance: MAX_IMPORT_RANGE_MM } as const;
    const bad = given.filter((key) => !inRange(next[key], ranges[key]));
    if (bad.length === 0 && next.maxImportTolerance < next.linear) bad.push('maxImportTolerance');
    if (bad.length > 0) {
      const units = { linear: 'mm', angular: 'rad', maxImportTolerance: 'mm' } as const;
      const text = bad.map(
        (key) =>
          `${key} ${String(next[key])} ${units[key]} (allowed ${ranges[key][0]} to ${ranges[key][1]} ${units[key]}, maxImportTolerance >= linear)`,
      );
      return {
        ...noop(doc, `set_modeling_tolerance: out of range — ${text.join('; ')}; no-op.`),
        error: commandError('KRN_TOLERANCE_OUT_OF_RANGE', 'pass values inside the stated ranges (millimetres / radians)', [], bad),
      };
    }
    const stamp = kernelStampOf((ctx ?? currentContext()).kernel);
    const kernel = doc.kernelSettings?.kernel ?? stamp?.kernel ?? 'manifold';
    const kernelSettings: DocumentKernelSettings = { ...doc.kernelSettings, kernel, modelingTolerance: next };
    return changed(
      { ...doc, kernelSettings },
      `set_modeling_tolerance: linear ${next.linear} mm, angular ${next.angular} rad, maxImportTolerance ${next.maxImportTolerance} mm.`,
      [],
    );
  },
});
