/**
 * The energy-ledger items of check_motion_truth (PHY-23 TR-DRV-23 (a)): closure against the 1e-3 / 1e-2 gates, the named cause of a servo jump start
 * (DRV-M2 leftover, spec 13.15 item 5) and the order in which the closure error of a run with stops or backlash shrinks with the step.
 */

import type { CheckThreshold } from '@core/model/checkResult';
import type { DynamicsModel } from '@core/model/dynamics';
import { type ReviewItem, reviewItem } from '@core/model/reviewEnvelope';
import { RAD_PER_S_PER_RPM } from '../forceLaws';
import type { RunData } from '../runData';
import type { StudyRow } from './studyItems';

const PASS_GATE = 1e-3;
const WARN_GATE = 1e-2;
/** A velocity servo has jump-started when its joint is within this fraction of the speed step from the target at the first recorded sample. */
const JUMP_REACHED = 0.2;
/** A closure error is attributed to a servo jump start when it is within this factor (either way) of the jump's kinetic energy. */
const JUMP_MATCH = 4;

const threshold: CheckThreshold = {
  value: PASS_GATE,
  unit: 'closure error / largest term',
  source: 'TR-DRV-23 (a): pass <= 1e-3, warn <= 1e-2',
  grade: 'C',
  defaulted: true,
};

/**
 * Kinetic energy (J) a velocity servo puts into its joint by jumping it from the initial speed to its target: 1/2 J |v_target^2 - v_0^2|, per motor that
 * really jumped: its joint is already within 20 % of the speed step from the target at the first recorded sample (a servo that saturates and ramps is not one).
 */
function jumpEnergies(
  dynamics: DynamicsModel,
  inertiaOf: (joint: string) => number | undefined,
  run: RunData,
): { readonly motor: string; readonly joules: number }[] {
  return Object.values(dynamics.motors).flatMap((motor) => {
    if (motor.kind !== 'speed' && motor.kind !== 'linear_speed') return [];
    const target = motor.kind === 'speed' ? motor.rpm * RAD_PER_S_PER_RPM : motor.speedMps;
    const start = dynamics.joints[motor.joint]?.initialVelocity;
    const inertia = inertiaOf(motor.joint);
    const first = run.series?.jointVelocity[motor.joint]?.[1];
    const jumped = first !== undefined && start !== undefined && Math.abs(first - target) <= JUMP_REACHED * Math.abs(target - start);
    return start === undefined || inertia === undefined || !jumped
      ? []
      : [{ motor: motor.id, joules: 0.5 * inertia * Math.abs(target * target - start * start) }];
  });
}

/**
 * DRV_LEDGER_CLOSURE (the ledger of a run with actuators or measured heat, else the plain energy balance) and, when it does not pass and a velocity servo
 * jump-starts a mass, DRV_LEDGER_SERVO_JUMP naming the cause.
 * @invariant a closure that is not pass is never explained away: the cause item is an addition, the closure item keeps its status
 */
export function ledgerItems(run: RunData, dynamics: DynamicsModel, inertiaOf: (joint: string) => number | undefined): ReviewItem[] {
  const ledger = run.ledger;
  const relative = ledger === undefined ? run.energy?.balanceErrorFraction : ledger.closureRelative;
  if (relative === undefined)
    return [
      reviewItem(
        'dynamics',
        'DRV_LEDGER_CLOSURE',
        'not_run',
        [],
        'Run with energy recording (a datasheet motor with a drive, or energy: true) so the books can be checked.',
        { unverified: true, note: 'the run recorded neither a ledger nor an energy balance' },
      ),
    ];
  const closes = relative <= PASS_GATE ? 'pass' : relative <= WARN_GATE ? 'warn' : 'fail';
  // a run whose only datasheet motors are steppers: their electrical input is derived from copper + field work, so a closing ledger is no independent evidence
  const drives = Object.values(run.drives ?? {});
  const byConstruction = closes === 'pass' && drives.length > 0 && drives.every((drive) => drive.stepper !== undefined);
  const status: ReviewItem['status'] = byConstruction ? 'info' : closes;
  const basis = ledger === undefined ? 'energy balance (no actuator ledger)' : 'energy ledger';
  const construction = byConstruction
    ? ' (closes by construction for a stepper, not independent evidence: the field energy is not tracked)'
    : '';
  const closure = reviewItem(
    'dynamics',
    'DRV_LEDGER_CLOSURE',
    status,
    [],
    status === 'pass' || status === 'info'
      ? 'None.'
      : 'Energy does not close: refine the timestep, or see the named cause below; do not size from a ledger that does not close.',
    {
      values: {
        closureRelative: relative,
        ...(ledger === undefined
          ? {}
          : {
              closureErrorJ: ledger.closureErrorJ,
              inputJ: ledger.inputJ,
              dissipatedJ: ledger.dissipatedJ,
              storedChangeJ: ledger.storedChangeJ,
            }),
      },
      threshold,
      note: `${basis}: closure ${relative.toExponential(2)} of the largest term${construction}`,
      ...(status === 'pass' || status === 'info' ? {} : { unverified: true }),
    },
  );
  if (closes === 'pass' || ledger === undefined) return [closure];
  const jumps = jumpEnergies(dynamics, inertiaOf, run);
  const jump = jumps.reduce((sum, entry) => sum + entry.joules, 0);
  const error = Math.abs(ledger.closureErrorJ);
  if (!(jump > 0) || error < jump / JUMP_MATCH || error > jump * JUMP_MATCH) return [closure];
  return [
    closure,
    reviewItem(
      'dynamics',
      'DRV_LEDGER_SERVO_JUMP',
      'warn',
      jumps.map((entry) => entry.motor),
      'Start the servo at its target speed (initialVelocity on the joint) or drive it with a velocity profile that ramps: a jump from rest puts an impulse into the work estimate that one step cannot resolve.',
      {
        values: { closureErrorJ: error, jumpKineticJ: jump },
        note: `the closure error ${error.toPrecision(3)} J is consistent with a servo jump start: it is of the order of the kinetic energy ${jump.toPrecision(3)} J that velocity servo(s) ${jumps.map((entry) => `'${entry.motor}'`).join(', ')} give the joint in its first steps (the joint was at the target speed by the first sample): the servo work of a jump start is estimated from the force at the start and end of the step and misses the impulse (first-order servo work estimate, spec 13.15 item 5)`,
        unverified: true,
      },
    ),
  ];
}

/**
 * DRV_LEDGER_ORDER (info): for a run with end stops or backlash, the observed order of the closure error in the step. The heat of a stop is the trapezoid of its
 * row forces, first order in dt (13.15 item 5): the item states the order measured, a warn only when the error does not shrink.
 */
export function ledgerOrderItems(run: RunData, rows: readonly StudyRow[]): ReviewItem[] {
  const row = rows.find((entry) => entry.key === 'ledger.closureErrorJ');
  if (row === undefined || run.stops === undefined || Object.keys(run.stops).length === 0 || row.status === 'not_run') return [];
  const shrinks = row.order !== null && row.order >= 0.5;
  // a closure error that sits at a step-independent floor under the gates (or at round-off) is not a discretisation effect: stated, not flagged
  const atRoundOff = row.order === null && row.status === 'pass';
  return [
    reviewItem(
      'dynamics',
      'DRV_LEDGER_ORDER',
      shrinks || atRoundOff ? 'info' : 'warn',
      Object.keys(run.stops),
      shrinks || atRoundOff
        ? 'None.'
        : 'The closure error does not shrink with the step: the stop or backlash is not resolved; refine the step or stiffen / soften the stop.',
      {
        values: row.order === null ? {} : { observedOrder: row.order },
        note: atRoundOff
          ? `closure error at a step-independent floor: ${row.note}`
          : `closure error order ${row.order === null ? 'not observed' : row.order.toPrecision(3)} in the step: the heat of a stop / backlash is first order in dt (trapezoid of the row forces), so halving dt about halves the closure error`,
      },
    ),
  ];
}
