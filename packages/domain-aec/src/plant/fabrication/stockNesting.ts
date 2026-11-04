/**
 * Stock-length nesting of a cut list (plant 05 ISO §5.6, V1): the cut pieces of one pipe type (item code and bore) are packed into stock bars of the lengths the user
 * gives (6 m / 12 m random lengths). First-fit decreasing: pieces by decreasing cut length (ties by piece name), each into the first open bar it fits, else a new bar of
 * the shortest stock length (at least the opening length) that holds it; then every bar shrinks to the shortest stock length that holds its pieces. The packing runs once per
 * opening length (every stock length given) and keeps the one with the least stock, then the fewest bars (so 6 m + 12 m stock can use a 12 m bar for three long pieces). Every piece costs one saw kerf (the cut that frees
 * it), so a bar holds `sum(cut) + n x kerf <= stock length`. Deterministic: same pieces and stock lengths, same bars. Pure.
 */

import type { CutPiece } from './cutList';

export interface NestedBar {
  readonly bar: string;
  readonly stockLengthMm: number;
  readonly pieces: readonly string[];
  /** Sum of the cut lengths on the bar, mm. */
  readonly cutMm: number;
  /** Stock left over after the pieces and their kerfs, mm. */
  readonly offcutMm: number;
}

export interface NestedGroup {
  readonly itemCode: string | null;
  readonly boreMm: number;
  readonly bars: readonly NestedBar[];
  readonly stockMm: number;
  readonly cutMm: number;
  readonly wastePercent: number;
}

export interface Nesting {
  readonly stockLengthsMm: readonly number[];
  readonly kerfMm: number;
  readonly groups: readonly NestedGroup[];
  readonly totalBars: number;
  /** Number of bars by stock length, e.g. { "6000": 2, "12000": 1 }. */
  readonly barsByLength: Readonly<Record<string, number>>;
  readonly stockMm: number;
  readonly cutMm: number;
  readonly wastePercent: number;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const percent = (waste: number, stock: number): number => (stock === 0 ? 0 : Math.round((waste / stock) * 1e6) / 1e4);

/** The pieces no stock length can hold (cut + kerf longer than the longest bar). */
export const tooLong = (pieces: readonly CutPiece[], stockLengthsMm: readonly number[], kerfMm: number): CutPiece[] =>
  pieces.filter((piece) => piece.cutLengthMm + kerfMm > Math.max(...stockLengthsMm));

export function nestPieces(pieces: readonly CutPiece[], stockLengthsMm: readonly number[], kerfMm: number): Nesting {
  const stocks = [...new Set(stockLengthsMm)].sort((a, b) => a - b);
  const keys = new Map<string, CutPiece[]>();
  for (const piece of pieces) {
    const key = `${piece.itemCode ?? ''}\u0000${piece.boreMm}`;
    keys.set(key, [...(keys.get(key) ?? []), piece]);
  }
  const pack = (members: readonly CutPiece[], opening: number): NestedBar[] => {
    const ordered = [...members].sort((a, b) => b.cutLengthMm - a.cutLengthMm || (a.piece < b.piece ? -1 : a.piece > b.piece ? 1 : 0));
    const open: Array<{ capacity: number; used: number; pieces: CutPiece[] }> = [];
    for (const piece of ordered) {
      const need = piece.cutLengthMm + kerfMm;
      const bar = open.find((candidate) => candidate.used + need <= candidate.capacity + 1e-9);
      if (bar !== undefined) {
        bar.used += need;
        bar.pieces.push(piece);
      } else
        open.push({
          capacity: stocks.find((stock) => stock >= Math.max(need, opening)) ?? (stocks[stocks.length - 1] as number),
          used: need,
          pieces: [piece],
        });
    }
    return open.map((bar, index) => {
      const stock = stocks.find((candidate) => candidate >= bar.used - 1e-9) ?? bar.capacity;
      const cut = bar.pieces.reduce((sum, piece) => sum + piece.cutLengthMm, 0);
      return {
        bar: `B${index + 1}`,
        stockLengthMm: stock,
        pieces: bar.pieces.map((piece) => piece.piece),
        cutMm: round6(cut),
        offcutMm: round6(stock - bar.used),
      };
    });
  };
  const groups: NestedGroup[] = [...keys.values()].map((members) => {
    const plans = stocks.map((opening) => pack(members, opening));
    const stockOf = (bars: readonly NestedBar[]): number => bars.reduce((sum, bar) => sum + bar.stockLengthMm, 0);
    const bars = plans.reduce((best, plan) =>
      stockOf(plan) < stockOf(best) || (stockOf(plan) === stockOf(best) && plan.length < best.length) ? plan : best,
    );
    const stockMm = stockOf(bars);
    const cutMm = round6(bars.reduce((sum, bar) => sum + bar.cutMm, 0));
    const first = members[0] as CutPiece;
    return { itemCode: first.itemCode, boreMm: first.boreMm, bars, stockMm, cutMm, wastePercent: percent(stockMm - cutMm, stockMm) };
  });
  const barsByLength: Record<string, number> = {};
  for (const bar of groups.flatMap((group) => group.bars))
    barsByLength[String(bar.stockLengthMm)] = (barsByLength[String(bar.stockLengthMm)] ?? 0) + 1;
  const stockMm = groups.reduce((sum, group) => sum + group.stockMm, 0);
  const cutMm = round6(groups.reduce((sum, group) => sum + group.cutMm, 0));
  return {
    stockLengthsMm: stocks,
    kerfMm,
    groups,
    totalBars: groups.reduce((sum, group) => sum + group.bars.length, 0),
    barsByLength,
    stockMm,
    cutMm,
    wastePercent: percent(stockMm - cutMm, stockMm),
  };
}
