/** Planform and volume metrics of a wing definition (formulas over the piecewise-linear chord and leading-edge distributions). */

import type { WingStation } from './wingGeometry';

export interface WingMetrics {
  readonly semiSpan: number;
  readonly areaPerSide: number;
  readonly mac: number;
  readonly yMac: number;
  readonly xLeMac: number;
  readonly sweepLeDeg: number;
  readonly sweepC4Deg: number;
  readonly sweepTeDeg: number;
  readonly taper: number;
  readonly volumePerSide: number;
}

const DEG = 180 / Math.PI;

/** Simpson integral of the quadratic `f` over [a, b] (exact for products of two linear functions). */
const simpson = (f: (y: number) => number, a: number, b: number): number => ((b - a) / 6) * (f(a) + 4 * f((a + b) / 2) + f(b));

/**
 * @param stations leading-edge stations from the root to the tip
 * @param sectionAreas section area per station in chord^2 (`airfoil_properties.area`), for the volume
 * @invariant area, MAC, yMAC and xLE(MAC) are exact for the trapezoids; the volume is exact for homothetic sections (one airfoil) and a
 *   Simpson estimate with the mean section area at mid span otherwise
 */
export function wingMetrics(stations: ReadonlyArray<WingStation>, sectionAreas: ReadonlyArray<number>): WingMetrics {
  const root = stations[0] as WingStation;
  const tip = stations[stations.length - 1] as WingStation;
  let area = 0;
  let chordSquared = 0;
  let spanMoment = 0;
  let xMoment = 0;
  let volume = 0;
  for (let i = 0; i + 1 < stations.length; i++) {
    const [a, b] = [stations[i] as WingStation, stations[i + 1] as WingStation];
    const t = (y: number): number => (y - a.span) / (b.span - a.span);
    const chord = (y: number): number => a.chord + (b.chord - a.chord) * t(y);
    const xLe = (y: number): number => a.xLe + (b.xLe - a.xLe) * t(y);
    area += simpson(chord, a.span, b.span);
    chordSquared += simpson((y) => chord(y) ** 2, a.span, b.span);
    spanMoment += simpson((y) => y * chord(y), a.span, b.span);
    xMoment += simpson((y) => xLe(y) * chord(y), a.span, b.span);
    const [areaA, areaB] = [sectionAreas[i] as number, sectionAreas[i + 1] as number];
    volume += simpson((y) => (areaA + (areaB - areaA) * t(y)) * chord(y) ** 2, a.span, b.span);
  }
  const semiSpan = tip.span - root.span;
  const angle = (frontOf: (s: WingStation) => number): number => Math.atan((frontOf(tip) - frontOf(root)) / semiSpan) * DEG;
  return {
    semiSpan,
    areaPerSide: area,
    mac: chordSquared / area,
    yMac: spanMoment / area,
    xLeMac: xMoment / area,
    sweepLeDeg: angle((s) => s.xLe),
    sweepC4Deg: angle((s) => s.xLe + 0.25 * s.chord),
    sweepTeDeg: angle((s) => s.xLe + s.chord),
    taper: tip.chord / root.chord,
    volumePerSide: volume,
  };
}
