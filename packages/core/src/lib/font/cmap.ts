/** `cmap` lookup (formats 4 and 12) of a TrueType font: code point -> glyph index, 0 = no glyph (03 WRP, TECHNICAL_SPEC §5.4). */

import { type ByteView, parseError } from './reader';

type Lookup = (codePoint: number) => number;

interface Subtable {
  readonly platform: number;
  readonly encoding: number;
  readonly offset: number;
  readonly format: number;
}

function format12(table: ByteView, offset: number): Lookup {
  const groups = table.u32(offset + 12);
  if (16 + 12 * groups > table.length - offset) throw parseError('cmap: format 12 group count runs past the subtable');
  return (codePoint) => {
    let low = 0;
    let high = groups - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const group = offset + 16 + 12 * mid;
      if (codePoint < table.u32(group)) high = mid - 1;
      else if (codePoint > table.u32(group + 4)) low = mid + 1;
      else return table.u32(group + 8) + (codePoint - table.u32(group));
    }
    return 0;
  };
}

function format4(table: ByteView, offset: number): Lookup {
  const segmentsX2 = table.u16(offset + 6);
  const segments = segmentsX2 >> 1;
  if (segments === 0 || segmentsX2 % 2 !== 0) throw parseError('cmap: format 4 segment count is not a positive integer');
  const ends = offset + 14;
  const starts = ends + segmentsX2 + 2;
  const deltas = starts + segmentsX2;
  const ranges = deltas + segmentsX2;
  if (ranges + segmentsX2 > table.length) throw parseError('cmap: format 4 arrays run past the subtable');
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let segment = 0; segment < segments; segment++) {
      if (codePoint > table.u16(ends + 2 * segment)) continue;
      if (codePoint < table.u16(starts + 2 * segment)) return 0;
      const delta = table.i16(deltas + 2 * segment);
      const rangeOffset = table.u16(ranges + 2 * segment);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const at = ranges + 2 * segment + rangeOffset + 2 * (codePoint - table.u16(starts + 2 * segment));
      if (at + 2 > table.length) return 0;
      const glyph = table.u16(at);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

/**
 * The lookup of the best Unicode subtable (UCS-4 format 12 first). A glyph id the font does not have (>= numGlyphs) maps to 0, the missing glyph.
 * @failure no Unicode format 4 / 12 subtable -> WRP_FONT_PARSE
 */
export function buildCmap(table: ByteView, numGlyphs: number): Lookup {
  const raw = rawCmap(table);
  return (codePoint) => {
    const glyph = raw(codePoint);
    return glyph < numGlyphs ? glyph : 0;
  };
}

function rawCmap(table: ByteView): Lookup {
  const count = Math.min(table.u16(2), 64);
  const subtables: Subtable[] = [];
  for (let k = 0; k < count; k++) {
    const record = 4 + 8 * k;
    const offset = table.u32(record + 4);
    if (offset + 4 > table.length) continue;
    subtables.push({ platform: table.u16(record), encoding: table.u16(record + 2), offset, format: table.u16(offset) });
  }
  const unicode = (subtable: Subtable): boolean =>
    subtable.platform === 0 || (subtable.platform === 3 && (subtable.encoding === 1 || subtable.encoding === 10));
  const wide = subtables.find((subtable) => subtable.format === 12 && unicode(subtable));
  if (wide !== undefined) return format12(table, wide.offset);
  const narrow = subtables.find((subtable) => subtable.format === 4 && unicode(subtable));
  if (narrow !== undefined) return format4(table, narrow.offset);
  throw parseError('cmap: no Unicode subtable of format 4 or 12');
}
