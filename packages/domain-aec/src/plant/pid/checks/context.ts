/** What every rule of `check_pid` reads, built once per run: the items in scope and the index of what touches each port (O(n), plant 04 PID §5.2). */

import type { PidInline, PidItem, PidModel, PidSegment } from '../model';
import { itemsOf, sourceClass } from '../lists/counts';

export interface CheckContext {
  readonly pid: PidModel;
  /** Items of the checked sheet (all items without a sheet filter), in model order. */
  readonly scope: readonly PidItem[];
  /** Segment ends by port: `n:<nozzle>`, `i:<inline>:<node>`, `o:<opc>`. */
  readonly ends: ReadonlyMap<string, PidSegment[]>;
  /** Signal ends by item id (nozzle, instrument, actuating system). */
  readonly signalEnds: ReadonlyMap<string, number>;
}

export const nozzleKey = (id: string): string => `n:${id}`;
export const inlineKey = (id: string, node: number): string => `i:${id}:${node}`;
export const opcKey = (id: string): string => `o:${id}`;

export function endKey(end: PidSegment['from']): string | undefined {
  switch (end.type) {
    case 'nozzle':
      return nozzleKey(end.itemId);
    case 'inline':
      return inlineKey(end.itemId, end.node);
    case 'opc':
      return opcKey(end.itemId);
    default:
      return undefined;
  }
}

export function buildContext(pid: PidModel, sheetId?: string): CheckContext {
  const ends = new Map<string, PidSegment[]>();
  const signalEnds = new Map<string, number>();
  for (const id of pid.itemOrder) {
    const item = pid.items[id];
    if (item?.kind === 'segment') {
      for (const end of [item.from, item.to]) {
        const key = endKey(end);
        if (key === undefined) continue;
        const bucket = ends.get(key);
        if (bucket === undefined) ends.set(key, [item]);
        else bucket.push(item);
      }
    } else if (item?.kind === 'signal') {
      for (const end of [item.from, item.to])
        if (end.type === 'nozzle' || end.type === 'instrument') signalEnds.set(end.itemId, (signalEnds.get(end.itemId) ?? 0) + 1);
    }
  }
  return { pid, scope: itemsOf(pid, sheetId), ends, signalEnds };
}

/** An attribute that is set: a text / enum other than empty, false, no, none, 0 (`spare`, `specBreak`, `endOfLine`). */
export function flagged(item: PidItem, name: string): boolean {
  const value = Object.hasOwn(item.attributes, name) ? item.attributes[name] : undefined;
  if (value === undefined) return false;
  if (value.kind === 'quantity') return value.value !== 0;
  return !['', 'false', 'no', 'none', '0'].includes(value.value.trim().toLowerCase());
}

/** The segments that carry flow into (`in`) or out of (`out`) the port at the end of `segment` that touches `key`; none for flow `none`. */
export function directionAt(segment: PidSegment, key: string): 'in' | 'out' | undefined {
  if (segment.flow === 'none') return undefined;
  const atFrom = endKey(segment.from) === key;
  const atTo = endKey(segment.to) === key;
  if (atFrom === atTo) return undefined;
  const forward = segment.flow === 'forward';
  return atFrom === forward ? 'out' : 'in';
}

export const inlineClass = (item: PidInline): string => sourceClass(item);
