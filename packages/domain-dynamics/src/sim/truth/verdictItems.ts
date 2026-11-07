/** Effort, provenance and the verdict of check_motion_truth (PHY-23 TR-DRV-23 (d), (e), TR-DRV-24). */

import type { Motor } from '@core/model/dynamics';
import { type ReviewItem, reviewItem } from '@core/model/reviewEnvelope';
import { unboundedEffort } from '../driveReport';
import { peakAbs } from '../sizing';
import type { ProvenanceInput } from '../provenance';
import type { RunData } from '../runData';

export type TruthVerdict = 'trusted' | 'plausible' | 'not_trusted';

const EFFORT_FIX =
  'Use a motor model (add_motor kind "dc") or give the sourced torque limit (add_motor source) close to the effort the motion needs: an unsourced or oversized bound can supply any torque the motion asks for.';

/**
 * DRV_EFFORT_UNBOUNDED per speed / linear-speed governor whose bound comes from no source, or exceeds 10 x the peak effort the run used; one pass item when the
 * model has governors and none is flagged (a model with none has no item). Without a run (null) only the source is judged.
 */
export function effortItems(motors: readonly Motor[], run: RunData | null): ReviewItem[] {
  const governors = motors.filter((motor) => motor.kind === 'speed' || motor.kind === 'linear_speed');
  const items = governors.flatMap((motor): ReviewItem[] => {
    const peak = run === null ? null : peakAbs(run.series?.motorTorque[motor.id] ?? []);
    const why = unboundedEffort(motor, peak);
    return why === null
      ? []
      : [
          reviewItem('dynamics', 'DRV_EFFORT_UNBOUNDED', 'warn', [motor.id], EFFORT_FIX, {
            note: why,
            ...(peak === null ? {} : { values: { peakEffortUsed: peak } }),
            unverified: true,
          }),
        ];
  });
  return items.length > 0 || governors.length === 0 || run === null
    ? items
    : [
        reviewItem(
          'dynamics',
          'DRV_EFFORT_UNBOUNDED',
          'pass',
          governors.map((motor) => motor.id),
          'None.',
          { note: 'every governor bound is sourced and within 10 x the effort used' },
        ),
      ];
}

/** DRV_PARAM_UNSOURCED: the inputs of grade C or without a source (warn, the weakest first), or a pass item naming the lowest grade when all are A / B. */
export function provenanceItem(inputs: readonly ProvenanceInput[]): ReviewItem {
  const weak = inputs.filter((input) => input.grade === 'C' || input.grade === 'unsourced');
  if (weak.length === 0)
    return reviewItem('dynamics', 'DRV_PARAM_UNSOURCED', 'pass', [], 'None.', {
      note:
        inputs.length === 0
          ? 'no graded drive-physics input in the model'
          : `every graded input is A or B (lowest: ${inputs[0]?.id} ${inputs[0]?.grade})`,
    });
  return reviewItem(
    'dynamics',
    'DRV_PARAM_UNSOURCED',
    'warn',
    weak.map((input) => input.id),
    'Give each listed input a source of grade A or B (add_motor / add_transmission / set_joint_physics `source`, measured with fit_drive_parameters): the result stays `plausible` until then.',
    {
      values: { weakInputs: weak.length, ofInputs: inputs.length },
      note: `lowest grade first: ${weak.map((input) => `${input.id} (${input.grade}: ${input.source})`).join('; ')}`,
      unverified: true,
    },
  );
}

/**
 * trusted = no fail, no warn, nothing skipped (every graded input is A / B, the provenance item being one of the items); plausible = no fail but a warning, a
 * skipped item or a weak input; not_trusted = any fail (TR-DRV-23). `info` items never lower the verdict.
 */
export function truthVerdict(items: readonly ReviewItem[]): TruthVerdict {
  if (items.some((item) => item.status === 'fail')) return 'not_trusted';
  return items.some((item) => item.status === 'warn' || item.status === 'not_run') ? 'plausible' : 'trusted';
}
