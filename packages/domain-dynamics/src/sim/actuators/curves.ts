/** Torque-speed limit curves of the machine kinds of PHY-23 DRV-M4, as plot series on the motor shaft (rpm, N·m): the PMSM envelope, the stepper pull-out, the induction torque-slip curve. */

import type { InductionMotor, PmsmMotor, StepperMotor } from '@core/model/drives';
import type { XySeries } from '../driveCharts';
import { inductionParameters, inductionPoint, synchronousSpeed } from './induction';
import { phaseVoltageLimit, pmsmEnvelope, pmsmParameters } from './pmsm';
import { pullOutTorque, stepperParameters } from './stepper';

const RPM_PER_RAD_PER_S = 60 / (2 * Math.PI);
const POINTS = 80;

const grid = (top: number): number[] => Array.from({ length: POINTS + 1 }, (_, k) => (top * k) / POINTS);

/** Maximum-torque envelope of a PMSM at its peak current and bus voltage, from standstill to the speed where the torque ends (4x the base speed when it never does). */
export function pmsmCurve(motor: PmsmMotor, id: string): XySeries {
  const p = pmsmParameters(motor);
  const limits = { currentA: motor.datasheet.peakCurrentA, busVoltageV: motor.datasheet.busVoltageV };
  const gap = p.fluxLinkageWb - p.inductanceH * limits.currentA;
  const vmax = phaseVoltageLimit(limits.busVoltageV);
  const top =
    gap > 0 ? vmax / (gap * p.polePairs) : (4 * vmax) / (p.polePairs * Math.hypot(p.fluxLinkageWb, p.inductanceH * limits.currentA));
  const speeds = grid(top);
  return {
    label: `${id} torque envelope (peak current, bus)`,
    xs: speeds.map((w) => w * RPM_PER_RAD_PER_S),
    ys: speeds.map((w) => pmsmEnvelope(p, limits, w).torqueNm),
    style: 'line',
  };
}

/** Pull-out torque of a stepper at its rated current, up to the end of its datasheet curve or the speed where the L/R roll-off reaches 5 %. */
export function stepperCurve(motor: StepperMotor, id: string): XySeries {
  const p = stepperParameters(motor);
  const last = p.pullOut === null ? undefined : p.pullOut[p.pullOut.length - 1];
  const top = last !== undefined ? last[0] : 20 / (p.rotorTeeth * p.timeConstantS);
  const speeds = grid(top);
  return {
    label: `${id} pull-out torque`,
    xs: speeds.map((w) => w * RPM_PER_RAD_PER_S),
    ys: speeds.map((w) => pullOutTorque(p, w)),
    style: 'line',
  };
}

/** Torque against speed of an induction motor at its rated voltage and frequency, from standstill to synchronous speed. */
export function inductionCurve(motor: InductionMotor, id: string): XySeries {
  const p = inductionParameters(motor);
  const sheet = motor.datasheet;
  const speeds = grid(synchronousSpeed(p, sheet.ratedFrequencyHz));
  return {
    label: `${id} torque at rated V, f`,
    xs: speeds.map((w) => w * RPM_PER_RAD_PER_S),
    ys: speeds.map((w) => inductionPoint(p, sheet.ratedVoltageV, sheet.ratedFrequencyHz, w).torqueNm),
    style: 'line',
  };
}
