/** Shared state of the DEXPI exporter: id book, warnings, element helpers (plant 04 PID §6.3). */

import type { Vec2 } from '@core/model/vectors';
import { dexpiIssue, type DexpiIssue } from '../dexpi/codes';
import type { PidEndpoint, PidItem, PidModel } from '../model';
import type { Chains } from './exportChains';
import { el, num, type XNode } from './xmlWrite';

export interface ExportContext {
  readonly pid: PidModel;
  /** Items of the exported sheets, in model order. */
  readonly items: readonly PidItem[];
  /** Item id -> the id written in the file (a segment's id is that of its chain head's chain, see `chainIds`). */
  readonly ids: ReadonlyMap<string, string>;
  /** Chain head segment id -> the id of the DEXPI segment. */
  readonly chainIds: ReadonlyMap<string, string>;
  readonly chains: Chains;
  readonly warnings: DexpiIssue[];
  /** Inline items an exported actuating system operates (the importer marks those operated itself). */
  readonly actuated: ReadonlySet<string>;
  /** Connection elements written (census key `connections`). */
  connections: number;
  claim: (wanted: string) => string;
}

const round = (value: number): number => Math.round(value * 1e12) / 1e12;

export const point = (tag: string, at: Vec2, extra: ReadonlyArray<readonly [string, string]> = []): XNode =>
  el(tag, [['X', num(at[0])], ['Y', num(at[1])], ['Z', '0'], ...extra]);

/** `<Position>` with the location and the reference axis turned by `rotationDeg` (the importer reads the angle back to 1e-9 degrees). */
export function position(at: Vec2, rotationDeg: number): XNode {
  const angle = (rotationDeg * Math.PI) / 180;
  return el(
    'Position',
    [],
    [
      point('Location', at),
      el('Axis', [
        ['X', '0'],
        ['Y', '0'],
        ['Z', '1'],
      ]),
      point('Reference', [round(Math.cos(angle)), round(Math.sin(angle))]),
    ],
  );
}

/** `<ConnectionPoints>`: the default node (no position) then one process node per port. */
export function connectionPoints(owner: string, ports: readonly Vec2[], claim: (wanted: string) => string): XNode {
  return el(
    'ConnectionPoints',
    [['NumPoints', String(ports.length + 1)]],
    [
      el('Node', [['ID', claim(`${owner}-DefaultNode`)]]),
      ...ports.map((port, index) =>
        el(
          'Node',
          [
            ['Type', 'process'],
            ['ID', claim(`${owner}-PipingNode-${index + 1}`)],
          ],
          [el('Position', [], [point('Location', port)])],
        ),
      ),
    ],
  );
}

export function centerLine(route: readonly Vec2[]): XNode {
  return el(
    'CenterLine',
    [['NumPoints', String(route.length)]],
    route.map((p) => point('Coordinate', p)),
  );
}

export function warn(ctx: ExportContext, code: string, message: string, ids: readonly string[] = []): void {
  ctx.warnings.push(dexpiIssue(code, 'warning', message, ids));
}

/** The class written for an item: `Custom` items go back under the class the source file gave. */
export const classWritten = (item: PidItem): string =>
  item.dexpiClass === 'Custom' ? (item.passthrough?.['dexpi:ComponentClass'] ?? 'Custom') : item.dexpiClass;

export const association = (type: string, itemId: string): XNode =>
  el('Association', [
    ['Type', type],
    ['ItemID', itemId],
  ]);

/** Common attributes of every object element. */
export const identity = (
  ctx: ExportContext,
  item: PidItem,
  extra: ReadonlyArray<readonly [string, string | undefined]> = [],
): Array<readonly [string, string | undefined]> => [
  ['ID', ctx.ids.get(item.id)],
  ['ComponentClass', classWritten(item)],
  ['ComponentClassURI', item.classUri],
  ...extra,
];

/** The file id (and node) an end stands for; a reference to something that is not exported is a free end plus a warning. */
export function endpointRef(ctx: ExportContext, end: PidEndpoint, owner: string): { id?: string; node?: string } {
  if (end.type === 'free') return {};
  let id: string | undefined;
  let node: string | undefined;
  if (end.type === 'branch')
    id = ctx.chains.chainOfSegment.has(end.segmentId)
      ? ctx.chainIds.get(ctx.chains.chainOfSegment.get(end.segmentId)?.head.id ?? '')
      : undefined;
  else {
    id = ctx.ids.get(end.itemId);
    node = end.type === 'nozzle' || end.type === 'opc' ? '1' : end.type === 'inline' ? String(end.node + 1) : undefined;
  }
  if (id === undefined) {
    warn(ctx, 'DEXPI_DANGLING_REFERENCE', `${owner} ends on an item that is not exported; the end was written as a free end`, [owner]);
    return {};
  }
  return node === undefined ? { id } : { id, node };
}
