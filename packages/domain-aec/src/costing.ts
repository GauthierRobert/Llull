/**
 * @layer domain-aec
 */

import type { TakeoffLine } from './takeoffBasics';

export interface CostLine extends TakeoffLine {
  readonly rate: number | null;
  readonly amount: number | null;
}

/** Rate lookup: exact key, then "<group>.*.<unit>", "<category>.*.<unit>", "*.<material>.<unit>". */
export function rateFor(rates: Readonly<Record<string, number>>, line: TakeoffLine): number | null {
  const candidates = [
    line.key,
    `${line.group}.*.${line.unit}`,
    `${line.category}.*.${line.unit}`,
    `*.${line.material}.${line.unit}`,
  ];
  for (const candidate of candidates) {
    const rate = rates[candidate];
    if (typeof rate === 'number' && Number.isFinite(rate)) return rate;
  }
  return null;
}

export function priceTakeoff(
  takeoff: ReadonlyArray<TakeoffLine>,
  rates: Readonly<Record<string, number>>,
): { lines: CostLine[]; total: number; unpriced: string[] } {
  const lines = takeoff.map((line): CostLine => {
    const rate = rateFor(rates, line);
    return {
      ...line,
      rate,
      amount: rate === null ? null : Math.round(rate * line.quantity * 100) / 100,
    };
  });
  return {
    lines,
    total: Math.round(lines.reduce((sum, line) => sum + (line.amount ?? 0), 0) * 100) / 100,
    unpriced: lines.filter((line) => line.rate === null).map((line) => line.key),
  };
}
