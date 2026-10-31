/** Tag registry of the P&ID (plant 04 PID §13.3 decision 5): normalised tag -> item ids, derived from `items` on demand (never stored); plugin-local until 08 DAT's registry port exists. */

import type { PidItem, PidModel } from '../model';
import { TAGGED_KINDS, normaliseTag } from '../authoring/refs';

/** Items of the kinds whose tag is unique (equipment, inline components, instruments, actuating systems), keyed by normalised tag, in model order. One pass. */
export function buildTagRegistry(pid: PidModel, sheetId?: string): Map<string, PidItem[]> {
  const registry = new Map<string, PidItem[]>();
  for (const id of pid.itemOrder) {
    const item = pid.items[id];
    if (item === undefined || item.tag === undefined || !TAGGED_KINDS.has(item.kind)) continue;
    if (sheetId !== undefined && item.sheetId !== sheetId) continue;
    const key = normaliseTag(item.tag);
    const bucket = registry.get(key);
    if (bucket === undefined) registry.set(key, [item]);
    else bucket.push(item);
  }
  return registry;
}
