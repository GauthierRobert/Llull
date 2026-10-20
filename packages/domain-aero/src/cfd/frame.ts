/** Case frame: x along the flow axis, z along the up axis (orthogonalised), y = z × x. Right-handed, so orientation is preserved. */

import type { Vec3 } from '@core/model/types';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';

export interface CaseFrame {
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

/** Whether the two axes are non-zero and not parallel (the frame is defined). */
export function axesAreIndependent(flowAxis: Vec3, upAxis: Vec3): boolean {
  const flow = len3(flowAxis);
  const up = len3(upAxis);
  if (!(flow > 0) || !(up > 0)) return false;
  return len3(cross3(flowAxis, upAxis)) / (flow * up) > 1e-9;
}

/** @invariant `axesAreIndependent(flowAxis, upAxis)` */
export function caseFrame(flowAxis: Vec3, upAxis: Vec3): CaseFrame {
  const x = normalize3(flowAxis);
  const z = normalize3(sub3(upAxis, scale3(x, dot3(upAxis, x))));
  return { x, y: cross3(z, x), z };
}

export const toCaseFrame = (frame: CaseFrame, point: Vec3): Vec3 => [dot3(point, frame.x), dot3(point, frame.y), dot3(point, frame.z)];
