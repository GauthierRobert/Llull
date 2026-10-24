// Pointer math of a face handle drag. Pure: world rays in, a signed value out. No three.js, no stores.

import type { Vec3 } from '@core/model/types';
import { add3, dot3, scale3, sub3 } from '@lib/vec3';
import { axisParamFromRay, snapToStep, stepForScale } from '../manipulators/manipulatorMath';
import type { PickRay } from './faceMesh';

/** Pixels of the handle arrow on screen. */
export const HANDLE_PX = 84;
/** Pixels within which the pointer grabs the handle. */
export const HANDLE_GRAB_PX = 10;

/** Closest distance between a ray (t >= 0) and the segment `a`-`b`. */
export function rayToSegmentDistance(ray: PickRay, a: Vec3, b: Vec3): number {
  const d = sub3(b, a);
  const w = sub3(ray.origin, a);
  const dd = dot3(d, d);
  const rd = dot3(ray.direction, d);
  const denominator = dd - rd * rd;
  let s = denominator < 1e-12 ? 0 : (dot3(w, ray.direction) * rd - dot3(w, d)) / -denominator;
  s = dd < 1e-18 ? 0 : Math.min(1, Math.max(0, s));
  const onSegment = add3(a, scale3(d, s));
  const t = Math.max(0, dot3(sub3(onSegment, ray.origin), ray.direction));
  const onRay = add3(ray.origin, scale3(ray.direction, t));
  const delta = sub3(onSegment, onRay);
  return Math.sqrt(dot3(delta, delta));
}

/** Does the ray grab the handle drawn from `origin` along `axis` for `length`, within `tolerance` world units? */
export const grabsHandle = (ray: PickRay, origin: Vec3, axis: Vec3, length: number, tolerance: number): boolean =>
  rayToSegmentDistance(ray, origin, add3(origin, scale3(axis, length))) <= tolerance;

/** Travel along `axis` (through `origin`) between where the press ray and the current ray point; null when the ray runs parallel to the axis. */
export function travelAlongAxis(origin: Vec3, axis: Vec3, pressRay: PickRay, ray: PickRay): number | null {
  const from = axisParamFromRay(origin, axis, pressRay.origin, pressRay.direction);
  const to = axisParamFromRay(origin, axis, ray.origin, ray.direction);
  return from === null || to === null ? null : to - from;
}

/** Drag step: a 1-2-5 fraction of the solid's size; `free` (Alt) leaves the value unsnapped. */
export const dragStep = (solidSize: number, free: boolean): number => (free ? 0 : stepForScale(solidSize));

/** `value` snapped to the step, then to a candidate plane offset (relative to the current face plane) within `tolerance`. */
export function snapFaceValue(value: number, step: number, planes: readonly number[], tolerance: number): number {
  let best: number | null = null;
  for (const plane of planes)
    if (Math.abs(plane - value) <= tolerance && (best === null || Math.abs(plane - value) < Math.abs(best - value))) best = plane;
  return best ?? snapToStep(value, step);
}
