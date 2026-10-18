/**
 * Structural sharing for adopted snapshots: a freshly parsed document has all-new objects, which would defeat every
 * identity-keyed memo (meshes, BVH, instance batches, live-fx diff). Equal content keeps the previous reference.
 */

import type { CadDocument } from '@core/model/types';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Object.is(a, b);
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.every((byte, index) => byte === right[index]);
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) return false;
  if (arrayA && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  if (keysA.length !== Object.keys(recordB).length) return false;
  return keysA.every((key) => key in recordB && deepEqual(recordA[key], recordB[key]));
}

/** `next` with every sub-tree that equals `previous`'s replaced by `previous`'s reference (entities per entity). */
function reuseRecord<T>(previous: Record<string, T>, next: Record<string, T>): Record<string, T> {
  const nextKeys = Object.keys(next);
  let allSame = nextKeys.length === Object.keys(previous).length;
  const merged: Record<string, T> = {};
  for (const key of nextKeys) {
    const before = previous[key];
    const after = next[key] as T;
    const kept = before !== undefined && deepEqual(before, after) ? before : after;
    if (kept !== before) allSame = false;
    merged[key] = kept;
  }
  return allSame ? previous : merged;
}

export function reuseUnchanged(previous: CadDocument, next: CadDocument): CadDocument {
  const result: Record<string, unknown> = { ...next };
  const before = previous as unknown as Record<string, unknown>;
  for (const key of Object.keys(next) as Array<keyof CadDocument>) {
    const prevValue = before[key];
    const nextValue = next[key];
    if (prevValue === undefined || prevValue === nextValue) continue;
    if (key === 'entities') result[key] = reuseRecord(previous.entities, next.entities);
    else if (deepEqual(prevValue, nextValue)) result[key] = prevValue;
  }
  return result as unknown as CadDocument;
}
