/** check_sweep_loft volume-consistency check (TECHNICAL_SPEC 5.4): the kernel volume of a sweep whose section stays normal to its path must equal ∫ A(s) ds. */

import type { SweepEntity } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { recipeOf } from '../../geometry/shapeRecipe';
import { sweepConsistencyVolume } from '../../geometry/sweepEval/volume';
import { REMEDIATION, sig, type Finding } from './checkFindings';

/** One measured comparison, reported in `data.volumeChecks`. */
export interface VolumeCheck {
  readonly entityId: string;
  readonly expected: number;
  readonly measured: number;
  /** (measured - expected) / expected: negative = material missing (an overlap), positive = surplus. */
  readonly relativeDeviation: number;
}

/**
 * Compares the exact kernel volume with ∫ A(s) ds.
 * @invariant kernel-optional: without a kernel that integrates exactly (`massProperties`), or for a sweep whose premise does not hold, nothing is measured
 * @failure |measured - expected| / expected > `tolerance` -> a fail finding SWG_CHECK_VOLUME_MISMATCH (a deficit reveals overlapping turns or a fold)
 */
export function checkVolume(
  entity: SweepEntity,
  kernel: GeometryKernel | null | undefined,
  tolerance: number,
  unit: string,
): { check: VolumeCheck; finding: Finding | null } | null {
  if (kernel?.massProperties === undefined) return null;
  const expected = sweepConsistencyVolume(entity);
  if (expected === null || !(expected > 0)) return null;
  const shape = kernel.evaluate(recipeOf(entity));
  const measured = shape === null ? null : (kernel.massProperties(shape)?.volume ?? null);
  if (measured === null || !(measured > 0)) return null;
  const relativeDeviation = (measured - expected) / expected;
  const check: VolumeCheck = {
    entityId: entity.id,
    expected: sig(expected),
    measured: sig(measured),
    relativeDeviation: sig(relativeDeviation),
  };
  if (Math.abs(relativeDeviation) <= tolerance) return { check, finding: null };
  return {
    check,
    finding: {
      code: 'SWG_CHECK_VOLUME_MISMATCH',
      severity: 'fail',
      entityId: entity.id,
      value: sig(Math.abs(relativeDeviation)),
      limit: tolerance,
      unit: 'ratio',
      remediation: REMEDIATION.SWG_CHECK_VOLUME_MISMATCH as string,
      message: `exact volume ${sig(measured)} ${unit}^3 vs integral of the section area along the path ${sig(expected)} ${unit}^3 (${
        relativeDeviation < 0 ? 'deficit' : 'surplus'
      } ${sig(Math.abs(relativeDeviation))}, limit ${tolerance}): the sweep overlaps itself or folds`,
    },
  };
}
