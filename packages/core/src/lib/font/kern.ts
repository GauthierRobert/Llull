/** Pair kerning from the legacy `kern` table (format 0, horizontal subtables); GPOS pair adjustment is a later milestone (TECHNICAL_SPEC §5.4). */

import type { ByteView } from './reader';

const MAX_SUBTABLES = 8;

interface KernSubtable {
  readonly offset: number;
  readonly pairs: number;
}

/** Kerning in font units between glyphs `left` and `right` (0 when the table has no pair); null `table` -> always 0. */
export function buildKerning(table: ByteView | null): (left: number, right: number) => number {
  if (table === null || table.length < 4 || table.u16(0) !== 0) return () => 0;
  const subtables: KernSubtable[] = [];
  let at = 4;
  for (let k = 0, count = Math.min(table.u16(2), MAX_SUBTABLES); k < count; k++) {
    if (at + 14 > table.length) break;
    const length = table.u16(at + 2);
    const coverage = table.u16(at + 4);
    const pairs = table.u16(at + 6);
    const horizontal = (coverage & 1) !== 0 && (coverage & 4) === 0 && (coverage & 0xff00) === 0;
    if (horizontal && at + 14 + 6 * pairs <= table.length) subtables.push({ offset: at + 14, pairs });
    if (length < 14) break;
    at += length;
  }
  return (left, right) => {
    let total = 0;
    for (const { offset, pairs } of subtables) {
      const key = left * 65536 + right;
      let low = 0;
      let high = pairs - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const record = offset + 6 * mid;
        const found = table.u16(record) * 65536 + table.u16(record + 2);
        if (found === key) {
          total += table.i16(record + 4);
          break;
        }
        if (found < key) low = mid + 1;
        else high = mid - 1;
      }
    }
    return total;
  };
}
