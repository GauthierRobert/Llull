/** Params and checks shared by the drawing commands. */

import { type CadDocument, is3D } from '../../model/types';
import { PAPER_SIZES, VIEW_DIRECTIONS, type ViewDirection } from '../../model/sheet';
import { z } from '../schema';

export const paperField = z
  .enum(PAPER_SIZES)
  .describe('ISO paper size, landscape: A4 (297x210 mm), A3 (420x297), A2, A1 or A0 (1189x841).');

export const directionField = z
  .enum(VIEW_DIRECTIONS)
  .describe(
    'Side the viewer stands on (Z is up): front = looking along +Y from -Y (shows X and Z), back, right = from +X (shows Y and Z), ' +
      'left, top = from +Z (shows X and Y), bottom, iso = isometric from (+X, -Y, +Z).',
  );

export const scaleField = z
  .number()
  .positive()
  .describe('Scale as the denominator N of 1:N: 50 = 1:50, 1 = 1:1, 0.5 = 2:1 (enlargement), 0.2 = 5:1.');

export const entityIdsField = z
  .array(z.string())
  .describe('Ids of the 3D solids to draw. Omit to draw every visible 3D solid of the document (the usual choice).');

/** Default caption of a projection view. */
export const DIRECTION_LABELS: Readonly<Record<ViewDirection, string>> = {
  front: 'FRONT',
  back: 'BACK',
  left: 'LEFT',
  right: 'RIGHT',
  top: 'TOP',
  bottom: 'BOTTOM',
  iso: 'ISOMETRIC',
};

/** Why `entityIds` cannot be drawn (unknown id or not a 3D solid), or null when every id is a 3D solid. */
export function entityProblem(doc: CadDocument, entityIds: ReadonlyArray<string>): string | null {
  for (const id of entityIds) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (!entity) return `no entity '${id}'`;
    if (!is3D(entity)) return `entity '${id}' is a 2D shape; views project 3D solids`;
  }
  return null;
}

/** True when the document has at least one 3D solid a view could show. */
export const hasSolids = (doc: CadDocument): boolean => doc.order.some((id) => doc.entities[id] !== undefined && is3D(doc.entities[id]));

/** `value` without its undefined properties (zod optionals arrive as `T | undefined`; the model forbids that). */
export function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** `value` without the listed keys. */
export function omitKeys<T extends object, K extends keyof T>(value: T, keys: ReadonlyArray<K>): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as K))) as Omit<T, K>;
}
