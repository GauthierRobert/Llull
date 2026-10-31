/** Moving items (plant 04 PID §4.1 update_pid_item): equipment takes its nozzles, and the end legs of the segments and signals attached to a moved port are re-routed. */

import type { Vec2 } from '@core/model/vectors';
import { moveRouteEnd } from './geometry';
import type { Draft } from './refs';
import type { PidEndpoint, PidEquipment } from '../model';

const movedItem = (end: PidEndpoint, moves: ReadonlyMap<string, Vec2>): Vec2 | undefined =>
  end.type === 'nozzle' || end.type === 'opc' || end.type === 'instrument' ? moves.get(end.itemId) : undefined;

/** Re-routes the end legs of every segment / signal whose end item is in `moves` (id -> new point). */
export function rerouteEnds(draft: Draft, moves: ReadonlyMap<string, Vec2>): void {
  if (moves.size === 0) return;
  for (const id of draft.order) {
    const item = draft.get(id);
    if (item?.kind !== 'segment' && item?.kind !== 'signal') continue;
    const start = movedItem(item.from, moves);
    const end = movedItem(item.to, moves);
    if (start === undefined && end === undefined) continue;
    let route = item.route;
    if (start !== undefined) route = moveRouteEnd(route, true, start);
    if (end !== undefined) route = moveRouteEnd(route, false, end);
    draft.put({ ...item, route, ...(item.kind === 'segment' ? { at: route[0] ?? item.at } : {}) });
  }
}

const rotate = (v: Vec2, degrees: number): Vec2 => {
  const a = (degrees * Math.PI) / 180;
  return [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
};

/** Moves / rotates an equipment: its nozzle ports follow (rotation about the old centre), sub-equipment is translated by the same offset. Returns the changed ids. */
export function moveEquipment(draft: Draft, equipment: PidEquipment, at: Vec2, rotationDeg: number): string[] {
  const delta: Vec2 = [at[0] - equipment.at[0], at[1] - equipment.at[1]];
  const turn = rotationDeg - equipment.rotationDeg;
  const changed = [equipment.id];
  const moves = new Map<string, Vec2>();
  draft.put({ ...equipment, at, rotationDeg });
  const translated = new Set<string>();
  const visit = (parent: PidEquipment, isRoot: boolean): void => {
    for (const id of [...draft.order]) {
      const item = draft.get(id);
      if (item?.kind === 'nozzle' && item.equipmentId === parent.id) {
        const offset = rotate([item.port[0] - parent.at[0], item.port[1] - parent.at[1]], isRoot ? turn : 0);
        const port: Vec2 = isRoot ? [at[0] + offset[0], at[1] + offset[1]] : [item.port[0] + delta[0], item.port[1] + delta[1]];
        draft.put({ ...item, port, at: port });
        moves.set(item.id, port);
        changed.push(item.id);
      } else if (item?.kind === 'equipment' && item.parentId === parent.id && !translated.has(id)) {
        translated.add(id);
        const child: PidEquipment = { ...item, at: [item.at[0] + delta[0], item.at[1] + delta[1]] };
        draft.put(child);
        changed.push(id);
        visit(item, false);
      }
    }
  };
  visit(equipment, true);
  rerouteEnds(draft, moves);
  return changed;
}
