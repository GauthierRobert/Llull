/** A `check_pid` finding, its stable key and the rule table (plant 04 PID §5.5). */

import type { PidItem, PidModel } from '../model';
import { naturalCompare } from '../lists/sort';

export type Severity = 'error' | 'warning' | 'info';

export const PID_RULES = [
  'PID_LINE_NON_TERMINATING',
  'PID_COMPONENT_UNCONNECTED',
  'PID_NOZZLE_UNCONNECTED',
  'PID_NOZZLE_UNCONNECTED_ACCESS',
  'PID_EQUIPMENT_UNCONNECTED',
  'PID_SIZE_MISMATCH',
  'PID_SPEC_MISMATCH',
  'PID_FLOW_DIRECTION_CONFLICT',
  'PID_OPC_UNRESOLVED',
  'PID_TAG_DUPLICATE',
  'PID_SEGMENT_INVALID',
  'PID_CONTROL_VALVE_NO_ACTUATOR',
  'PID_SAFETY_VALVE_NO_SET_PRESSURE',
  'PID_LINE_NUMBER_MISSING',
  'PID_INSTRUMENT_UNCONNECTED',
  'PID_TAG_NONSTANDARD',
] as const;
export type PidRule = (typeof PID_RULES)[number];

export const RULE_SEVERITY: Readonly<Record<PidRule, Severity>> = {
  PID_LINE_NON_TERMINATING: 'error',
  PID_COMPONENT_UNCONNECTED: 'error',
  PID_NOZZLE_UNCONNECTED: 'warning',
  PID_NOZZLE_UNCONNECTED_ACCESS: 'info',
  PID_EQUIPMENT_UNCONNECTED: 'error',
  PID_SIZE_MISMATCH: 'error',
  PID_SPEC_MISMATCH: 'error',
  PID_FLOW_DIRECTION_CONFLICT: 'error',
  PID_OPC_UNRESOLVED: 'error',
  PID_TAG_DUPLICATE: 'error',
  PID_SEGMENT_INVALID: 'error',
  PID_CONTROL_VALVE_NO_ACTUATOR: 'warning',
  PID_SAFETY_VALVE_NO_SET_PRESSURE: 'warning',
  PID_LINE_NUMBER_MISSING: 'warning',
  PID_INSTRUMENT_UNCONNECTED: 'warning',
  PID_TAG_NONSTANDARD: 'info',
};

export const RULE_REMEDIATION: Readonly<Record<PidRule, string>> = {
  PID_LINE_NON_TERMINATING:
    'Connect the free end (add_pid_line to a nozzle, add_pid_off_page_connector) or mark it as an end of line: update_pid_item on the segment with set.attributes.endOfLine="vent" (or drain, blind, sample).',
  PID_COMPONENT_UNCONNECTED:
    'Draw the missing line to the component port (add_pid_line from the component) or delete the component (delete_pid_item).',
  PID_NOZZLE_UNCONNECTED:
    'Connect the nozzle with add_pid_line, or mark it spare: update_pid_item on the nozzle with set.attributes.spare="true".',
  PID_NOZZLE_UNCONNECTED_ACCESS: 'Nothing to fix for a manhole or an access nozzle; a spare nozzle is intended to stay free.',
  PID_EQUIPMENT_UNCONNECTED: 'Connect at least one nozzle of the vessel with add_pid_line, or delete the equipment (delete_pid_item).',
  PID_SIZE_MISMATCH:
    'Set the component dn to the line size (update_pid_item set.dn), or insert a reducer (add_pid_inline class PipeReducer) next to it.',
  PID_SPEC_MISMATCH:
    'Set the component pipingClass to the line class (update_pid_item set.pipingClass), or mark a spec break (set.attributes.specBreak="true" on the item).',
  PID_FLOW_DIRECTION_CONFLICT: 'Flip one of the segments with reverse_pid_flow, or turn the check valve so it passes with the flow.',
  PID_OPC_UNRESOLVED:
    'Create the partner off-page connector (same pairKey, opposite direction) on the target sheet, or correct the pairKey / target sheet.',
  PID_TAG_DUPLICATE: 'Give one of the items a new tag with update_pid_item set.tag; the tag is unique in the document.',
  PID_SEGMENT_INVALID:
    'Re-import or redraw the segment: its items must form one chain from source to target and every port is used by one segment end.',
  PID_CONTROL_VALVE_NO_ACTUATOR:
    'Add an actuating system on the valve (add_pid_actuating_system, with a controller instrument), or clear the operated flag.',
  PID_SAFETY_VALVE_NO_SET_PRESSURE:
    'Set the set pressure: update_pid_item on the valve with set.attributes.SetPressureHigh={"value":..,"unit":"bar"}; a pressure-protection device needs human review.',
  PID_LINE_NUMBER_MISSING: 'Set the line number: update_pid_item on the line with set.lineNumber, or renumber_pid_lines.',
  PID_INSTRUMENT_UNCONNECTED:
    'Draw its measuring or signal line (add_pid_signal_line, or add_pid_instrument measures), or put another instrument in its loop.',
  PID_TAG_NONSTANDARD: 'Keep the tag, or rename it with ISA 5.1 letters (parse_instrument_tag explains the letters).',
};

export interface Finding {
  readonly code: PidRule;
  /** Check status of the finding: fail for an error, warn for a warning, info. */
  readonly status: 'fail' | 'warn' | 'info';
  readonly severity: Severity;
  readonly ids: readonly string[];
  readonly tags: readonly string[];
  /** Sheet number of the first item. */
  readonly sheet: string;
  /** Short human label (`T4750/N3`, a tag, a line number). */
  readonly item: string;
  readonly message: string;
  readonly findingKey: string;
  readonly remediation: string;
  readonly values: Readonly<Record<string, string | number | boolean>>;
  readonly reviewRequired?: true;
}

/** `pid:<code>:<sorted ids>`: stable across runs (AF-13). */
export const pidFindingKey = (code: string, ids: readonly string[]): string => `pid:${code}:${[...ids].sort().join(',')}`;

const STATUS: Readonly<Record<Severity, Finding['status']>> = { error: 'fail', warning: 'warn', info: 'info' };

/** Item label: tag, else the id in the source file, else the id. */
export const itemLabel = (item: PidItem | undefined, fallback = ''): string => item?.tag ?? item?.sourceId ?? item?.id ?? fallback;

/** Label of a nozzle: `<equipment tag>/<sub tag>`. */
export function nozzleLabel(pid: PidModel, nozzle: PidItem): string {
  if (nozzle.kind !== 'nozzle') return itemLabel(nozzle);
  return `${itemLabel(pid.items[nozzle.equipmentId], nozzle.equipmentId)}/${nozzle.subTag}`;
}

export interface FindingInit {
  readonly pid: PidModel;
  readonly code: PidRule;
  readonly ids: readonly string[];
  readonly item: string;
  readonly message: string;
  readonly values?: Readonly<Record<string, string | number | boolean>>;
  readonly severity?: Severity;
  readonly reviewRequired?: boolean;
}

export function makeFinding(init: FindingInit): Finding {
  const severity = init.severity ?? RULE_SEVERITY[init.code];
  const sorted = [...init.ids].sort();
  const items = sorted.flatMap((id) => {
    const found = Object.hasOwn(init.pid.items, id) ? init.pid.items[id] : undefined;
    return found === undefined ? [] : [found];
  });
  const first = items[0];
  return {
    code: init.code,
    status: STATUS[severity],
    severity,
    ids: sorted,
    tags: items.flatMap((i) => (i.tag === undefined ? [] : [i.tag])),
    sheet: init.pid.sheets[first?.sheetId ?? '']?.number ?? '',
    item: init.item,
    message: init.message,
    findingKey: pidFindingKey(init.code, sorted),
    remediation: RULE_REMEDIATION[init.code],
    values: init.values ?? {},
    ...(init.reviewRequired === true ? { reviewRequired: true as const } : {}),
  };
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then infos; inside a severity the rule order, then the natural label, then the key. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    PID_RULES.indexOf(a.code) - PID_RULES.indexOf(b.code) ||
    naturalCompare(a.item, b.item) ||
    (a.findingKey < b.findingKey ? -1 : a.findingKey > b.findingKey ? 1 : 0)
  );
}
