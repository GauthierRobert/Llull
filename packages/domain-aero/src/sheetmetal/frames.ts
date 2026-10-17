/** 3D placement of flats and bends: child frames from a parent frame and a bend (conventions in `@core/model/sheetMetal`). */

import type { Vec2, Vec3 } from '@core/model/types';
import type { Frame3, Seg2, SheetMetalPart } from '@core/model/sheetMetal';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '@lib/vec3';
import { applyMat3, matFromAxisAngle } from '@lib/axisRotation';
import { eulerFromAxes } from '@lib/eulerRotation';
import { lineBasis } from './geometry2d';

export interface Basis {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

export function basisOf(frame: Frame3): Basis {
  const z = normalize3(frame.normal);
  const x = normalize3(frame.xDir);
  return { origin: frame.origin, x, y: cross3(z, x), z };
}

/** World point of the frame-local point (x, y, z). */
export function frameToWorld(frame: Frame3, [x, y]: Vec2, z = 0): Vec3 {
  const basis = basisOf(frame);
  return add3(add3(add3(basis.origin, scale3(basis.x, x)), scale3(basis.y, y)), scale3(basis.z, z));
}

/** Frame-local coordinates (x, y, z) of a world point. */
export function worldToFrame(frame: Frame3, point: Vec3): Vec3 {
  const basis = basisOf(frame);
  const offset = sub3(point, basis.origin);
  return [dot3(offset, basis.x), dot3(offset, basis.y), dot3(offset, basis.z)];
}

/** Local z of the bottom face of the material for a part side. */
export const bottomOffset = (side: SheetMetalPart['side'], thickness: number): number =>
  side === 'up' ? 0 : side === 'down' ? -thickness : -thickness / 2;

/** Euler rotation (entity convention) that maps world axes onto the frame axes. */
export function frameEuler(frame: Frame3): Vec3 {
  const basis = basisOf(frame);
  return eulerFromAxes(basis.x, basis.y, basis.z);
}

export interface BendGeometry {
  /** Frame of the child flat (origin at the far tangent line's start, x along the bend line, y away from the bend). */
  readonly child: Frame3;
  /** Revolution entity placement of the bend sector; profile is [radius, axial] pairs, sweep in radians about local +Z. */
  readonly revolution: {
    readonly position: Vec3;
    readonly rotation: Vec3;
    readonly profile: ReadonlyArray<readonly [number, number]>;
    readonly sweep: number;
  };
  readonly axisPoint: Vec3;
  readonly axisDir: Vec3;
}

/**
 * Child frame and bend sector of a bend of signed `angle` (radians) along `line` in `parent`'s frame.
 * @param bottom local z of the bottom face of the material (see `bottomOffset`)
 */
export function bendGeometry(
  parent: Frame3,
  line: Seg2,
  angle: number,
  insideRadius: number,
  thickness: number,
  bottom: number,
): BendGeometry {
  const basis = basisOf(parent);
  const [p, q] = line;
  const { direction, length } = lineBasis(p, q);
  const axisDir = add3(scale3(basis.x, direction[0]), scale3(basis.y, direction[1]));
  const start = frameToWorld(parent, p);
  const up = angle > 0;
  const axisPoint = add3(start, scale3(basis.z, up ? bottom + thickness + insideRadius : bottom - insideRadius));
  const rotation = matFromAxisAngle(axisDir, angle);
  const childOrigin = add3(axisPoint, applyMat3(rotation, sub3(start, axisPoint)));
  const child: Frame3 = { origin: childOrigin, xDir: axisDir, normal: applyMat3(rotation, basis.z) };
  const profile: ReadonlyArray<readonly [number, number]> = [
    [insideRadius, 0],
    [insideRadius + thickness, 0],
    [insideRadius + thickness, length],
    [insideRadius, length],
  ];
  const radial = up ? scale3(basis.z, -1) : basis.z;
  const axial = up ? axisDir : scale3(axisDir, -1);
  const position = up ? axisPoint : add3(axisPoint, scale3(axisDir, length));
  const sectorRotation = eulerFromAxes(radial, cross3(axial, radial), axial);
  return { child, revolution: { position, rotation: sectorRotation, profile, sweep: Math.abs(angle) }, axisPoint, axisDir };
}
