/** `check_pid` connection rules: free ends, unconnected components / nozzles / vessels, invalid segment chains, unresolved off-page connectors (§5.5). */

import type { PidItem, PidNozzle, PidOffPage, PidSegment } from '../model';
import { sourceClass } from '../lists/counts';
import { flagged, inlineKey, nozzleKey, type CheckContext } from './context';
import { itemLabel, makeFinding, nozzleLabel, type Finding } from './finding';

/** Classes that end a line on purpose: one connected port is enough. */
const LINE_END_CLASSES = ['BlindFlange', 'Cap', 'Plug', 'Spectacle', 'Blind'];
/** Equipment that must reach a line (tanks and vessels). */
const VESSEL_CLASSES: ReadonlySet<string> = new Set(['Tank', 'PressureVessel', 'ProcessColumn']);

export const isLineEnd = (item: PidItem): boolean => LINE_END_CLASSES.some((name) => sourceClass(item).includes(name));

export function nonTerminating(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'segment' || (item.from.type !== 'free' && item.to.type !== 'free')) continue;
    if (flagged(item, 'endOfLine')) continue;
    const line = ctx.pid.items[item.lineId];
    const label = line?.kind === 'line' && line.lineNumber !== undefined ? line.lineNumber : itemLabel(item);
    const free = [item.from, item.to].filter((end) => end.type === 'free').length;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_LINE_NON_TERMINATING',
        ids: [item.id],
        item: label,
        message: `line ${label}: ${free === 2 ? 'both ends are' : 'one end is'} free and not marked as an end of line`,
        values: { freeEnds: free },
      }),
    );
  }
  return out;
}

export function componentUnconnected(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'inline') continue;
    const open = item.ports.flatMap((_, node) => (ctx.ends.has(inlineKey(item.id, node)) ? [] : [node]));
    if (open.length === 0 || (isLineEnd(item) && open.length < item.ports.length)) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_COMPONENT_UNCONNECTED',
        ids: [item.id],
        item: itemLabel(item),
        message: `${itemLabel(item)} (${item.dexpiClass}): port ${open.join(', ')} of ${item.ports.length} has no line`,
        values: { unconnectedPorts: open.length, ports: item.ports.length },
      }),
    );
  }
  return out;
}

const isReached = (ctx: CheckContext, nozzle: PidNozzle): boolean => ctx.ends.has(nozzleKey(nozzle.id)) || ctx.signalEnds.has(nozzle.id);

export function nozzleUnconnected(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'nozzle' || isReached(ctx, item)) continue;
    const label = nozzleLabel(ctx.pid, item);
    const passive = item.access === true || flagged(item, 'spare');
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: passive ? 'PID_NOZZLE_UNCONNECTED_ACCESS' : 'PID_NOZZLE_UNCONNECTED',
        ids: [item.id],
        item: label,
        message: `nozzle ${label}${item.dn === undefined ? '' : ` (DN ${item.dn})`} has no line${item.access === true ? ' (access nozzle)' : flagged(item, 'spare') ? ' (marked spare)' : ''}`,
        values: item.dn === undefined ? {} : { dn: item.dn },
      }),
    );
  }
  return out;
}

/** The equipment a nozzle belongs to at the top of its sub-equipment chain. */
function rootOf(ctx: CheckContext, id: string): string {
  let current = id;
  for (let depth = 0; depth < 64; depth++) {
    const item = ctx.pid.items[current];
    if (item?.kind !== 'equipment' || item.parentId === undefined) break;
    current = item.parentId;
  }
  return current;
}

export function equipmentUnconnected(ctx: CheckContext): Finding[] {
  const reached = new Set<string>();
  for (const id of ctx.pid.itemOrder) {
    const item = ctx.pid.items[id];
    if (item?.kind === 'nozzle' && isReached(ctx, item)) reached.add(rootOf(ctx, item.equipmentId));
  }
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'equipment' || item.parentId !== undefined || !VESSEL_CLASSES.has(sourceClass(item)) || reached.has(item.id))
      continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_EQUIPMENT_UNCONNECTED',
        ids: [item.id],
        item: itemLabel(item),
        message: `${itemLabel(item)} (${item.dexpiClass}) has no connected nozzle`,
      }),
    );
  }
  return out;
}

/** Pieces of a drawn segment in flow order (the order of `line.segmentIds`), keyed by line and `dexpi:segment`. */
function chains(ctx: CheckContext): Map<string, PidSegment[]> {
  const groups = new Map<string, PidSegment[]>();
  const inScope = new Set(ctx.scope.map((item) => item.id));
  for (const id of ctx.pid.itemOrder) {
    const line = ctx.pid.items[id];
    if (line?.kind !== 'line' || !inScope.has(line.id)) continue;
    for (const segmentId of line.segmentIds) {
      const segment = ctx.pid.items[segmentId];
      if (segment?.kind !== 'segment') continue;
      const key = `${line.id}|${segment.passthrough?.['dexpi:segment'] ?? segment.id}`;
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [segment]);
      else bucket.push(segment);
    }
  }
  return groups;
}

export function segmentInvalid(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const line = (segment: PidSegment): string => {
    const owner = ctx.pid.items[segment.lineId];
    return owner?.kind === 'line' && owner.lineNumber !== undefined ? owner.lineNumber : itemLabel(segment);
  };
  for (const pieces of chains(ctx).values()) {
    for (let i = 0; i + 1 < pieces.length; i++) {
      const a = pieces[i];
      const b = pieces[i + 1];
      if (a === undefined || b === undefined) continue;
      const broken = a.to.type !== 'inline' || b.from.type !== 'inline' || a.to.itemId !== b.from.itemId;
      if (broken)
        out.push(
          makeFinding({
            pid: ctx.pid,
            code: 'PID_SEGMENT_INVALID',
            ids: [a.id, b.id],
            item: line(a),
            message: `line ${line(a)}: the items of the segment do not form one chain (${a.id} ends and ${b.id} starts at different items)`,
            values: { reason: 'chain' },
          }),
        );
    }
  }
  const scopeIds = new Set(ctx.scope.map((item) => item.id));
  for (const [key, segments] of ctx.ends) {
    if (segments.length < 2) continue;
    const owner = key.split(':')[1] ?? '';
    if (!scopeIds.has(owner)) continue;
    // a port may be used by the two pieces of a chain only through different nodes; the same node twice is a double reference
    const ownerItem = ctx.pid.items[owner];
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_SEGMENT_INVALID',
        ids: [owner, ...segments.map((s) => s.id)],
        item: `${itemLabel(ownerItem, owner)}${key.startsWith('i:') ? `#${key.split(':')[2] ?? ''}` : ''}`,
        message: `${itemLabel(ownerItem, owner)} ${key.startsWith('i:') ? `node ${key.split(':')[2] ?? ''}` : ''} is referenced by ${segments.length} segment ends`,
        values: { references: segments.length, reason: 'node referenced twice' },
      }),
    );
  }
  return out;
}

export function opcUnresolved(ctx: CheckContext): Finding[] {
  const byPair = new Map<string, PidOffPage[]>();
  for (const id of ctx.pid.itemOrder) {
    const item = ctx.pid.items[id];
    if (item?.kind !== 'opc') continue;
    const bucket = byPair.get(item.pairKey);
    if (bucket === undefined) byPair.set(item.pairKey, [item]);
    else bucket.push(item);
  }
  const sheetByNumber = new Map(Object.values(ctx.pid.sheets).map((sheet) => [sheet.number, sheet.id]));
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'opc') continue;
    const wanted = item.targetSheet ?? undefined;
    const named = item.passthrough?.['pid:targetSheet'];
    const targetId = wanted ?? (named === undefined ? undefined : sheetByNumber.get(named));
    let why = '';
    if (wanted === undefined && named !== undefined && targetId === undefined) why = `the target sheet "${named}" does not exist`;
    else {
      const partner = (byPair.get(item.pairKey) ?? []).some(
        (other) =>
          other.id !== item.id &&
          other.sheetId !== item.sheetId &&
          other.direction !== item.direction &&
          (targetId === undefined || other.sheetId === targetId),
      );
      if (!partner)
        why = `no ${item.direction === 'in' ? 'outgoing' : 'incoming'} connector "${item.pairKey}" on ${targetId === undefined ? 'another sheet' : `sheet ${ctx.pid.sheets[targetId]?.number ?? targetId}`}`;
    }
    if (why === '') continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_OPC_UNRESOLVED',
        ids: [item.id],
        item: item.pairKey,
        message: `off-page connector ${item.pairKey} (${item.direction}) is unresolved: ${why}`,
        values: { pairKey: item.pairKey, direction: item.direction },
      }),
    );
  }
  return out;
}
