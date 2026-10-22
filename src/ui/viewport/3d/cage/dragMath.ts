// Pointer / gizmo math of a cage drag. Pure: world-space rays in, a gesture out. No three.js, no store.

import type { Vec3 } from '@core/model/types';
import { add3, dot3, normalize3, scale3, sub3 } from '@lib/vec3';
import { axisParamFromRay } from '../manipulators/manipulatorMath';
import type { CageGesture } from './gestureCommands';

export interface WorldRay {
  readonly origin: Vec3;
  /** Unit length. */
  readonly direction: Vec3;
}

export type AxisLock = 'x' | 'y' | 'z' | null;

const AXES: Readonly<Record<'x' | 'y' | 'z', Vec3>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Pixels the pointer must travel before a press becomes a drag (a shorter press is a click). */
const DRAG_THRESHOLD_PX = 4;

export const crossedThreshold = (from: { x: number; y: number }, to: { x: number; y: number }): boolean =>
  Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD_PX;

/** World units covered by one screen pixel at `distance` from a perspective camera. */
export function unitsPerPixel(distance: number, fovDegrees: number, viewportHeightPx: number): number {
  return viewportHeightPx > 0 ? (2 * distance * Math.tan((fovDegrees * Math.PI) / 360)) / viewportHeightPx : 0;
}

/** Where the ray meets the plane (through `point`, normal `normal`), or null when parallel / behind. */
export function rayPlanePoint(ray: WorldRay, point: Vec3, normal: Vec3): Vec3 | null {
  const denominator = dot3(ray.direction, normal);
  if (Math.abs(denominator) < 1e-9) return null;
  const t = dot3(sub3(point, ray.origin), normal) / denominator;
  return t < 0 ? null : add3(ray.origin, scale3(ray.direction, t));
}

export interface DragStart {
  readonly kind: 'translate' | 'extrude';
  /** Ray under the pointer when the press happened. */
  readonly ray: WorldRay;
  /** Translate: centroid of the selection. Extrude: centroid of the picked face. */
  readonly origin: Vec3;
  /** Translate: the camera forward direction (the drag plane normal). Extrude: the unit face normal. */
  readonly axis: Vec3;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;

/** The gesture a drag has reached for the current pointer ray, or null when the ray cannot resolve one. */
export function dragGesture(start: DragStart, ray: WorldRay, lock: AxisLock): CageGesture | null {
  if (start.kind === 'extrude') {
    const [from, to] = [
      axisParamFromRay(start.origin, start.axis, start.ray.origin, start.ray.direction),
      axisParamFromRay(start.origin, start.axis, ray.origin, ray.direction),
    ];
    return from === null || to === null ? null : { kind: 'extrude', distance: round(to - from) };
  }
  const [from, to] = [rayPlanePoint(start.ray, start.origin, start.axis), rayPlanePoint(ray, start.origin, start.axis)];
  if (from === null || to === null) return null;
  const delta = sub3(to, from);
  const constrained = lock === null ? delta : scale3(AXES[lock], dot3(delta, AXES[lock]));
  return { kind: 'translate', delta: [round(constrained[0]), round(constrained[1]), round(constrained[2])] };
}

/** Axis (unit, world) and angle (degrees) of the rotation `q` = (x, y, z, w); angle 0 and axis +Z for the identity. */
export function quaternionAxisAngle(q: { x: number; y: number; z: number; w: number }): { axis: Vec3; angleDeg: number } {
  const w = Math.min(1, Math.max(-1, q.w));
  const sine = Math.sqrt(1 - w * w);
  if (sine < 1e-9) return { axis: [0, 0, 1], angleDeg: 0 };
  let angleDeg = (2 * Math.acos(w) * 180) / Math.PI;
  if (angleDeg > 180) angleDeg -= 360;
  return { axis: normalize3([q.x / sine, q.y / sine, q.z / sine]), angleDeg };
}

/** Inset width for a modal inset: grows as the pointer moves right of where `I` was pressed; never below `minimum`. */
export function insetThickness(startThickness: number, deltaPx: number, perPixel: number, minimum: number): number {
  return round(Math.max(minimum, startThickness + deltaPx * perPixel));
}
