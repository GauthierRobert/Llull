/** Symbol vocabulary of the built-in P&ID library (plant 04 PID §3 symbols/): shapes in the symbol's own frame, mm, +y up, origin at the centre. */

import type { Vec2 } from '@core/model/vectors';

export type ShapeStyle = 'visible' | 'thin' | 'hidden';

export type Shape =
  /** Polyline, closed to a polygon when `closed`; `fill` paints it solid. */
  | { readonly t: 'line'; readonly pts: readonly Vec2[]; readonly closed?: true; readonly fill?: true; readonly style?: ShapeStyle }
  | { readonly t: 'circle'; readonly c: Vec2; readonly r: number; readonly fill?: true; readonly style?: ShapeStyle }
  | { readonly t: 'text'; readonly at: Vec2; readonly h: number; readonly s: string };

export const line = (pts: readonly Vec2[], style?: ShapeStyle): Shape => ({ t: 'line', pts, ...(style === undefined ? {} : { style }) });
export const poly = (pts: readonly Vec2[], fill?: true): Shape => ({
  t: 'line',
  pts,
  closed: true,
  ...(fill === undefined ? {} : { fill }),
});
export const circle = (c: Vec2, r: number, fill?: true): Shape => ({ t: 'circle', c, r, ...(fill === undefined ? {} : { fill }) });
export const text = (at: Vec2, h: number, s: string): Shape => ({ t: 'text', at, h, s });
export const rect = (hx: number, hy: number): Shape =>
  poly([
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ]);

/** Points of an ellipse (closed ring, `n` segments). */
export const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 20): Vec2[] =>
  Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)] as Vec2);

/** A vertical vessel: straight shell with elliptical heads of height `cap`. */
export function capsule(hx: number, hy: number, cap: number): Shape {
  const head = (sign: 1 | -1): Vec2[] =>
    Array.from({ length: 9 }, (_, i) => {
      const a = (Math.PI * i) / 8;
      return [sign * hx * Math.cos(a), sign * (hy - cap + cap * Math.sin(a))] as Vec2;
    });
  return poly([...head(1), ...head(-1)]);
}

export type SymbolFamily = 'equipment' | 'piping' | 'instrument' | 'actuator' | 'connector' | 'annotation';

export interface PidSymbol {
  /** DEXPI class (or the variant name for instruments / actuators). */
  readonly class: string;
  readonly name: string;
  readonly family: SymbolFamily;
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** Connection points in the symbol frame (components: the two ends on the flow axis). */
  readonly ports: readonly Vec2[];
  readonly shapes: readonly Shape[];
}
