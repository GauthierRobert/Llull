/** Deleting P&ID items (plant 04 PID §4.1 delete_pid_item): the closure of what goes with an item, and the references that are repaired. */

import type { Vec2 } from '@core/model/vectors';
import type { Draft } from './refs';
import { healSegments } from './split';
import type { PidEndpoint, PidItem } from '../model';

const endRef = (end: PidEndpoint): string | undefined => (end.type === 'branch' ? end.segmentId : 'itemId' in end ? end.itemId : undefined);

/** Ids that go with `root`: owned nozzles, sub-equipment, the segments and inline items of a line. */
function owned(draft: Draft, root: PidItem): Set<string> {
  const gone = new Set<string>([root.id]);
  if (root.kind === 'line') {
    for (const id of root.segmentIds) {
      gone.add(id);
      const segment = draft.get(id);
      if (segment?.kind === 'segment')
        for (const end of [segment.from, segment.to]) if (end.type === 'inline' || end.type === 'opc') gone.add(end.itemId);
    }
  }
  if (root.kind === 'equipment') {
    for (let grew = true; grew; ) {
      grew = false;
      for (const id of draft.order) {
        const item = draft.get(id);
        const parent = item?.kind === 'nozzle' ? item.equipmentId : item?.kind === 'equipment' ? item.parentId : undefined;
        if (item !== undefined && parent !== undefined && gone.has(parent) && !gone.has(id)) {
          gone.add(id);
          grew = true;
        }
      }
    }
  }
  return gone;
}

/** Dependents of the removed ids: actuating systems of removed valves, signals with a removed end, loops left empty. */
function addDependents(draft: Draft, gone: Set<string>): void {
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of draft.order) {
      const item = draft.get(id);
      if (item === undefined || gone.has(id)) continue;
      const dependent =
        (item.kind === 'actuating' && gone.has(item.valveId)) ||
        (item.kind === 'signal' && [item.from, item.to].some((end) => gone.has(endRef(end) ?? '')));
      if (dependent) {
        gone.add(id);
        grew = true;
      }
    }
  }
  const members = new Map<string, number>();
  for (const id of draft.order) {
    const item = draft.get(id);
    if (item?.kind === 'instrument' && item.loopId !== undefined)
      members.set(item.loopId, (members.get(item.loopId) ?? 0) + (gone.has(id) ? 0 : 1));
  }
  for (const [loopId, remaining] of members) if (remaining === 0 && !gone.has(loopId)) gone.add(loopId);
}

/** The end as a free end at its route point (a reference to a removed item is replaced, never left dangling). */
const freed = (end: PidEndpoint, gone: ReadonlySet<string>, point: Vec2): PidEndpoint =>
  gone.has(endRef(end) ?? '') ? { type: 'free', at: end.type === 'branch' ? end.at : point } : end;

/** Removes `root` and what depends on it; segments keep their other end (a removed end becomes free), a segment left with two free ends it did not have goes too. */
export function removeItem(draft: Draft, root: PidItem, heal: boolean): { removed: string[]; healed: boolean } {
  let healed = false;
  const healedSegments: string[] = [];
  if (root.kind === 'inline' && heal) {
    const touching = draft.order.flatMap((id) => {
      const item = draft.get(id);
      return item?.kind === 'segment' && [item.from, item.to].some((end) => end.type === 'inline' && end.itemId === root.id) ? [item] : [];
    });
    const incoming = touching.filter((s) => s.to.type === 'inline' && s.to.itemId === root.id);
    const outgoing = touching.filter((s) => s.from.type === 'inline' && s.from.itemId === root.id);
    const [a, b] = [incoming[0], outgoing[0]];
    if (touching.length === 2 && a !== undefined && b !== undefined && a.id !== b.id && a.lineId === b.lineId) {
      healedSegments.push(healSegments(draft, a, b, root));
      healed = true;
    }
  }
  const gone = healed ? new Set<string>([root.id]) : owned(draft, root);
  addDependents(draft, gone);
  const repaired: PidItem[] = [];
  const removedSegments = new Set<string>();
  for (const id of draft.order) {
    const item = draft.get(id);
    if (item === undefined || gone.has(id)) continue;
    if (item.kind === 'segment') {
      const [first, last] = [item.route[0], item.route[item.route.length - 1]];
      const from = first === undefined ? item.from : freed(item.from, gone, first);
      const to = last === undefined ? item.to : freed(item.to, gone, last);
      if (from === item.from && to === item.to) continue;
      if (from !== item.from && to !== item.to) removedSegments.add(id);
      else repaired.push({ ...item, from, to });
    } else if (item.kind === 'actuating' && item.controllerId !== undefined && gone.has(item.controllerId)) {
      const { controllerId: _removed, ...rest } = item;
      repaired.push(rest);
    } else if (item.kind === 'instrument' && item.loopId !== undefined && gone.has(item.loopId)) {
      const { loopId: _removed, ...rest } = item;
      repaired.push(rest);
    }
  }
  for (const id of removedSegments) gone.add(id);
  repaired.forEach((item) => draft.put(item));
  for (const id of draft.order) {
    const item = draft.get(id);
    if (item?.kind === 'line' && !gone.has(id)) {
      const kept = item.segmentIds.filter((s) => !gone.has(s));
      if (kept.length === 0) gone.add(id);
      else if (kept.length !== item.segmentIds.length) draft.put({ ...item, segmentIds: kept });
    }
  }
  const removed = [...draft.order.filter((id) => gone.has(id)), ...healedSegments];
  draft.drop(gone);
  return { removed, healed };
}
