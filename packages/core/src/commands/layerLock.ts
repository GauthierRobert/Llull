/** Locked-layer enforcement for every caller of `execute` (FR-INT-08): a command may not add, change or remove an entity on a locked layer. */

import type { CadDocument } from '../model/types';
import type { CommandDefinition, CommandError, ExecutionContext } from './types';
import { derivedEntityIds } from '../plugins/host';
import { commandError } from './noop';

function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || depth > 24) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.every((byte, index) => byte === right[index]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && sameValue(left[key], right[key], depth + 1));
}

/** Entity ids that differ between two documents' entity bags: removed, added, or changed in value (reference inequality first). */
function changedEntityIds(previous: CadDocument, next: CadDocument): string[] {
  const ids: string[] = [];
  const before = previous.entities;
  const after = next.entities;
  const nextKeys = Object.keys(after);
  let kept = 0;
  for (const id of nextKeys) {
    const old = before[id];
    if (old === undefined) ids.push(id);
    else {
      kept += 1;
      if (old !== after[id] && !sameValue(old, after[id])) ids.push(id);
    }
  }
  const previousKeys = Object.keys(before);
  if (previousKeys.length > kept) for (const id of previousKeys) if (!Object.hasOwn(after, id)) ids.push(id);
  return ids;
}

export interface LayerLockViolation {
  readonly summary: string;
  readonly error: CommandError;
}

/**
 * @invariant a layer is locked when `locked` in the INPUT document; a new entity is placed by its layer in the result document
 * @invariant exempt: `annotations.layerManagement`, a history replay (`ctx.replaying`), and plugin-derived entities (re-derived from their definitions)
 */
export function layerLockViolation(
  def: CommandDefinition<unknown>,
  previous: CadDocument,
  next: CadDocument,
  ctx: ExecutionContext | undefined,
): LayerLockViolation | null {
  if (next === previous || def.annotations?.layerManagement === true || ctx?.replaying === true) return null;
  if (!Object.values(previous.layers).some((layer) => layer.locked)) return null;
  const changed = changedEntityIds(previous, next);
  if (changed.length === 0) return null;
  const blocked = changed.filter((id) => previous.layers[(previous.entities[id] ?? next.entities[id])?.layerId ?? '']?.locked === true);
  if (blocked.length === 0) return null;
  const derived = new Set([...derivedEntityIds(previous), ...derivedEntityIds(next)]);
  const ids = blocked.filter((id) => !derived.has(id));
  if (ids.length === 0) return null;
  const layerIds = [...new Set(ids.map((id) => (previous.entities[id] ?? next.entities[id])?.layerId ?? ''))];
  const names = layerIds.map((layerId) => `${layerId} ("${previous.layers[layerId]?.name ?? layerId}")`);
  const shown = ids.slice(0, 8).join(', ') + (ids.length > 8 ? `, … (${ids.length} entities)` : '');
  return {
    summary: `${def.name} rejected: it would change ${shown} on locked layer ${names.join(', ')}. Document unchanged.`,
    error: commandError(
      'LAYER_LOCKED',
      `Unlock layer ${layerIds.map((layerId) => previous.layers[layerId]?.name ?? layerId).join(', ')} with update_layer first.`,
      ids,
    ),
  };
}
