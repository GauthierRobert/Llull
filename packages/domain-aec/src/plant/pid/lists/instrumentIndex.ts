/** `pid_report kind=instrument_index`: one row per instrument (plant 04 PID §5.7). */

import type { PidModel } from '../model';
import { itemsOf } from './counts';
import { endLabel, labelOf, sheetNumber, sortedRows, type Entry, type ListResult } from './lookup';

export const INSTRUMENT_INDEX_COLUMNS = [
  'tag',
  'category',
  'functions',
  'loop',
  'location',
  'display',
  'measuredLine',
  'controls',
  'sheet',
] as const;

/** Rows with the id of their instrument (the P&ID instrument provider of 08 DAT joins on it). `measuredLine` = where the measuring signal into the instrument taps (line number or nozzle); `controls` = the valves whose actuating system it controls. */
export function instrumentEntries(pid: PidModel, sheetId?: string): Entry[] {
  const measured = new Map<string, string>();
  const controls = new Map<string, string[]>();
  for (const id of pid.itemOrder) {
    const item = pid.items[id];
    if (item?.kind === 'signal' && item.signalKind === 'measuring' && item.to.type === 'instrument' && !measured.has(item.to.itemId))
      measured.set(item.to.itemId, endLabel(pid, item.from));
    else if (item?.kind === 'actuating' && item.controllerId !== undefined)
      controls.set(item.controllerId, [...(controls.get(item.controllerId) ?? []), labelOf(pid.items[item.valveId], item.valveId)]);
  }
  const entries: Entry[] = [];
  for (const item of itemsOf(pid, sheetId)) {
    if (item.kind !== 'instrument') continue;
    const loop = item.loopId === undefined ? undefined : pid.items[item.loopId];
    entries.push({
      id: item.id,
      row: {
        tag: labelOf(item),
        category: item.category,
        functions: item.functions,
        loop: loop?.tag ?? item.loopNumber,
        location: item.location,
        display: item.display,
        measuredLine: measured.get(item.id) ?? '',
        controls: (controls.get(item.id) ?? []).join(' '),
        sheet: sheetNumber(pid, item),
      },
    });
  }
  return entries;
}

export const instrumentIndex = (pid: PidModel, sheetId?: string): ListResult => ({
  columns: INSTRUMENT_INDEX_COLUMNS,
  rows: sortedRows(instrumentEntries(pid, sheetId), 'tag'),
});
