// Pure helpers of the equipment port glyphs: parse the `equipment_ports` query answer, size and orient one arrow per nozzle flange face.
// The document is Z-up like the scene (no axis swap); the arrow shape points along +Y of its group, so the pose is the +Y -> direction rotation.

import type { Vec3 } from '@core/model/types';

export interface PortGlyph {
  readonly id: string;
  readonly position: Vec3;
  /** Unit vector pointing away from the equipment. */
  readonly direction: Vec3;
  readonly dn: number;
}

/** Quaternion as [x, y, z, w]. */
export type Quaternion4 = readonly [number, number, number, number];

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

/** Ports of an `equipment_ports` answer in `order`; malformed entries (no finite position / direction) are skipped. */
export function parsePortGlyphs(data: unknown): PortGlyph[] {
  if (typeof data !== 'object' || data === null) return [];
  const { ports, order } = data as { ports?: unknown; order?: unknown };
  if (typeof ports !== 'object' || ports === null || !Array.isArray(order)) return [];
  const table = ports as Record<string, Record<string, unknown> | undefined>;
  const glyphs: PortGlyph[] = [];
  for (const id of order) {
    if (typeof id !== 'string') continue;
    const port = table[id];
    if (port === undefined || !isVec3(port['position']) || !isVec3(port['direction'])) continue;
    const dn = port['dn'];
    glyphs.push({ id, position: port['position'], direction: port['direction'], dn: typeof dn === 'number' ? dn : 0 });
  }
  return glyphs;
}

const MIN_LENGTH_MM = 120;
const LENGTH_PER_DN = 1;

/** Arrow length in document units: proportional to the nozzle DN (mm), never below a legible minimum. */
export function glyphLength(dn: number, mmPerUnit: number): number {
  return Math.max(MIN_LENGTH_MM, dn * LENGTH_PER_DN) / mmPerUnit;
}

/** Shortest rotation taking +Y to the unit `direction`; the opposite direction turns about X. */
export function arrowQuaternion(direction: Vec3): Quaternion4 {
  const [dx, dy, dz] = direction;
  if (dy < -1 + 1e-9) return [1, 0, 0, 0];
  // cross(+Y, d) = (dz, 0, -dx); w = 1 + dot(+Y, d)
  const w = 1 + dy;
  const norm = Math.hypot(dz, dx, w);
  return [dz / norm, 0, -dx / norm, w / norm];
}
