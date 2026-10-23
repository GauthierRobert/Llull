/**
 * Triply periodic minimal surface fields (05 IMP §5.4): F(X, Y, Z) with X = 2 pi x / a_x for the gyroid, Schwarz P and diamond (short form),
 * plus the physical gradient norm used to normalise walls to first order.
 * @invariant F(-p) = -F(p) (gyroid) / F(p + a/2 (1,1,1)) = -F(p) (P) / F(p + a/2 e_x) = -F(p) (D): the level-0 network fills exactly one half of an integer cell block
 */

import type { FieldBuilder } from '@core/geometry/field/build';
import type { Vec3 } from '@core/model/types';
import type { Frame } from './frame';
import type { TpmsKind } from './model';

const TWO_PI = 2 * Math.PI;

/** Range of F, the max |grad_X F| bound used for the Lipschitz constant, and nodal-surface facts (a = 1). */
export const TPMS_FACTS: Readonly<
  Record<
    TpmsKind,
    {
      readonly range: number;
      readonly gradBound: number;
      readonly gradOnSurface: readonly [number, number];
      readonly specificSurface: number;
    }
  >
> = {
  gyroid: { range: 1.5, gradBound: 2 * Math.sqrt(3), gradOnSurface: [Math.SQRT2, Math.sqrt(3)], specificSurface: 3.0916 },
  schwarz_p: { range: 3, gradBound: Math.sqrt(3), gradOnSurface: [1, Math.sqrt(3)], specificSurface: 2.3526 },
  diamond: { range: 1, gradBound: 2 * Math.sqrt(3), gradOnSurface: [1, Math.sqrt(1.5)], specificSurface: 3.838 },
};

export interface TpmsRegisters {
  /** F at the point. */
  readonly field: number;
  /** Physical gradient norm |grad F| (1 / length), floored away from 0. */
  readonly gradient: number;
}

/** Cell coordinates (X, Y, Z in radians) and the physical scale of each (d coordinate / d length) as registers. */
export interface CellCoordinates {
  readonly coords: readonly [number, number, number];
  readonly scales: readonly [number, number, number];
}

/** Rectangular cells: X = 2 pi x / a_x with constant scales. */
export function rectangularCoordinates(b: FieldBuilder, cell: Vec3, frame: Frame): CellCoordinates {
  const scale = (axis: 0 | 1 | 2): number => TWO_PI / cell[axis];
  return {
    coords: [b.scale(frame.x, scale(0)), b.scale(frame.y, scale(1)), b.scale(frame.z, scale(2))],
    scales: [b.constant(scale(0)), b.constant(scale(1)), b.constant(scale(2))],
  };
}

/**
 * Cylindrical cells about the local z axis (05 IMP 5.6): X = cellsAround * theta (whole turns, so F is continuous across the seam), Y = 2 pi z / a_z,
 * Z = 2 pi rho / a_rho; the angular scale is cellsAround / rho.
 */
export function cylindricalCoordinates(
  b: FieldBuilder,
  frame: Frame,
  cellsAround: number,
  axialCell: number,
  radialCell: number,
): CellCoordinates {
  const rho = b.max(b.sqrt(b.add(b.square(frame.x), b.square(frame.y))), b.constant(1e-9));
  return {
    coords: [
      b.scale(b.op('atan2', frame.y, frame.x), cellsAround),
      b.scale(frame.z, TWO_PI / axialCell),
      b.scale(rho, TWO_PI / radialCell),
    ],
    scales: [b.div(b.constant(cellsAround), rho), b.constant(TWO_PI / axialCell), b.constant(TWO_PI / radialCell)],
  };
}

/** Emit F and |grad F| (physical units) for the family on the given cell coordinates. */
export function tpmsRegisters(b: FieldBuilder, kind: TpmsKind, cell: CellCoordinates): TpmsRegisters {
  const [X, Y, Z] = cell.coords;
  const [sx, cx, sy, cy, sz, cz] = [b.sin(X), b.cos(X), b.sin(Y), b.cos(Y), b.sin(Z), b.cos(Z)];
  const sum = (...terms: number[]): number => terms.reduce((acc, term) => b.add(acc, term));
  let field: number;
  let partial: [number, number, number];
  switch (kind) {
    case 'gyroid':
      field = sum(b.mul(sx, cy), b.mul(sy, cz), b.mul(sz, cx));
      partial = [
        sum(b.mul(cx, cy), b.neg(b.mul(sz, sx))),
        sum(b.neg(b.mul(sx, sy)), b.mul(cy, cz)),
        sum(b.neg(b.mul(sy, sz)), b.mul(cz, cx)),
      ];
      break;
    case 'schwarz_p':
      field = sum(cx, cy, cz);
      partial = [b.neg(sx), b.neg(sy), b.neg(sz)];
      break;
    case 'diamond':
      field = b.sub(b.mul(b.mul(cx, cy), cz), b.mul(b.mul(sx, sy), sz));
      partial = [
        b.neg(sum(b.mul(b.mul(sx, cy), cz), b.mul(b.mul(cx, sy), sz))),
        b.neg(sum(b.mul(b.mul(cx, sy), cz), b.mul(b.mul(sx, cy), sz))),
        b.neg(sum(b.mul(b.mul(cx, cy), sz), b.mul(b.mul(sx, sy), cz))),
      ];
      break;
  }
  const physical = partial.map((p, axis) => b.mul(p, cell.scales[axis] as number));
  const norm = b.length3(physical[0] as number, physical[1] as number, physical[2] as number);
  return { field, gradient: b.max(norm, b.constant(1e-9)) };
}
