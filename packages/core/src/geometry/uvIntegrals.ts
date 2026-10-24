/**
 * Line integrals over loops in a surface's (u, v) plane (03 WRP): the closed-form areas and volumes of regions on a sphere or torus follow from Green's theorem
 * as integrals of a function of v against du around the loops.
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { curveDomain } from '../lib/nurbs/evaluate';
import { integrateCurve } from '../lib/nurbs/integrate';
import type { UvLoop } from '../model/wrap';
import { segmentEnd, segmentStart, type PlaneSegment } from './planeSegments';

/** 8-point Gauss-Legendre rule on [-1, 1]. */
const GAUSS: ReadonlyArray<readonly [number, number]> = [
  [-0.9602898564975363, 0.1012285362903763],
  [-0.7966664774136267, 0.2223810344533745],
  [-0.525532409916329, 0.3137066458778873],
  [-0.1834346424956498, 0.362683783378362],
  [0.1834346424956498, 0.362683783378362],
  [0.525532409916329, 0.3137066458778873],
  [0.7966664774136267, 0.2223810344533745],
  [0.9602898564975363, 0.1012285362903763],
];

/** Pieces a straight (u, v) segment is split into before the rule: a long span in v would otherwise under-resolve sin / cos. */
const LINE_PIECES = 8;

/** Integral of f(v) du around the loop (counter-clockwise loops of a region of area A give minus the integral of the antiderivative of the area element). */
export function integrateDu(loop: UvLoop, f: (v: number) => number): number {
  let total = 0;
  let at = loop.start;
  for (const segment of loop.segments) {
    if (segment.kind === 'line') {
      const [u1, v1] = at;
      const [u2, v2] = segment.to;
      for (let piece = 0; piece < LINE_PIECES; piece++) {
        const [a, b] = [piece / LINE_PIECES, (piece + 1) / LINE_PIECES];
        for (const [x, w] of GAUSS) {
          const t = a + ((x + 1) / 2) * (b - a);
          total += (w * (b - a) * (u2 - u1) * f(v1 + t * (v2 - v1))) / 2;
        }
      }
      at = segment.to;
    } else {
      const curve = { ...segment.curve, poles: segment.curve.poles.map(([x, y]): Vec3 => [x, y, 0]) };
      const [first, last] = curveDomain(curve);
      total += integrateCurve(curve, first, last, (point, derivative) => f(point[1]) * derivative[0]);
      at = segment.curve.poles[segment.curve.poles.length - 1] as Vec2;
    }
  }
  return total;
}

/** The closed loop of a chain of (u, v) pieces (each starting where the previous ends). */
export function loopOfPieces(pieces: readonly PlaneSegment[]): UvLoop {
  return {
    start: segmentStart(pieces[0] as PlaneSegment),
    segments: pieces.map((piece) =>
      piece.kind === 'line' ? { kind: 'line' as const, to: segmentEnd(piece) } : { kind: 'nurbs' as const, curve: piece.curve },
    ),
  };
}
