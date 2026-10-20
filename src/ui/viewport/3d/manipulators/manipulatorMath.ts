// Pure maths of the feature drag handles: where along a handle axis a pointer ray points, how that becomes a (snapped, clamped)
// value, and the join / cut inference for an extrusion. No three.js, no document writes.

import { type Bounds, boundsOverlap } from '@core/geometry/bounds';
import { is3D, type CadDocument, type EntityId } from '@core/model/types';

export type Vec3 = readonly [number, number, number];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * Parameter t (distance along the unit `axis` from `origin`) of the point of the axis line closest to the pointer ray; null when the
 * ray is (nearly) parallel to the axis and the answer is undefined.
 * @pure
 */
export function axisParamFromRay(origin: Vec3, axis: Vec3, rayOrigin: Vec3, rayDirection: Vec3): number | null {
  const w = sub(origin, rayOrigin);
  const b = dot(axis, rayDirection);
  const denominator = 1 - b * b;
  if (denominator < 1e-6) return null;
  const d = dot(axis, w);
  const e = dot(rayDirection, w);
  return (b * e - d) / denominator;
}

/** Round to a step (> 0); a non-positive step leaves the value alone. @pure */
export function snapToStep(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

/** Drag step for a handle: 1/20 of its scale, snapped to a 1-2-5 decade so values read clean (0.5, 1, 2, 5, 10 ...). @pure */
export function stepForScale(scale: number): number {
  if (!(scale > 0)) return 1;
  const raw = scale / 20;
  const decade = 10 ** Math.floor(Math.log10(raw));
  const lead = raw / decade;
  return decade * (lead < 1.5 ? 1 : lead < 3.5 ? 2 : lead < 7.5 ? 5 : 10);
}

/**
 * New value while dragging: the handle value at drag start plus the pointer's travel along the axis, snapped, and kept at or above
 * `minimum` (pass -Infinity for a signed handle). @pure
 */
export function draggedValue(startValue: number, startParam: number, currentParam: number, step: number, minimum: number): number {
  const next = snapToStep(startValue + (currentParam - startParam), step);
  return Math.max(minimum, next);
}

/** Parse the text of an on-canvas value box; null when it is not a finite number. @pure */
export function parseValueText(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export type BooleanMode = 'new' | 'join' | 'cut';
export type ModeChoice = 'auto' | BooleanMode;

/**
 * How an extrusion combines with the body it touches. Auto: outward (positive, along the profile normal) joins, inward (negative)
 * cuts, and with no body in reach it is a new solid. An explicit choice wins, except join / cut need a body. @pure
 */
export function resolveExtrudeMode(choice: ModeChoice, signedDistance: number, hasBody: boolean): BooleanMode {
  if (!hasBody) return 'new';
  if (choice !== 'auto') return choice;
  return signedDistance < 0 ? 'cut' : 'join';
}

/** World box swept by a profile of `profile` bounds pushed `signedDistance` along +Z (negative goes down). @pure */
export function sweptBounds(profile: Bounds, signedDistance: number): Bounds {
  const z0 = profile.min[2];
  const z1 = profile.max[2] + signedDistance;
  return { min: [profile.min[0], profile.min[1], Math.min(z0, z1)], max: [profile.max[0], profile.max[1], Math.max(z0, z1)] };
}

/** The first (document order) 3D solid whose box meets `swept`, ignoring `exclude`; undefined when none. @pure */
export function findBodyInReach(
  doc: CadDocument,
  swept: Bounds,
  boundsOf: (id: EntityId) => Bounds,
  exclude: ReadonlySet<EntityId>,
): EntityId | undefined {
  return doc.order.find((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && !exclude.has(id) && is3D(entity) && entity.kind !== 'instance' && boundsOverlap(swept, boundsOf(id));
  });
}
