/**
 * Named orthographic view frames (Z up): `front` is seen from −Y, `right` from +X, `top` from +Z, `iso` from (+X, −Y, +Z). Sheet axes are
 * (right, up) with right × up = toViewer, so every frame is a proper rotation of the world.
 */

import type { Vec3 } from '../model/vectors';
import type { ViewDirection } from '../model/sheet';
import { cross3, dot3 } from '../lib/vec3';
import type { ViewFrame } from './viewProjection';

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

const AXES: Readonly<Record<ViewDirection, { readonly right: Vec3; readonly up: Vec3 }>> = {
  front: { right: [1, 0, 0], up: [0, 0, 1] },
  back: { right: [-1, 0, 0], up: [0, 0, 1] },
  right: { right: [0, 1, 0], up: [0, 0, 1] },
  left: { right: [0, -1, 0], up: [0, 0, 1] },
  top: { right: [1, 0, 0], up: [0, 1, 0] },
  bottom: { right: [1, 0, 0], up: [0, -1, 0] },
  iso: { right: unit([1, 1, 0]), up: unit(cross3(unit([1, -1, 1]), unit([1, 1, 0]))) },
};

const frameOf = ({ right, up }: { right: Vec3; up: Vec3 }): ViewFrame => ({
  toViewer: cross3(right, up),
  project: (p) => [dot3(p, right), dot3(p, up)],
});

const FRAMES: Readonly<Record<ViewDirection, ViewFrame>> = {
  front: frameOf(AXES.front),
  back: frameOf(AXES.back),
  right: frameOf(AXES.right),
  left: frameOf(AXES.left),
  top: frameOf(AXES.top),
  bottom: frameOf(AXES.bottom),
  iso: frameOf(AXES.iso),
};

/** The shared (cache-friendly) frame of a named view direction. @pure */
export const directionFrame = (direction: ViewDirection): ViewFrame => FRAMES[direction];

/** Unit vector toward the viewer of a named direction. @pure */
export const viewerOf = (direction: ViewDirection): Vec3 => FRAMES[direction].toViewer;

/** Cut depth (distance toward the viewer) of the world plane `offset` on the axis `direction` looks along. @pure */
export const cutDepthOf = (direction: ViewDirection, offset: number): number => dot3(viewerOf(direction), [1, 1, 1]) * offset;
