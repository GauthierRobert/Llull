/**
 * The five higher-order TPMS families (05 IMP 5.4, D8): F and its partial derivatives with respect to the cell coordinates X, Y, Z, built from
 * sin / cos of X and 2X. Partials checked against central differences (TECHNICAL_SPEC 14.3). Equations:
 *   neovius        3 (cos X + cos Y + cos Z) + 4 cos X cos Y cos Z                                   (Schoen 1970)
 *   iwp            2 (cos X cos Y + cos Y cos Z + cos Z cos X) - (cos 2X + cos 2Y + cos 2Z)           (Schoen 1970)
 *   lidinoid       1/2 (sin 2X cos Y sin Z + sin 2Y cos Z sin X + sin 2Z cos X sin Y)
 *                  - 1/2 (cos 2X cos 2Y + cos 2Y cos 2Z + cos 2Z cos 2X) + 0.15                      (Lidin & Larsson 1990)
 *   fischer_koch_s cos 2X sin Y cos Z + cos 2Y sin Z cos X + cos 2Z sin X cos Y                       (Fischer & Koch 1989)
 *   split_p        1.1 (sin 2X sin Z cos Y + sin 2Y sin X cos Z + sin 2Z sin Y cos X)
 *                  - 0.2 (cos 2X cos 2Y + cos 2Y cos 2Z + cos 2Z cos 2X) - 0.4 (cos 2X + cos 2Y + cos 2Z)   (Al-Ketan & Abu Al-Rub 2019)
 */

import type { FieldBuilder } from '@core/geometry/field/build';
import type { TpmsKind } from './model';

export type HigherOrderKind = 'neovius' | 'iwp' | 'lidinoid' | 'fischer_koch_s' | 'split_p';

const HIGHER: ReadonlySet<TpmsKind> = new Set<TpmsKind>(['neovius', 'iwp', 'lidinoid', 'fischer_koch_s', 'split_p']);

export const isHigherOrder = (kind: TpmsKind): kind is HigherOrderKind => HIGHER.has(kind);

export interface Trig {
  readonly sx: number;
  readonly cx: number;
  readonly sy: number;
  readonly cy: number;
  readonly sz: number;
  readonly cz: number;
  readonly s2x: number;
  readonly s2y: number;
  readonly s2z: number;
  readonly c2x: number;
  readonly c2y: number;
  readonly c2z: number;
}

/** F and (dF/dX, dF/dY, dF/dZ) of a higher-order family as registers. */
export function higherOrder(b: FieldBuilder, kind: HigherOrderKind, t: Trig): { field: number; partial: [number, number, number] } {
  const sum = (...terms: number[]): number => terms.reduce((acc, term) => b.add(acc, term));
  const product = (...factors: number[]): number => factors.reduce((acc, factor) => b.mul(acc, factor));
  const k = (value: number, term: number): number => b.scale(term, value);
  const { sx, cx, sy, cy, sz, cz, s2x, s2y, s2z, c2x, c2y, c2z } = t;
  switch (kind) {
    case 'neovius':
      return {
        field: sum(k(3, sum(cx, cy, cz)), k(4, product(cx, cy, cz))),
        partial: [
          b.neg(sum(k(3, sx), k(4, product(sx, cy, cz)))),
          b.neg(sum(k(3, sy), k(4, product(cx, sy, cz)))),
          b.neg(sum(k(3, sz), k(4, product(cx, cy, sz)))),
        ],
      };
    case 'iwp':
      return {
        field: b.sub(k(2, sum(product(cx, cy), product(cy, cz), product(cz, cx))), sum(c2x, c2y, c2z)),
        partial: [
          b.add(b.neg(k(2, product(sx, b.add(cy, cz)))), k(2, s2x)),
          b.add(b.neg(k(2, product(sy, b.add(cx, cz)))), k(2, s2y)),
          b.add(b.neg(k(2, product(sz, b.add(cx, cy)))), k(2, s2z)),
        ],
      };
    case 'lidinoid': {
      const first = sum(product(s2x, cy, sz), product(s2y, cz, sx), product(s2z, cx, sy));
      const second = sum(product(c2x, c2y), product(c2y, c2z), product(c2z, c2x));
      return {
        field: b.shift(b.sub(k(0.5, first), k(0.5, second)), 0.15),
        partial: [
          b.add(k(0.5, sum(k(2, product(c2x, cy, sz)), product(s2y, cz, cx), b.neg(product(s2z, sx, sy)))), product(s2x, b.add(c2y, c2z))),
          b.add(k(0.5, sum(b.neg(product(s2x, sy, sz)), k(2, product(c2y, cz, sx)), product(s2z, cx, cy))), product(s2y, b.add(c2x, c2z))),
          b.add(k(0.5, sum(product(s2x, cy, cz), b.neg(product(s2y, sz, sx)), k(2, product(c2z, cx, sy)))), product(s2z, b.add(c2x, c2y))),
        ],
      };
    }
    case 'fischer_koch_s':
      return {
        field: sum(product(c2x, sy, cz), product(c2y, sz, cx), product(c2z, sx, cy)),
        partial: [
          sum(b.neg(k(2, product(s2x, sy, cz))), b.neg(product(c2y, sz, sx)), product(c2z, cx, cy)),
          sum(product(c2x, cy, cz), b.neg(k(2, product(s2y, sz, cx))), b.neg(product(c2z, sx, sy))),
          sum(b.neg(product(c2x, sy, sz)), product(c2y, cz, cx), b.neg(k(2, product(s2z, sx, cy)))),
        ],
      };
    case 'split_p': {
      const first = sum(product(s2x, sz, cy), product(s2y, sx, cz), product(s2z, sy, cx));
      const second = sum(product(c2x, c2y), product(c2y, c2z), product(c2z, c2x));
      return {
        field: sum(k(1.1, first), k(-0.2, second), k(-0.4, sum(c2x, c2y, c2z))),
        partial: [
          sum(
            k(1.1, sum(k(2, product(c2x, sz, cy)), product(s2y, cx, cz), b.neg(product(s2z, sy, sx)))),
            k(0.4, product(s2x, b.add(c2y, c2z))),
            k(0.8, s2x),
          ),
          sum(
            k(1.1, sum(b.neg(product(s2x, sz, sy)), k(2, product(c2y, sx, cz)), product(s2z, cy, cx))),
            k(0.4, product(s2y, b.add(c2x, c2z))),
            k(0.8, s2y),
          ),
          sum(
            k(1.1, sum(product(s2x, cz, cy), b.neg(product(s2y, sx, sz)), k(2, product(c2z, sy, cx)))),
            k(0.4, product(s2z, b.add(c2x, c2y))),
            k(0.8, s2z),
          ),
        ],
      };
    }
  }
}
