/** `pid_report kind=valve_list`: one row per valve, a piping component whose class contains "Valve" (plant 04 PID §5.7). */

import type { PidActuating, PidModel } from '../model';
import { itemsOf, sourceClass } from './counts';
import { labelOf, lineNumberOf, segmentsByOwner, sheetNumber, sortedRows, type Entry, type ListResult } from './lookup';

export const VALVE_LIST_COLUMNS = ['tag', 'class', 'lineNumber', 'dn', 'pipingClass', 'actuated', 'failAction', 'sheet'] as const;

export function valveList(pid: PidModel, sheetId?: string): ListResult {
  const actuating = new Map<string, PidActuating>();
  for (const id of pid.itemOrder) {
    const item = pid.items[id];
    if (item?.kind === 'actuating') actuating.set(item.valveId, item);
  }
  const owners = segmentsByOwner(pid);
  const entries: Entry[] = [];
  for (const item of itemsOf(pid, sheetId)) {
    if (item.kind !== 'inline' || !sourceClass(item).includes('Valve')) continue;
    const segment = owners.get(item.id);
    const actuator = actuating.get(item.id);
    entries.push({
      id: item.id,
      row: {
        tag: labelOf(item),
        class: sourceClass(item),
        lineNumber: segment === undefined ? '' : lineNumberOf(pid, segment.lineId),
        dn: item.dn ?? segment?.dn ?? '',
        pipingClass: item.pipingClass ?? segment?.pipingClass ?? '',
        actuated: actuator !== undefined,
        failAction: actuator?.failAction ?? '',
        sheet: sheetNumber(pid, item),
      },
    });
  }
  return { columns: VALVE_LIST_COLUMNS, rows: sortedRows(entries, 'tag') };
}
