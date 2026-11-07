/**
 * Run warnings as truth items (PHY-23 TR-DRV-23): a warning the run raises about its own physics must reach the verdict, otherwise a run that lost steps or
 * used a model form the user should know about reads `trusted`. Every CODED warning (`DRV_...:` / `FPR_...:` prefix) of the run becomes one item; the table
 * below decides its status, and a code that is not in it defaults to `warn` (a new warning cannot bypass the verdict by being forgotten here).
 * Uncoded warnings (free text such as "still accelerating") are advice about the length of the run, not about the model, and make no item.
 */

import { type ReviewItem, reviewItem } from '@core/model/reviewEnvelope';
import type { RunData } from '../runData';

type PolicyStatus = 'fail' | 'warn' | 'info';

interface Policy {
  readonly status: PolicyStatus;
  /** What the user does about it. */
  readonly fix: string;
  /** Why this status (the exemptions are `info`, with the reason they never lower the verdict). */
  readonly reason: string;
}

/** The status of every coded run warning the plugin emits. `info` entries are explicit exemptions. */
export const RUN_WARNING_POLICY: Readonly<Record<string, Policy>> = {
  DRV_STEPS_LOST: {
    status: 'fail',
    fix: 'Lower the load or the step rate, raise the current setpoint, or choose a stepper whose pull-out torque at that speed exceeds the load: the position the run reports is not the commanded one.',
    reason: 'the stepper ended the run with steps lost: its motion is not the commanded motion',
  },
  DRV_STEPPER_OVERSHOOT: {
    status: 'warn',
    fix: 'Add damping or ramp the step rate: the rotor left its stable range during the run and only recovered.',
    reason: 'a recovered overshoot is not a stable operating point',
  },
  DRV_STEPPER_TIMESTEP: {
    status: 'warn',
    fix: 'Use a timestep below the one the warning names (set `timestep`): the explicit step does not resolve the stepper ringing or its damping.',
    reason: 'the integration step is too coarse for the stepper dynamics, so the run is not converged',
  },
  DRV_INDUCTION_QUASI_STEADY: {
    status: 'warn',
    fix: 'Treat the result as the mean torque behaviour: the model has no flux transients, so a direct-on-line start torque pulsation is not shown.',
    reason:
      'the induction torque is the steady-state value at the instantaneous slip (a stated model form), which caps the verdict at plausible',
  },
  DRV_PMSM_VOLTAGE_OVER: {
    status: 'warn',
    fix: 'Lower the torque demand, raise the bus voltage or the speed margin: the envelope neglects the winding resistance, so the real limit is below the one used.',
    reason: 'the stator voltage exceeded the bus limit the envelope assumed',
  },
  DRV_TRACKING_ERROR: {
    status: 'warn',
    fix: 'Raise the current limit or the bandwidth, or slow the profile: the effort is not the inverse dynamics.',
    reason: 'the axis did not follow its profile',
  },
  DRV_STICTION_NOT_LATCHED: {
    status: 'warn',
    fix: 'Read the note of the run: the rest latch is off for this joint, so the stick-slip holding it relies on is not modelled there.',
    reason: 'a joint friction model that cannot hold the joint at rest in this run',
  },
  FPR_OUTSIDE_VALIDATED_RANGE: {
    status: 'warn',
    fix: 'Keep the propeller advance ratio inside the measured table, or give a table that covers it.',
    reason: 'the run left the validated range of a measured table',
  },
  FPR_SAMPLING_ALIASED: {
    status: 'warn',
    fix: 'Raise the sample rate: the recorded series alias the motion.',
    reason: 'the recorded series are not a faithful sampling of the motion',
  },
  FPR_SAMPLING_COARSE: {
    status: 'warn',
    fix: 'Raise the sample rate of the run.',
    reason: 'the recorded series are coarse for the quantity read from them',
  },
  FPR_UNREALISTIC: {
    status: 'warn',
    fix: 'Read the realism note of the run and correct the engine inputs it names.',
    reason: 'the engine inputs are outside the realistic range',
  },
  DRV_ELECTRICAL_QUASI_STATIC: {
    status: 'info',
    fix: 'None.',
    reason:
      'exempt: a winding faster than the step is treated as algebraic by design, the effect is below the step and does not change the result',
  },
  DRV_MESH_STIFFNESS_ASSUMED: {
    status: 'info',
    fix: 'Give `meshStiffnessNmPerRad` when the contact stiffness is known.',
    reason: 'exempt: a stated default of the backlash model, whose penetration is judged by the softness items',
  },
};

/** Coded warnings that have their own truth item (so the same finding is not listed twice), with where. */
export const RUN_WARNING_EXEMPT: Readonly<Record<string, string>> = {
  DRV_EFFORT_UNBOUNDED: 'DRV_EFFORT_UNBOUNDED item of effortItems (verdictItems.ts)',
};

const CODED = /^([A-Z]+_[A-Z0-9_]+):/;

/** The first single-quoted id of a warning text (`stepper 'm' lost ...`), or null. */
const idOf = (text: string): string | null => /'([^']+)'/.exec(text)?.[1] ?? null;

/** One item per coded warning code of the run (all its occurrences listed in the note), status from `RUN_WARNING_POLICY`, `warn` for a code not in it. */
export function warningItems(run: RunData): ReviewItem[] {
  const byCode = new Map<string, string[]>();
  for (const text of run.warnings) {
    const code = CODED.exec(text)?.[1];
    if (code !== undefined && RUN_WARNING_EXEMPT[code] === undefined) byCode.set(code, [...(byCode.get(code) ?? []), text]);
  }
  return [...byCode.entries()].map(([code, texts]) => {
    const policy = RUN_WARNING_POLICY[code];
    const ids = [...new Set(texts.flatMap((text) => idOf(text) ?? []))];
    return reviewItem(
      'dynamics',
      code,
      policy === undefined ? 'warn' : policy.status,
      ids,
      policy === undefined
        ? 'The run raised this warning and the truth check has no rule for it: read the note, fix the cause or accept the result as plausible only.'
        : policy.fix,
      {
        note: `${policy === undefined ? 'unmapped run warning (defaults to warn)' : policy.reason}: ${texts.join(' | ')}`,
        ...(policy?.status === 'info' ? {} : { unverified: true }),
      },
    );
  });
}
