/**
 * Datasheet consistency of a DC motor (PHY-23 TR-DRV-04): the redundant numbers of a motor sheet must agree with the ones derived from
 * R, kt and U. relative gap = (derived - given) / given; pass when |gap| <= 2 %. A check whose datasheet value is absent is `notGiven`.
 */

import type { DcMotorDatasheet } from '@core/model/drives';

export const DATA_TOLERANCE = 0.02;

const RPM_PER_RAD_PER_S = 60 / (2 * Math.PI);

interface DataCheck {
  readonly quantity: string;
  readonly derived: number;
  readonly datasheet: number | null;
  readonly relativeGap: number | null;
  readonly status: 'pass' | 'fail' | 'notGiven';
}

export interface MotorDataResult {
  readonly checks: readonly DataCheck[];
  /** Largest |relative gap| over the checks that could be made (0 when none). */
  readonly maxGap: number;
  readonly consistent: boolean;
  readonly notGiven: readonly string[];
}

/** The six checks of TR-DRV-04 on a datasheet. */
export function checkMotorData(sheet: DcMotorDatasheet): MotorDataResult {
  const { nominalVoltageV: u, terminalResistanceOhm: r, torqueConstantNmPerA: kt } = sheet;
  const stallCurrent = u / r;
  const stallTorque = kt * stallCurrent;
  const noLoadCurrent = sheet.noLoadCurrentA === undefined ? 0 : sheet.noLoadCurrentA;
  const noLoadSpeed = ((u - r * noLoadCurrent) / kt) * RPM_PER_RAD_PER_S;
  const entries: readonly (readonly [string, number, number | undefined])[] = [
    ['stallCurrentA', stallCurrent, sheet.stallCurrentA],
    ['stallTorqueNm', stallTorque, sheet.stallTorqueNm],
    [
      'keFromSpeedConstantVsPerRad',
      sheet.speedConstantRpmPerV === undefined ? 0 : 1 / (sheet.speedConstantRpmPerV / RPM_PER_RAD_PER_S),
      sheet.speedConstantRpmPerV === undefined ? undefined : kt,
    ],
    ['noLoadSpeedRpm', noLoadSpeed, sheet.noLoadSpeedRpm],
    ['mechanicalTimeConstantS', (sheet.rotorInertiaKgM2 * r) / (kt * kt), sheet.mechanicalTimeConstantS],
    ['speedTorqueGradientRpmPerMNm', noLoadSpeed / (stallTorque * 1000), sheet.speedTorqueGradientRpmPerMNm],
  ];
  const checks: DataCheck[] = entries.map(([quantity, derived, given]) => {
    if (given === undefined) return { quantity, derived, datasheet: null, relativeGap: null, status: 'notGiven' };
    const gap = (derived - given) / given;
    return { quantity, derived, datasheet: given, relativeGap: gap, status: Math.abs(gap) <= DATA_TOLERANCE ? 'pass' : 'fail' };
  });
  const gaps = checks.flatMap((check) => (check.relativeGap === null ? [] : [Math.abs(check.relativeGap)]));
  return {
    checks,
    maxGap: Math.max(0, ...gaps),
    consistent: checks.every((check) => check.status !== 'fail'),
    notGiven: checks.filter((check) => check.status === 'notGiven').map((check) => check.quantity),
  };
}
