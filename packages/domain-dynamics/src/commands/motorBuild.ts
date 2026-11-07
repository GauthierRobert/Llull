/** add_motor for the datasheet kinds (dc, pmsm, stepper, induction): the motor record from the parameters, after the consistency checks of its kind. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { failer } from '@core/commands/noop';
import type { z } from '@core/commands/schema';
import type { DatasheetMotor, Gearhead, ParameterSource } from '@core/model/drives';
import { checkDatasheet } from '../sim/actuators/motorData';
import { drivetrainOfMotor, peakJointTorque } from '../sim/actuators/machine';
import {
  toInductionSheet,
  toPmsmSheet,
  toStepperSheet,
  type inductionSheetSchema,
  type pmsmSheetSchema,
  type stepperSheetSchema,
} from './machineSchemas';
import { inconsistentSheet } from './motorData';
import { toDatasheet, toGearhead, toSource, type datasheetSchema } from './motorSchemas';

/** The datasheet part of add_motor's parameters. */
export interface DatasheetParams {
  readonly kind: DatasheetMotor['kind'];
  readonly datasheet?: z.infer<typeof datasheetSchema> | undefined;
  readonly pmsmDatasheet?: z.infer<typeof pmsmSheetSchema> | undefined;
  readonly stepperDatasheet?: z.infer<typeof stepperSheetSchema> | undefined;
  readonly inductionDatasheet?: z.infer<typeof inductionSheetSchema> | undefined;
  readonly gearhead?: Parameters<typeof toGearhead>[0] | undefined;
  readonly source?: Parameters<typeof toSource>[0] | undefined;
  readonly acceptInconsistent?: string | undefined;
}

const SHEET_FIELD = { dc: 'datasheet', pmsm: 'pmsmDatasheet', stepper: 'stepperDatasheet', induction: 'inductionDatasheet' } as const;

/** The datasheet-side fields of add_motor, named as the caller wrote them. */
const DATASHEET_SIDE = ['datasheet', 'pmsmDatasheet', 'stepperDatasheet', 'inductionDatasheet', 'gearhead', 'acceptInconsistent'] as const;

/** The first datasheet-side field of `params` that motor kind `kind` does not use (a sheet of another kind, any sheet / gearhead on torque_curve / speed), or null. */
export function foreignField(kind: string, params: Partial<Record<(typeof DATASHEET_SIDE)[number], unknown>>): string | null {
  const own = (SHEET_FIELD as Record<string, string | undefined>)[kind];
  const shared = own === undefined ? [] : ['gearhead', 'acceptInconsistent'];
  return DATASHEET_SIDE.find((field) => params[field] !== undefined && field !== own && !shared.includes(field)) ?? null;
}

/** The motor of `params` with its consistency verdict text, or the refusal (missing sheet / source, an inconsistent sheet, a malformed pull-out curve). */
export function buildDatasheetMotor(
  doc: CadDocument,
  params: DatasheetParams,
  id: string,
  joint: string,
): { readonly motor: DatasheetMotor; readonly verdict: string } | CommandResult {
  const fail = failer(doc, 'add_motor');
  if (params.source === undefined) return fail(`${params.kind} motor needs \`${SHEET_FIELD[params.kind]}\` and \`source\``);
  const common: { gearhead?: Gearhead; source: ParameterSource; acceptInconsistent?: string } = {
    ...(params.gearhead === undefined ? {} : { gearhead: toGearhead(params.gearhead) }),
    source: toSource(params.source),
    ...(params.acceptInconsistent === undefined ? {} : { acceptInconsistent: params.acceptInconsistent }),
  };
  let motor: DatasheetMotor;
  if (params.kind === 'dc') {
    if (params.datasheet === undefined) return fail(`dc motor needs \`datasheet\` and \`source\``);
    motor = { id, kind: 'dc', joint, datasheet: toDatasheet(params.datasheet), ...common };
  } else if (params.kind === 'pmsm') {
    const sheet = params.pmsmDatasheet;
    if (sheet === undefined) return fail('pmsm motor needs `pmsmDatasheet` and `source`');
    if (sheet.fluxLinkageWb === undefined && sheet.torqueConstantNmPerA === undefined)
      return fail('pmsmDatasheet needs fluxLinkageWb or torqueConstantNmPerA');
    motor = { id, kind: 'pmsm', joint, datasheet: toPmsmSheet(sheet), ...common };
  } else if (params.kind === 'stepper') {
    const sheet = params.stepperDatasheet;
    if (sheet === undefined) return fail('stepper motor needs `stepperDatasheet` and `source`');
    if (sheet.pullOutCurve?.some((point, k) => k > 0 && point[0] <= (sheet.pullOutCurve?.[k - 1]?.[0] ?? Infinity)))
      return fail('pullOutCurve rpm values must strictly increase');
    motor = { id, kind: 'stepper', joint, datasheet: toStepperSheet(sheet), ...common };
  } else {
    const sheet = params.inductionDatasheet;
    if (sheet === undefined) return fail('induction motor needs `inductionDatasheet` and `source`');
    motor = { id, kind: 'induction', joint, datasheet: toInductionSheet(sheet), ...common };
  }
  const checks = checkDatasheet(motor);
  if (!checks.consistent && params.acceptInconsistent === undefined) return inconsistentSheet(doc, 'add_motor', checks);
  const made = checks.checks.length - checks.notGiven.length;
  const verdict = checks.consistent
    ? `datasheet consistent (${made} checks, largest gap ${(checks.maxGap * 100).toFixed(2)} %)`
    : `datasheet INCONSISTENT (accepted: ${params.acceptInconsistent}), results unverified`;
  return { motor, verdict };
}

/** One-line electrical summary of a datasheet motor. */
export function datasheetDescription(motor: DatasheetMotor): string {
  const train = drivetrainOfMotor(motor);
  const gear = `gear ${train.gearRatio}:1 (η ${train.efficiencyForward}), armature ${train.armatureKgM2.toExponential(3)} kg·m²`;
  switch (motor.kind) {
    case 'dc':
      return `R ${motor.datasheet.terminalResistanceOhm} Ω, kt ${motor.datasheet.torqueConstantNmPerA} N·m/A, ${gear}, stall ${(motor.datasheet.nominalVoltageV / motor.datasheet.terminalResistanceOhm).toFixed(2)} A`;
    case 'pmsm':
      return `${motor.datasheet.polePairs} pole pairs, R ${motor.datasheet.phaseResistanceOhm} Ω, L ${motor.datasheet.inductanceH} H, peak ${peakJointTorque(motor).toPrecision(4)} N·m at the joint (≤ ${motor.datasheet.peakCurrentA} A, ${motor.datasheet.busVoltageV} V bus), ${gear}`;
    case 'stepper':
      return `${motor.datasheet.stepsPerRev} steps/rev, holding ${motor.datasheet.holdingTorqueNm} N·m, ${motor.datasheet.ratedCurrentA} A/phase, ${motor.datasheet.pullOutCurve === undefined ? 'L/R pull-out roll-off' : `pull-out curve of ${motor.datasheet.pullOutCurve.length} points`}, ${gear}`;
    case 'induction':
      return `${motor.datasheet.polePairs} pole pairs, ${motor.datasheet.ratedVoltageV} V / ${motor.datasheet.ratedFrequencyHz} Hz per phase, breakdown ${peakJointTorque(motor).toPrecision(4)} N·m at the joint, ${gear}`;
  }
}
