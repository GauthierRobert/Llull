/**
 * Pair kerning from the OpenType `GPOS` table (03 WRP M4, TECHNICAL_SPEC §5.4): the `kern` feature's pair adjustment lookups (type 2, formats 1 and 2, also behind an extension
 * lookup, type 9). The x advance of the first glyph's value record is the kerning, in font units. Scripts and languages are not distinguished (D-WRP-6: single-script
 * layout): every lookup of every `kern` feature applies.
 * @invariant every count and offset is bounds-checked (`ByteView`); the feature and lookup lists are walked once at build, pair data is read on demand and a hostile offset raises `FontError`
 */

import { type ByteView, parseError } from './reader';

const MAX_FEATURES = 256;
const MAX_LOOKUPS = 1024;
const MAX_SUBTABLES = 256;
const X_ADVANCE = 0x0004;

interface PairSubtable {
  readonly view: ByteView;
  readonly offset: number;
  readonly format: 1 | 2;
  readonly format1: number;
  readonly format2: number;
}

const bits = (value: number): number => {
  let count = 0;
  for (let v = value & 0xff; v !== 0; v >>= 1) count += v & 1;
  return count;
};

/** Position of the x advance inside a value record of `format`, or -1 when the format has none. */
const advanceAt = (format: number): number => ((format & X_ADVANCE) === 0 ? -1 : 2 * bits(format & 0x3));

/** Coverage index of `glyph` (0-based), -1 when not covered. */
function coverageIndex(view: ByteView, offset: number, glyph: number): number {
  const format = view.u16(offset);
  const count = view.u16(offset + 2);
  if (format === 1) {
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const at = view.u16(offset + 4 + 2 * mid);
      if (at === glyph) return mid;
      if (at < glyph) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }
  if (format !== 2) throw parseError(`GPOS: coverage format ${format} is not 1 or 2`);
  let low = 0;
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const record = offset + 4 + 6 * mid;
    if (glyph < view.u16(record)) high = mid - 1;
    else if (glyph > view.u16(record + 2)) low = mid + 1;
    else return view.u16(record + 4) + (glyph - view.u16(record));
  }
  return -1;
}

/** Class of `glyph` in a ClassDef table (0 when not listed). */
function classOf(view: ByteView, offset: number, glyph: number): number {
  const format = view.u16(offset);
  if (format === 1) {
    const start = view.u16(offset + 2);
    const count = view.u16(offset + 4);
    return glyph >= start && glyph < start + count ? view.u16(offset + 6 + 2 * (glyph - start)) : 0;
  }
  if (format !== 2) throw parseError(`GPOS: class definition format ${format} is not 1 or 2`);
  const count = view.u16(offset + 2);
  let low = 0;
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const record = offset + 4 + 6 * mid;
    if (glyph < view.u16(record)) high = mid - 1;
    else if (glyph > view.u16(record + 2)) low = mid + 1;
    else return view.u16(record + 4);
  }
  return 0;
}

/** The kerning of one pair subtable: `null` when the subtable says nothing about the pair (the next subtable is tried). */
function pairValue(table: PairSubtable, left: number, right: number): number | null {
  const { view, offset } = table;
  const covered = coverageIndex(view, offset + view.u16(offset + 2), left);
  if (covered < 0) return null;
  const valueSize1 = 2 * bits(table.format1);
  const recordSize = 2 + valueSize1 + 2 * bits(table.format2);
  const at = advanceAt(table.format1);
  if (table.format === 1) {
    const set = offset + view.u16(offset + 10 + 2 * covered);
    const count = view.u16(set);
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const record = set + 2 + recordSize * mid;
      const second = view.u16(record);
      if (second === right) return at < 0 ? 0 : view.i16(record + 2 + at);
      if (second < right) low = mid + 1;
      else high = mid - 1;
    }
    return null;
  }
  const class1 = classOf(view, offset + view.u16(offset + 8), left);
  const class2 = classOf(view, offset + view.u16(offset + 10), right);
  const class1Count = view.u16(offset + 12);
  const class2Count = view.u16(offset + 14);
  if (class1 >= class1Count || class2 >= class2Count) return 0;
  const record = offset + 16 + (class1 * class2Count + class2) * (valueSize1 + 2 * bits(table.format2));
  return at < 0 ? 0 : view.i16(record + at);
}

function subtableAt(view: ByteView, offset: number): PairSubtable | null {
  const format = view.u16(offset);
  if (format !== 1 && format !== 2) return null;
  return { view, offset, format, format1: view.u16(offset + 4), format2: view.u16(offset + 6) };
}

/** The pair subtables of a lookup (type 2, or type 9 pointing at type 2); other lookup types contribute nothing. */
function pairSubtables(view: ByteView, lookup: number): PairSubtable[] {
  const type = view.u16(lookup);
  const count = Math.min(view.u16(lookup + 4), MAX_SUBTABLES);
  const out: PairSubtable[] = [];
  for (let k = 0; k < count; k++) {
    const sub = lookup + view.u16(lookup + 6 + 2 * k);
    if (type === 2) {
      const table = subtableAt(view, sub);
      if (table !== null) out.push(table);
    } else if (type === 9 && view.u16(sub) === 1 && view.u16(sub + 2) === 2) {
      const table = subtableAt(view, sub + view.u32(sub + 4));
      if (table !== null) out.push(table);
    }
  }
  return out;
}

/**
 * Kerning in font units between glyphs `left` and `right`; null `table` or no `kern` feature -> always 0.
 * @failure a feature or lookup list that cannot be walked -> `FontError` WRP_FONT_PARSE at build; a hostile pair offset -> the same error when the pair is first asked
 */
export function buildGposKerning(table: ByteView | null): ((left: number, right: number) => number) | null {
  if (table === null || table.length < 10 || table.u16(0) !== 1) return null;
  const featureList = table.u16(6);
  const lookupList = table.u16(8);
  const featureCount = Math.min(table.u16(featureList), MAX_FEATURES);
  const lookupCount = Math.min(table.u16(lookupList), MAX_LOOKUPS);
  const used = new Set<number>();
  for (let k = 0; k < featureCount; k++) {
    const record = featureList + 2 + 6 * k;
    if (table.ascii(record, 4) !== 'kern') continue;
    const feature = featureList + table.u16(record + 4);
    const indices = table.u16(feature + 2);
    for (let j = 0; j < Math.min(indices, MAX_LOOKUPS); j++) used.add(table.u16(feature + 4 + 2 * j));
  }
  if (used.size === 0) return null;
  const lookups: PairSubtable[][] = [];
  for (const index of [...used].sort((a, b) => a - b)) {
    if (index >= lookupCount) throw parseError(`GPOS: feature points at lookup ${index} of ${lookupCount}`);
    const subtables = pairSubtables(table, lookupList + table.u16(lookupList + 2 + 2 * index));
    if (subtables.length > 0) lookups.push(subtables);
  }
  if (lookups.length === 0) return null;
  const cache = new Map<number, number>();
  return (left, right) => {
    const key = left * 65536 + right;
    const known = cache.get(key);
    if (known !== undefined) return known;
    let total = 0;
    for (const subtables of lookups)
      for (const subtable of subtables) {
        const value = pairValue(subtable, left, right);
        if (value !== null) {
          total += value;
          break;
        }
      }
    cache.set(key, total);
    return total;
  };
}
