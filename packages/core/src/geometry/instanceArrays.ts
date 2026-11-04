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
function memberPlacement(table: Float64Array, index: number): { readonly position: Vec3; readonly rotation: Vec3 } {
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

/**
 * Calls `visit(index, bounds)` with the world AABB of every member, in table order, in one pass (the corner set of the component is computed once).
 * Allocation: the two result vectors per member only. Trigonometry is memoized across runs of members that share a rotation (a grid shares one).
 * @invariant bit-identical to `instanceBoundsFromDoc` of the member (same operations in the same order as `instanceToWorld` / `applyEulerXYZ`)
 */
export function eachMemberBounds(
  doc: CadDocument,
  array: InstanceArray,
  table: Float64Array,
  visit: (index: number, bounds: Bounds) => void,
): void {
  const corners = instanceLocalCorners(doc, array.componentId);
  const [sx, sy, sz] = array.scale ?? [1, 1, 1];
  let rx = NaN;
  let ry = NaN;
  let rz = NaN;
  let [cx, snx, cy, sny, cz, snz] = [1, 0, 1, 0, 1, 0];
  for (let index = 0; index < array.count; index++) {
    const at = index * INSTANCE_STRIDE;
    const [px, py, pz, ax, ay, az] = [
      table[at] ?? 0,
      table[at + 1] ?? 0,
      table[at + 2] ?? 0,
      table[at + 3] ?? 0,
      table[at + 4] ?? 0,
      table[at + 5] ?? 0,
    ];
    if (corners.length === 0) {
      visit(index, { min: [px, py, pz], max: [px, py, pz] });
      continue;
    }
    const rotated = ax !== 0 || ay !== 0 || az !== 0;
    if (rotated && !(Object.is(ax, rx) && Object.is(ay, ry) && Object.is(az, rz))) {
      [rx, ry, rz] = [ax, ay, az];
      [cx, snx, cy, sny, cz, snz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
    }
    let [minX, minY, minZ, maxX, maxY, maxZ] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const corner of corners) {
      const [x0, y0, z0] = [corner[0] * sx, corner[1] * sy, corner[2] * sz];
      let [x, y, z] = [x0, y0, z0];
      if (rotated) {
        const x1 = cz * x0 - snz * y0;
        const y1 = snz * x0 + cz * y0;
        const x2 = cy * x1 + sny * z0;
        const z2 = -sny * x1 + cy * z0;
        [x, y, z] = [x2 + 0, cx * y1 - snx * z2 + 0, snx * y1 + cx * z2 + 0];
      }
      [x, y, z] = [x + px, y + py, z + pz];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    visit(index, { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
  }
}
