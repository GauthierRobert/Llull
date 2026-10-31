/** `check_pid` driver: builds the context once, runs the requested rules, hides accepted findings, sorts (§5.5). Every rule is one pass over the items. */

import type { PidModel } from '../model';
import { buildContext, type CheckContext } from './context';
import { compareFindings, PID_RULES, type Finding, type PidRule } from './finding';
import {
  componentUnconnected,
  equipmentUnconnected,
  nonTerminating,
  nozzleUnconnected,
  opcUnresolved,
  segmentInvalid,
} from './ruleConnection';
import { flowConflict, sizeMismatch, specMismatch } from './ruleConsistency';
import {
  controlValveNoActuator,
  instrumentUnconnected,
  lineNumberMissing,
  safetyValveNoSetPressure,
  tagDuplicate,
  tagNonstandard,
} from './ruleDevices';

/** The rule functions; the two nozzle codes come from one pass. */
const RUNNERS: ReadonlyArray<{ readonly codes: readonly PidRule[]; readonly run: (ctx: CheckContext, sheetId?: string) => Finding[] }> = [
  { codes: ['PID_LINE_NON_TERMINATING'], run: nonTerminating },
  { codes: ['PID_COMPONENT_UNCONNECTED'], run: componentUnconnected },
  { codes: ['PID_NOZZLE_UNCONNECTED', 'PID_NOZZLE_UNCONNECTED_ACCESS'], run: nozzleUnconnected },
  { codes: ['PID_EQUIPMENT_UNCONNECTED'], run: equipmentUnconnected },
  { codes: ['PID_SIZE_MISMATCH'], run: sizeMismatch },
  { codes: ['PID_SPEC_MISMATCH'], run: specMismatch },
  { codes: ['PID_FLOW_DIRECTION_CONFLICT'], run: flowConflict },
  { codes: ['PID_OPC_UNRESOLVED'], run: opcUnresolved },
  { codes: ['PID_TAG_DUPLICATE'], run: tagDuplicate },
  { codes: ['PID_SEGMENT_INVALID'], run: segmentInvalid },
  { codes: ['PID_CONTROL_VALVE_NO_ACTUATOR'], run: controlValveNoActuator },
  { codes: ['PID_SAFETY_VALVE_NO_SET_PRESSURE'], run: safetyValveNoSetPressure },
  { codes: ['PID_LINE_NUMBER_MISSING'], run: lineNumberMissing },
  { codes: ['PID_INSTRUMENT_UNCONNECTED'], run: instrumentUnconnected },
  { codes: ['PID_TAG_NONSTANDARD'], run: tagNonstandard },
];

export interface CheckRun {
  readonly findings: Finding[];
  readonly rulesRun: PidRule[];
  readonly accepted: number;
}

export function runChecks(
  pid: PidModel,
  options: { sheetId?: string | undefined; rules?: readonly PidRule[] | undefined; includeAccepted: boolean },
): CheckRun {
  const wanted = new Set<PidRule>(options.rules ?? PID_RULES);
  const ctx = buildContext(pid, options.sheetId);
  const found: Finding[] = [];
  for (const runner of RUNNERS)
    if (runner.codes.some((code) => wanted.has(code))) found.push(...runner.run(ctx, options.sheetId).filter((f) => wanted.has(f.code)));
  const acceptances = pid.acceptances ?? {};
  const visible = options.includeAccepted ? found : found.filter((f) => !Object.hasOwn(acceptances, f.findingKey));
  return {
    findings: visible.sort(compareFindings),
    rulesRun: PID_RULES.filter((code) => wanted.has(code)),
    accepted: found.length - visible.length,
  };
}
