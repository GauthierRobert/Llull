/** Integral over t in [0, 1] of g(law(t)) by composite 5-point Gauss-Legendre, split at the table knots. */

import { lawFunction, lawKnots } from './evaluate';
import type { ScalarLaw } from './types';

const NODES: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5688888888888889],
  [-0.5384693101056831, 0.47862867049936647],
  [0.5384693101056831, 0.47862867049936647],
  [-0.906179845938664, 0.23692688505618908],
  [0.906179845938664, 0.23692688505618908],
];

const SUBINTERVALS = 64;

/** ∫₀¹ g(law(t)) dt; `length` feeds expression laws. */
export function integrateLaw(law: ScalarLaw, g: (value: number) => number, length: number): number {
  const f = lawFunction(law);
  const knots = lawKnots(law);
  let total = 0;
  for (let k = 0; k + 1 < knots.length; k++) {
    const a = knots[k] as number;
    const b = knots[k + 1] as number;
    const h = (b - a) / SUBINTERVALS;
    for (let i = 0; i < SUBINTERVALS; i++) {
      const mid = a + (i + 0.5) * h;
      for (const [x, w] of NODES) total += w * g(f(mid + (x * h) / 2, length)) * (h / 2);
    }
  }
  return total;
}
