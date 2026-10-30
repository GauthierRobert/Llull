/**
 * INDEX and DICT structures of the Compact Font Format, versions 1 and 2 (03 WRP M4, TECHNICAL_SPEC §5.4 and §5.5).
 * @invariant every offset is checked against the table, an INDEX holds at most 262 144 entries, a DICT operand is a number and an operator a known byte
 * @failure unordered or out-of-table INDEX offsets, an unknown DICT byte -> WRP_FONT_PARSE
 */

import { type ByteView, parseError } from './reader';

const MAX_INDEX_ENTRIES = 262_144;

export interface Index {
  readonly count: number;
  /** Absolute [start, end) of each entry in the CFF table. */
  readonly entries: ReadonlyArray<readonly [number, number]>;
  /** Offset just past the INDEX. */
  readonly end: number;
}

/** An INDEX at `offset`; CFF2 counts its entries with 4 bytes (`wide`), CFF 1.x with 2. */
export function readIndex(table: ByteView, offset: number, wide: boolean): Index {
  const count = wide ? table.u32(offset) : table.u16(offset);
  const head = wide ? 4 : 2;
  if (count === 0) return { count: 0, entries: [], end: offset + head };
  if (count > MAX_INDEX_ENTRIES) throw parseError(`CFF: an INDEX of ${count} entries exceeds ${MAX_INDEX_ENTRIES}`);
  const offSize = table.u8(offset + head);
  if (offSize < 1 || offSize > 4) throw parseError(`CFF: INDEX offset size ${offSize} is not 1..4`);
  const offsetAt = (k: number): number => {
    let value = 0;
    for (let b = 0; b < offSize; b++) value = value * 256 + table.u8(offset + head + 1 + k * offSize + b);
    return value;
  };
  const base = offset + head + 1 + (count + 1) * offSize - 1;
  const entries: Array<readonly [number, number]> = [];
  let previous = offsetAt(0);
  if (previous !== 1) throw parseError('CFF: the first INDEX offset must be 1');
  for (let k = 1; k <= count; k++) {
    const next = offsetAt(k);
    if (next < previous || base + next > table.length) throw parseError('CFF: INDEX offsets are not ordered inside the table');
    entries.push([base + previous, base + next]);
    previous = next;
  }
  return { count, entries, end: base + previous };
}

/**
 * Operands of each operator of a DICT; a two-byte operator 12 n is keyed 1200 + n. CFF2 DICTs also know the operators 22 (vsindex), 23 (blend: its operands are
 * dropped, no value this reader needs is blended) and 24 (vstore).
 */
export function readDict(table: ByteView, start: number, end: number, version: 1 | 2): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  const lastOperator = version === 2 ? 24 : 21;
  let operands: number[] = [];
  let i = start;
  while (i < end) {
    const b0 = table.u8(i++);
    if (b0 <= lastOperator) {
      const key = b0 === 12 ? 1200 + table.u8(i++) : b0;
      if (key !== 23) dict.set(key, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(table.i16(i));
      i += 2;
    } else if (b0 === 29) {
      operands.push(table.u32(i) | 0);
      i += 4;
    } else if (b0 === 30) {
      let text = '';
      for (let done = false; !done && i < end; ) {
        const byte = table.u8(i++);
        for (const nibble of [byte >> 4, byte & 15]) {
          if (nibble === 15) {
            done = true;
            break;
          }
          text +=
            nibble < 10 ? String(nibble) : nibble === 10 ? '.' : nibble === 11 ? 'E' : nibble === 12 ? 'E-' : nibble === 14 ? '-' : '';
        }
      }
      operands.push(Number.parseFloat(text) || 0);
    } else if (b0 >= 32 && b0 <= 246) operands.push(b0 - 139);
    else if (b0 >= 247 && b0 <= 250) operands.push((b0 - 247) * 256 + table.u8(i++) + 108);
    else if (b0 >= 251 && b0 <= 254) operands.push(-(b0 - 251) * 256 - table.u8(i++) - 108);
    else throw parseError(`CFF: DICT byte ${b0} is not an operator or operand`);
  }
  return dict;
}
