/** check_motor_data: are the redundant numbers of a DC motor datasheet consistent with each other? */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { codedRejection, failer, report } from '@core/commands/noop';
import type { DcMotorDatasheet } from '@core/model/drives';
import { DATA_TOLERANCE, checkMotorData, type MotorDataResult } from '../sim/actuators/motorData';
import { dynamicsOf } from './bodies';
import { datasheetSchema, toDatasheet } from './motorSchemas';

/** One entry per check, for summaries. */
function checksText(result: MotorDataResult): string {
  return result.checks
    .map((check) =>
      check.relativeGap === null
        ? `${check.quantity}: not given`
        : `${check.quantity}: derived ${check.derived.toPrecision(5)} vs sheet ${check.datasheet} (${(check.relativeGap * 100).toFixed(2)} %, ${check.status})`,
    )
    .join('; ');
}

/** The refusal of an inconsistent sheet, listing every failing check. */
export function inconsistentSheet(doc: CadDocument, command: string, result: MotorDataResult): CommandResult {
  const failing = result.checks.filter((check) => check.status === 'fail');
  return codedRejection(
    doc,
    command,
    'DRV_MOTOR_DATA_INCONSISTENT',
    `the datasheet disagrees with itself by more than ${DATA_TOLERANCE * 100} %: ${failing.map((c) => `${c.quantity} ${((c.relativeGap ?? 0) * 100).toFixed(2)} %`).join(', ')}`,
    'Re-read the sheet (units: kt in N*m/A, J in kg*m^2, speeds in rpm), or pass acceptInconsistent with a reason: the motor is then unverified.',
    [],
    [],
    { checks: result.checks, maxGap: result.maxGap },
  );
}

/**
 * @affects nothing — read-only; returns { checks, maxGap, consistent, notGiven } in data
 * @invariant input document deep-equal before and after; no FeatureStep; a check without a datasheet value is notGiven, never failed
 * @failure unknown motor, a motor that is not a datasheet DC motor, neither or both of `motor` / `datasheet` -> no-op with the reason
 */
export const checkMotorDataCommand = defineCommand({
  name: 'check_motor_data',
  annotations: { readOnly: true },
  description:
    'Check that the numbers of a DC motor datasheet agree with each other (catalogue sheets are redundant, and a unit slip or a mistyped constant shows up ' +
    'here before it spoils a simulation). Six checks, each a relative gap (derived - sheet) / sheet, pass when within 2 %: stall current U/R; stall torque ' +
    'kt*U/R; the back-EMF constant 1/(speed constant) against kt; the no-load speed (U - R*I0)/kt; the mechanical time constant J*R/kt^2; the speed/torque ' +
    'gradient (no-load speed / stall torque). A check whose sheet value is absent is listed in notGiven, not failed. Give `motor` (a stored dc motor, ' +
    'add_motor) or an inline `datasheet`. Returns data.checks[] { quantity, derived, datasheet, relativeGap, status }, data.maxGap, data.consistent. Read-only.',
  params: z.object({
    motor: z.string().optional().describe('Id of a stored datasheet motor (add_motor kind "dc").'),
    datasheet: datasheetSchema.optional().describe('An inline datasheet to check without storing it.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'check_motor_data');
    if ((params.motor === undefined) === (params.datasheet === undefined)) return fail('give exactly one of `motor` and `datasheet`');
    let sheet: DcMotorDatasheet;
    let label = 'inline datasheet';
    if (params.motor !== undefined) {
      const motor = dynamicsOf(doc).motors[params.motor];
      if (motor === undefined) return fail(`motor '${params.motor}' not found (add_motor first)`);
      if (motor.kind !== 'dc') return fail(`motor '${params.motor}' is a ${motor.kind} motor without a datasheet`);
      sheet = motor.datasheet;
      label = `motor '${motor.id}'`;
    } else if (params.datasheet !== undefined) sheet = toDatasheet(params.datasheet);
    else return fail('no datasheet');
    const result = checkMotorData(sheet);
    const made = result.checks.length - result.notGiven.length;
    return report(
      doc,
      `check_motor_data: ${label}: ${made} check(s) made, largest gap ${(result.maxGap * 100).toFixed(2)} %, ${result.consistent ? 'consistent' : 'DRV_MOTOR_DATA_INCONSISTENT'}` +
        `${result.notGiven.length > 0 ? `; not given: ${result.notGiven.join(', ')}` : ''}. ${checksText(result)}.`,
      result,
    );
  },
});
