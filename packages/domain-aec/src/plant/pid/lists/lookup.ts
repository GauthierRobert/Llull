/** Shared lookups of the P&ID lists (plant 04 PID §5.7): labels, line of a port, attribute text, sorted rows. */

import type { PidEndpoint, PidItem, PidModel, PidSegment, PidValue } from '../model';
import { naturalCompare } from './sort';

export type Cell = string | number | boolean;
export type Row = Readonly<Record<string, Cell>>;

export interface ListResult {
  readonly columns: readonly string[];
  readonly rows: Row[];
}

/** A row with the id that breaks ties. */
export interface Entry {
  readonly id: string;
  readonly row: Row;
}

export const labelOf = (item: PidItem | undefined, fallback = ''): string => item?.tag ?? item?.sourceId ?? item?.id ?? fallback;

export function lineNumberOf(pid: PidModel, lineId: string): string {
  const line = pid.items[lineId];
  return line?.kind === 'line' ? (line.lineNumber ?? '') : '';
}

export const sheetNumber = (pid: PidModel, item: PidItem): string => pid.sheets[item.sheetId]?.number ?? '';

/** `equipmentTag/nozzleSubTag`, `OPC:<pairKey>`, `free`, `tee:<line number>` or the label of the item the end touches. */
export function endLabel(pid: PidModel, end: PidEndpoint): string {
  switch (end.type) {
    case 'free':
      return 'free';
    case 'branch': {
      const host = pid.items[end.segmentId];
      return host?.kind === 'segment' ? `tee:${lineNumberOf(pid, host.lineId) || host.lineId}` : `tee:${end.segmentId}`;
    }
    case 'nozzle': {
      const nozzle = pid.items[end.itemId];
      return nozzle?.kind === 'nozzle' ? `${labelOf(pid.items[nozzle.equipmentId], nozzle.equipmentId)}/${nozzle.subTag}` : end.itemId;
    }
    case 'opc': {
      const opc = pid.items[end.itemId];
      return opc?.kind === 'opc' ? `OPC:${opc.pairKey}` : end.itemId;
    }
    default:
      return labelOf(pid.items[end.itemId], end.itemId);
  }
}

export function valueText(value: PidValue | undefined): string {
  if (value === undefined) return '';
  return value.kind === 'quantity' ? `${value.value} ${value.unit}` : value.value;
}

/** First attribute of `names` the item carries, as text. */
export function attributeText(item: PidItem, names: readonly string[]): string {
  for (const name of names) if (Object.hasOwn(item.attributes, name)) return valueText(item.attributes[name]);
  return '';
}

/** Segments of the model by the inline item or nozzle they end at: first segment found per port owner (one pass over the items). */
export function segmentsByOwner(pid: PidModel): Map<string, PidSegment> {
  const owners = new Map<string, PidSegment>();
  for (const id of pid.itemOrder) {
    const item = pid.items[id];
    if (item?.kind !== 'segment') continue;
    for (const end of [item.from, item.to])
      if ((end.type === 'inline' || end.type === 'nozzle') && !owners.has(end.itemId)) owners.set(end.itemId, item);
  }
  return owners;
}

/** Rows ordered by the natural order of `columns` in turn, ties by id (AF-13). */
export function sortedRows(entries: readonly Entry[], ...columns: string[]): Row[] {
  const compare = (a: Entry, b: Entry): number => {
    for (const column of columns) {
      const order = naturalCompare(String(a.row[column] ?? ''), String(b.row[column] ?? ''));
      if (order !== 0) return order;
    }
    return naturalCompare(a.id, b.id);
  };
  return [...entries].sort(compare).map((entry) => entry.row);
}
