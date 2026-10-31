/**
 * `pid_report kind=connectivity`: the connection graph as rows (plant 04 PID §5.2, §5.7). One row per DEXPI segment (the pieces llull split it into are
 * folded back through `dexpi:segment`: from = start of the first piece, to = end of the last) and one per information flow, in model order.
 */

import type { PidEndpoint, PidItem, PidModel, PidSegment } from '../model';
import { itemsOf, sourceClass } from './counts';

export const CONNECTIVITY_COLUMNS = ['from', 'fromType', 'to', 'toType', 'via', 'lineNumber'] as const;

export interface ConnectivityRow {
  readonly from: string;
  readonly fromType: string;
  readonly to: string;
  readonly toType: string;
  readonly via: 'segment' | 'information_flow';
  readonly lineNumber: string;
}

export interface ConnectivitySummary {
  readonly processConnections: number;
  readonly informationConnections: number;
  readonly nozzlesTotal: number;
  readonly nozzlesConnected: number;
  /** `<equipment tag>/<sub tag>` of the nozzles no connection reaches. */
  readonly nozzlesUnconnected: string[];
  /** `FromID <Element>:<class>` / `ToID ...` -> count, `open` for a free end (the census histogram). */
  readonly endpointTypes: Record<string, number>;
}

const label = (item: PidItem | undefined, fallback: string): string => item?.tag ?? item?.sourceId ?? item?.id ?? fallback;

function endpointLabel(pid: PidModel, end: PidEndpoint): string {
  switch (end.type) {
    case 'free':
      return 'free';
    case 'branch':
      return `branch:${end.segmentId}`;
    case 'nozzle': {
      const nozzle = pid.items[end.itemId];
      if (nozzle?.kind !== 'nozzle') return end.itemId;
      return `${label(pid.items[nozzle.equipmentId], nozzle.equipmentId)}/${nozzle.subTag}`;
    }
    case 'opc': {
      const opc = pid.items[end.itemId];
      return opc?.kind === 'opc' ? `OPC:${opc.pairKey}` : end.itemId;
    }
    default:
      return label(pid.items[end.itemId], end.itemId);
  }
}

/** `<DEXPI element>:<class>` of an end, or `open`. */
function endpointType(pid: PidModel, end: PidEndpoint): string {
  if (end.type === 'free') return 'open';
  if (end.type === 'branch') return 'branch';
  const item = pid.items[end.itemId];
  switch (item?.kind) {
    case 'nozzle':
      return `Nozzle:${sourceClass(item)}`;
    case 'inline':
      return `PipingComponent:${sourceClass(item)}`;
    case 'opc':
      return `PipeOffPageConnector:${sourceClass(item)}`;
    case 'instrument':
      return `ProcessInstrumentationFunction:${sourceClass(item)}`;
    case 'actuating':
      return 'ActuatingSystemComponent:ControlledActuator';
    default:
      return 'unknown';
  }
}

export function connectivity(pid: PidModel, sheetId?: string): { rows: ConnectivityRow[]; summary: ConnectivitySummary } {
  const items = itemsOf(pid, sheetId);
  const groups = new Map<string, PidSegment[]>();
  for (const item of items)
    if (item.kind === 'segment') {
      const key = `${item.lineId}|${item.passthrough?.['dexpi:segment'] ?? item.id}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
  // Pieces of a drawn segment are folded in flow order: the order of the line's segmentIds (inline insertion appends new pieces to itemOrder).
  const rank = (segment: PidSegment): number => {
    const line = pid.items[segment.lineId];
    return line?.kind === 'line' ? line.segmentIds.indexOf(segment.id) : 0;
  };
  for (const group of groups.values()) group.sort((a, b) => rank(a) - rank(b));
  const row = (from: PidEndpoint, to: PidEndpoint, via: ConnectivityRow['via'], lineNumber: string): ConnectivityRow => ({
    from: endpointLabel(pid, from),
    fromType: endpointType(pid, from),
    to: endpointLabel(pid, to),
    toType: endpointType(pid, to),
    via,
    lineNumber,
  });
  const ends: PidEndpoint[] = [];
  const rows: ConnectivityRow[] = [];
  let process = 0;
  for (const item of items) {
    if (item.kind === 'segment') {
      const group = groups.get(`${item.lineId}|${item.passthrough?.['dexpi:segment'] ?? item.id}`);
      if (group?.[0]?.id !== item.id) continue;
      const first = item;
      const last = group[group.length - 1] ?? item;
      const line = pid.items[item.lineId];
      rows.push(row(first.from, last.to, 'segment', line?.kind === 'line' ? (line.lineNumber ?? '') : ''));
      ends.push(first.from, last.to);
      process++;
    } else if (item.kind === 'signal') {
      rows.push(row(item.from, item.to, 'information_flow', ''));
      ends.push(item.from, item.to);
    }
  }
  const reached = new Set(ends.flatMap((end) => (end.type === 'nozzle' ? [end.itemId] : [])));
  const nozzles = items.flatMap((item) => (item.kind === 'nozzle' ? [item] : []));
  const endpointTypes: Record<string, number> = {};
  const count = (key: string): void => {
    endpointTypes[key] = (endpointTypes[key] ?? 0) + 1;
  };
  rows.forEach((r) => {
    count(`FromID ${r.fromType}`);
    count(`ToID ${r.toType}`);
  });
  return {
    rows,
    summary: {
      processConnections: process,
      informationConnections: rows.length - process,
      nozzlesTotal: nozzles.length,
      nozzlesConnected: nozzles.filter((n) => reached.has(n.id)).length,
      nozzlesUnconnected: nozzles.filter((n) => !reached.has(n.id)).map((n) => endpointLabel(pid, { type: 'nozzle', itemId: n.id })),
      endpointTypes: Object.fromEntries(Object.entries(endpointTypes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    },
  };
}
