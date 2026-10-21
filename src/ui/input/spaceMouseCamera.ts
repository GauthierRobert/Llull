// Applies one SpaceMouse CameraMotion to a camera pose (world space, +Z up). Pure; the viewport drives the real camera with the result.

import type { CameraMotion } from './spaceMouseMapping';
import { cross3 } from '@lib/vec3';

type Vec3 = readonly [number, number, number];

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

const MIN_DISTANCE = 1e-3;
/** Keep the eye off the exact poles so the azimuth stays defined. */
const POLE_MARGIN = 0.01;

/** @pure */
export function moveCamera(pose: CameraPose, motion: CameraMotion): CameraPose {
  const offset: Vec3 = [pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]];
  const distance = Math.max(Math.hypot(offset[0], offset[1], offset[2]), MIN_DISTANCE);

  let azimuth = Math.atan2(offset[0], offset[1]);
  let polar = Math.acos(Math.max(-1, Math.min(1, offset[2] / distance)));
  azimuth += motion.orbitAzimuth;
  polar = Math.min(Math.PI - POLE_MARGIN, Math.max(POLE_MARGIN, polar - motion.orbitPolar));
  const nextDistance = Math.max(distance * Math.exp(-motion.dolly), MIN_DISTANCE);
  const sinPolar = Math.sin(polar);
  const nextOffset: Vec3 = [
    nextDistance * sinPolar * Math.sin(azimuth),
    nextDistance * sinPolar * Math.cos(azimuth),
    nextDistance * Math.cos(polar),
  ];

  // Pan along the pre-orbit view plane, scaled by the view distance (what you see moves by a fixed screen fraction).
  const forward: Vec3 = [-offset[0] / distance, -offset[1] / distance, -offset[2] / distance];
  const rawRight = cross3(forward, [0, 0, 1]);
  const rightLength = Math.hypot(rawRight[0], rawRight[1], rawRight[2]);
  const right: Vec3 =
    rightLength > 1e-6 ? [rawRight[0] / rightLength, rawRight[1] / rightLength, 0] : [Math.cos(azimuth), -Math.sin(azimuth), 0];
  const up = cross3(right, forward);
  const shift = (axis: number): number => (right[axis] ?? 0) * motion.panRight * distance + (up[axis] ?? 0) * motion.panUp * distance;
  const target: Vec3 = [pose.target[0] + shift(0), pose.target[1] + shift(1), pose.target[2] + shift(2)];

  return { target, position: [target[0] + nextOffset[0], target[1] + nextOffset[1], target[2] + nextOffset[2]] };
}
