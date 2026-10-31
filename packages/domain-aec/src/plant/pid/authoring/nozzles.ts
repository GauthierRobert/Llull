/** Nozzles: side -> port on the equipment symbol, and the nozzle item (plant 04 PID §4.1 add_pid_equipment / add_pid_nozzle). */

import { z, vec2 } from '@core/commands/schema';
import type { Vec2 } from '@core/model/vectors';
import type { PidEquipment, PidNozzle } from '../model';
import { halfExtents } from './classes';

export const SIDES = ['left', 'right', 'top', 'bottom'] as const;
const DIRECTIONS: Readonly<Record<(typeof SIDES)[number], Vec2>> = { left: [-1, 0], right: [1, 0], top: [0, 1], bottom: [0, -1] };
/** Spacing between nozzles sharing a side, mm. */
const SPACING = 10;

export const sideParam = z
  .union([z.enum(SIDES), vec2('Offset [dx, dy] from the equipment centre, sheet mm (before rotation).')])
  .describe(
    'Where the nozzle sits: a side of the symbol (left, right, top = +y, bottom = -y) or an offset [dx, dy] from the equipment centre, sheet mm.',
  );

export const nozzleParam = z.object({
  subTag: z.string().trim().min(1).describe('Nozzle sub-tag, unique on its equipment (e.g. "N1").'),
  side: sideParam,
  dn: z.number().int().positive().optional().describe('Nozzle nominal size, DN integer (e.g. 100).'),
  access: z.boolean().optional().describe('True for a manhole / access nozzle (an unconnected one is info, not a warning).'),
});

export type NozzleParam = z.output<typeof nozzleParam>;

const rotate = (v: Vec2, degrees: number): Vec2 => {
  const a = (degrees * Math.PI) / 180;
  return [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
};

/** Offset of a nozzle from the centre; `index` / `count` spread nozzles that share a side, symmetric about the side centre. */
export function nozzleOffset(dexpiClass: string, side: NozzleParam['side'], index: number, count: number): Vec2 {
  if (typeof side !== 'string') return side;
  const [hx, hy] = halfExtents(dexpiClass);
  const [dx, dy] = DIRECTIONS[side];
  const shift = (index - (count - 1) / 2) * SPACING;
  return [dx * hx + (dx === 0 ? shift : 0), dy * hy + (dy === 0 ? shift : 0)];
}

/** Port on the sheet for an offset from the centre of `equipment`. */
export const portOf = (equipment: PidEquipment, offset: Vec2): Vec2 => {
  const turned = rotate(offset, equipment.rotationDeg);
  return [equipment.at[0] + turned[0], equipment.at[1] + turned[1]];
};

export const sideKey = (side: NozzleParam['side']): string => (typeof side === 'string' ? side : 'offset');

export function makeNozzle(id: string, equipment: PidEquipment, spec: NozzleParam | Omit<NozzleParam, 'side'>, port: Vec2): PidNozzle {
  return {
    id,
    kind: 'nozzle',
    sheetId: equipment.sheetId,
    at: port,
    rotationDeg: 0,
    dexpiClass: 'Nozzle',
    attributes: {},
    equipmentId: equipment.id,
    subTag: spec.subTag,
    ...(spec.dn === undefined ? {} : { dn: spec.dn }),
    ...(spec.access === undefined ? {} : { access: spec.access }),
    port,
  };
}
