/**
 * Reading instance arrays (VIS1): the decoded transform table (memoized per record) and member placement / bounds without an Entity per member.
 * @invariant a member equals the `InstanceEntity` with its transform: same world AABB (`instanceBoundsFromDoc`), same prototype key
 */

import type { InstanceArray } from '../model/instanceArray';
import { INSTANCE_STRIDE, MAX_ARRAY_INSTANCES, instanceMemberId } from '../model/instanceArray';
import type { CadDocument, InstanceEntity, Vec3 } from '../model/types';
import { base64ToFloat64 } from '../lib/float64Base64';
import type { Bounds } from './bounds';
import { instanceLocalCorners } from './bounds';
import { instanceToWorld } from './instanceTransform';

const decoded = new WeakMap<InstanceArray, Float64Array>();

/**
 * The `count x INSTANCE_STRIDE` table of `array`, decoded once per record object (documents share records, so undo and replay do not decode again).
 * Null when the record is not decodable: count out of range, wrong encoding, text that is not base64 of the right length, or a non-finite value.
 */
export function decodedTransforms(array: InstanceArray): Float64Array | null {
  const known = decoded.get(array);
  if (known !== undefined) return known;
  const { count } = array;
  if (!Number.isInteger(count) || count < 1 || count > MAX_ARRAY_INSTANCES || array.encoding !== 'f64le-base64') return null;
  if (typeof array.transforms !== 'string') return null;
  const table = base64ToFloat64(array.transforms, count * INSTANCE_STRIDE);
  if (table === null) return null;
  for (let i = 0; i < table.length; i++) if (!Number.isFinite(table[i])) return null;
  decoded.set(array, table);
  return table;
}

/** Placement of member `index` of a decoded table. */
export function memberPlacement(table: Float64Array, index: number): { readonly position: Vec3; readonly rotation: Vec3 } {
  const at = index * INSTANCE_STRIDE;
  return {
    position: [table[at] ?? 0, table[at + 1] ?? 0, table[at + 2] ?? 0],
    rotation: [table[at + 3] ?? 0, table[at + 4] ?? 0, table[at + 5] ?? 0],
  };
}

/** Member `index` as the `InstanceEntity` it stands for (not stored: tests, picking details, detaching). Null when out of range. */
export function memberAsInstance(array: InstanceArray, index: number): InstanceEntity | null {
  const table = decodedTransforms(array);
  if (table === null || !Number.isInteger(index) || index < 0 || index >= array.count) return null;
  const { position, rotation } = memberPlacement(table, index);
  return {
    id: instanceMemberId(array.id, index),
    kind: 'instance',
    componentId: array.componentId,
    position,
    rotation,
    layerId: array.layerId,
    color: array.color,
    ...(array.materialId !== undefined ? { materialId: array.materialId } : {}),
    ...(array.scale !== undefined ? { scale: array.scale } : {}),
  };
}

/** World AABB of every member, one pass over the table (the corner set of the component is computed once). */
export function* memberBounds(doc: CadDocument, array: InstanceArray, table: Float64Array): Generator<Bounds> {
  const corners = instanceLocalCorners(doc, array.componentId);
  const scale = array.scale ?? [1, 1, 1];
  for (let index = 0; index < array.count; index++) {
    const { position, rotation } = memberPlacement(table, index);
    if (corners.length === 0) {
      yield { min: position, max: position };
      continue;
    }
    const toWorld = instanceToWorld(scale, rotation, position);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const corner of corners) {
      const point = toWorld(corner);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis] ?? Infinity, point[axis] ?? 0);
        max[axis] = Math.max(max[axis] ?? -Infinity, point[axis] ?? 0);
      }
    }
    yield { min, max };
  }
}
