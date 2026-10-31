/** Fixtures of the 04 PID M3 authoring tests: step runner with `$alias`, the small tank -> pump -> valve P&ID of SC-PID-02. */

import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { PidItem, PidModel, PidSegment } from '@aec/plant/pid/model';
import { getPid } from '@aec/plant/pid/state';

/** Replaces strings `$name` (deep) by the first affected id bound to `name`. */
function resolve(value: unknown, bindings: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) return bindings.get(value.slice(1)) ?? value;
  if (Array.isArray(value)) return value.map((v) => resolve(v, bindings));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, resolve(v, bindings)]));
  return value;
}

export interface Step {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}

/** Runs steps in order like build_project (aliases bind `affected[0]`); a refused step is kept in `results` and leaves the document as it was. */
export function runSteps(
  steps: readonly Step[],
  start: CadDocument = createEmptyDocument(),
): { doc: CadDocument; results: CommandResult[] } {
  const bindings = new Map<string, string>();
  const results: CommandResult[] = [];
  let doc = start;
  for (const step of steps) {
    const result = execute(doc, step.command, resolve(step.params, bindings));
    results.push(result);
    doc = result.document;
    const first = result.affected[0];
    if (step.as !== undefined && first !== undefined) bindings.set(step.as, first);
  }
  return { doc, results };
}

export const items = (doc: CadDocument): PidItem[] => {
  const pid = getPid(doc);
  return pid.itemOrder.flatMap((id) => (pid.items[id] === undefined ? [] : [pid.items[id]]));
};

export const ofKind = <K extends PidItem['kind']>(doc: CadDocument, kind: K): Array<PidItem & { kind: K }> =>
  items(doc).filter((item): item is PidItem & { kind: K } => item.kind === kind);

export const byTag = (doc: CadDocument, tag: string): PidItem => {
  const found = items(doc).find((item) => item.tag === tag);
  if (found === undefined) throw new Error(`no item tagged ${tag}`);
  return found;
};

export const segmentsOfLine = (doc: CadDocument, lineNumber: string): PidSegment[] => {
  const pid: PidModel = getPid(doc);
  const line = ofKind(doc, 'line').find((l) => l.lineNumber === lineNumber);
  return (line?.segmentIds ?? []).map((id) => pid.items[id] as PidSegment);
};

/** Steps 0 to 5 of SC-PID-02 (sheet, tank, pump, suction line, discharge line to an off-page connector). */
export const FEED_PUMP: Step[] = [
  { command: 'create_pid_sheet', params: { number: 'PID-001', title: 'Feed pump', paper: 'A3', convention: 'ISA-5.1' }, as: 'sheet' },
  {
    command: 'add_pid_equipment',
    params: {
      sheet: '$sheet',
      class: 'Tank',
      tag: 'T-101',
      at: [60, 150],
      nozzles: [
        { subTag: 'N1', side: 'bottom', dn: 100 },
        { subTag: 'N2', side: 'top', dn: 50 },
      ],
    },
  },
  {
    command: 'add_pid_equipment',
    params: {
      sheet: '$sheet',
      class: 'CentrifugalPump',
      tag: 'P-101',
      at: [160, 80],
      nozzles: [
        { subTag: 'N1', side: 'left', dn: 100 },
        { subTag: 'N2', side: 'top', dn: 80 },
      ],
    },
  },
  {
    command: 'add_pid_line',
    params: {
      sheet: '$sheet',
      from: { tag: 'T-101', nozzle: 'N1' },
      to: { tag: 'P-101', nozzle: 'N1' },
      lineNumber: '100-P-1001-A1',
      dn: 100,
      pipingClass: 'A1',
      fluidCode: 'P',
    },
    as: 'suction',
  },
  {
    command: 'add_pid_line',
    params: {
      sheet: '$sheet',
      from: { tag: 'P-101', nozzle: 'N2' },
      to: { opc: 'OPC-1', targetSheet: 'PID-002' },
      via: [
        [160, 120],
        [300, 120],
      ],
      lineNumber: '80-P-1002-A1',
      dn: 80,
      pipingClass: 'A1',
      fluidCode: 'P',
    },
    as: 'discharge',
  },
];

/** Steps 6 to 11 of SC-PID-02: two valves on the discharge line, the flow transmitter and controller, the signal and the actuating system. */
export const FEED_PUMP_CONTROL: Step[] = [
  { command: 'add_pid_inline', params: { line: '$discharge', at: [200, 120], class: 'BallValve', tag: 'HV-102' } },
  { command: 'add_pid_inline', params: { line: '$discharge', at: [250, 120], class: 'GlobeValve', tag: 'FV-101' } },
  {
    command: 'add_pid_instrument',
    params: { sheet: '$sheet', tag: 'FT-101', at: [230, 140], location: 'field', measures: { line: '$discharge', at: [230, 120] } },
  },
  { command: 'add_pid_instrument', params: { sheet: '$sheet', tag: 'FIC-101', at: [230, 170], location: 'central', display: 'shared' } },
  { command: 'add_pid_signal_line', params: { from: 'FT-101', to: 'FIC-101', kind: 'electric' } },
  { command: 'add_pid_actuating_system', params: { valve: 'FV-101', actuator: 'diaphragm', failAction: 'FC', controller: 'FIC-101' } },
];

export const feedPump = (): CadDocument => runSteps(FEED_PUMP).doc;
export const feedPumpControlled = (): CadDocument => runSteps([...FEED_PUMP, ...FEED_PUMP_CONTROL]).doc;
