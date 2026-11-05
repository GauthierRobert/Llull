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

/** Ids of the locked layers of `layers` (empty when none). */
function lockedLayerIds(layers: CadDocument['layers']): Set<string> {
  const locked = new Set<string>();
  for (const id in layers) if (Object.hasOwn(layers, id) && layers[id]?.locked === true) locked.add(id);
  return locked;
}

/** Key count of entity bags already scanned: the next call's `previous` is usually the last call's result, so its count is not re-derived. */
const entityCounts = new WeakMap<object, number>();

/**
 * Entity ids added, removed or changed in value whose old or new layer is in `locked`. Reference equality first, layers next, and only
 * then a deep comparison (only for entities that touch a locked layer), so an edit elsewhere in a large document stays cheap.
 */
function changedOnLockedLayers(previous: CadDocument, next: CadDocument, locked: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  const before = previous.entities;
  const after = next.entities;
  let kept = 0;
  const afterIds = Object.keys(after);
  for (let index = 0; index < afterIds.length; index += 1) {
    const id = afterIds[index] as string;
    const entity = after[id];
    const old = before[id];
    if (entity === undefined) continue;
    if (old === undefined) {
      if (locked.has(entity.layerId)) ids.push(id);
      continue;
    }
    kept += 1;
    if (old !== entity && (locked.has(old.layerId) || locked.has(entity.layerId)) && !sameValue(old, entity)) ids.push(id);
  }
  entityCounts.set(after, afterIds.length);
  const previousCount = entityCounts.get(before) ?? Object.keys(before).length;
  if (previousCount > kept)
    for (const id of Object.keys(before)) if (!Object.hasOwn(after, id) && locked.has(before[id]?.layerId ?? '')) ids.push(id);
  return ids;
}

export interface LayerLockViolation {
  readonly summary: string;
  readonly error: CommandError;
}

/**
 * @invariant a layer is locked when `locked` in the INPUT document; an entity is refused when its OLD or its NEW layer is locked (added, removed, edited, or moved onto / off a locked layer)
 * @invariant exempt: `annotations.layerManagement`, a history replay (`ctx.replaying`), and plugin-derived entities (re-derived from their definitions)
 * @invariant plugin-derived geometry is exempt on purpose: the lock binds user-authored entities, so editing a domain object (a wall, an equipment item)
 *   whose derived mesh sits on a locked layer is allowed and re-derives that mesh
 * @invariant a nested execute (`ctx.lockJudgedByCaller`) is not judged on its own provisional result: the enclosing command's guard judges its final
 *   result (user-authored entities on a locked layer are refused, derived ones are not); a top-level call and the steps of an exempt command
 *   (build_project) are judged individually
 */
export function layerLockViolation(
  def: CommandDefinition<unknown>,
  previous: CadDocument,
  next: CadDocument,
  ctx: ExecutionContext | undefined,
): LayerLockViolation | null {
  if (next === previous || next.entities === previous.entities) return null;
  if (def.annotations?.layerManagement === true || ctx?.replaying === true || ctx?.lockJudgedByCaller === true) return null;
  const locked = lockedLayerIds(previous.layers);
  if (locked.size === 0) return null;
  const blocked = changedOnLockedLayers(previous, next, locked);
  if (blocked.length === 0) return null;
  const derived = new Set([...derivedEntityIds(previous), ...derivedEntityIds(next)]);
  const ids = blocked.filter((id) => !derived.has(id));
  if (ids.length === 0) return null;
  const lockedLayerOf = (id: string): string => {
    const old = previous.entities[id]?.layerId ?? '';
    return locked.has(old) ? old : (next.entities[id]?.layerId ?? '');
  };
  const layerIds = [...new Set(ids.map(lockedLayerOf))];
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
