/**
 * Instance arrays (`CadDocument.instanceArrays`, decision docs/decisions/VIS1-instance-array-storage.md): one prototype Component placed `count`
 * times from a packed transform table, with no Entity object per instance. Plain JSON data: the table is a base64 string.
 */

import type { Vec3 } from './vectors';

/** Floats per instance in the packed table: position x y z, then Euler XYZ rotation rx ry rz (as `BaseEntity.rotation`). */
export const INSTANCE_STRIDE = 6;

/** Per array. 4 x 10^6 instances = 192 MB decoded, 256 MB base64: far below V8's string limit. */
export const MAX_ARRAY_INSTANCES = 4_000_000;

export const INSTANCE_ARRAY_ENCODINGS = ['f64le-base64'] as const;

/**
 * @invariant `transforms` decodes to exactly `count x INSTANCE_STRIDE` finite float64 (little endian); `componentId` is in `doc.components`;
 *   `layerId` is in `doc.layers`; the record is never mutated (an edit replaces it)
 */
export interface InstanceArray {
  readonly id: string;
  readonly name: string;
  readonly componentId: string;
  readonly layerId: string;
  readonly color: string;
  readonly materialId?: string;
  /** Per-axis scale of every member (as `InstanceEntity.scale`). Default [1, 1, 1]. */
  readonly scale?: Vec3;
  readonly count: number;
  readonly encoding: (typeof INSTANCE_ARRAY_ENCODINGS)[number];
  readonly transforms: string;
}

/** Id of member `index` of array `arrayId` (what `planScene`, `render_stats` and picks show): `<arrayId>#<index>`. */
export const instanceMemberId = (arrayId: string, index: number): string => `${arrayId}#${index}`;

/** Inverse of `instanceMemberId`; null when `id` has no `<arrayId>#<index>` shape (load refuses an Entity id naming a member of one of the document's arrays). */
export function parseInstanceMemberId(id: string): { readonly arrayId: string; readonly index: number } | null {
  const at = id.lastIndexOf('#');
  if (at <= 0) return null;
  const digits = id.slice(at + 1);
  if (!/^(0|[1-9]\d{0,8})$/.test(digits)) return null;
  return { arrayId: id.slice(0, at), index: Number(digits) };
}
