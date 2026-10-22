/**
 * The sfnt container of a TrueType font (03 WRP, TECHNICAL_SPEC §5.4): table directory, `head`, `maxp`, `hhea`, `hmtx`, `OS/2` and `name`.
 * @invariant every table lies inside the file; the table count, glyph count and metric counts are capped
 * @failure not an sfnt / truncated / out-of-range table -> WRP_FONT_PARSE; CFF (OTTO), WOFF, collections -> WRP_FONT_FORMAT_UNSUPPORTED
 */

import { ByteView, FontError, parseError } from './reader';

export const MAX_FONT_BYTES = 4 * 1024 * 1024;
const MAX_TABLES = 64;
const MAX_GLYPHS = 65535;

export interface SfntTables {
  readonly file: ByteView;
  readonly table: (tag: string) => ByteView | null;
}

/** The table directory of `bytes`. */
export function readDirectory(bytes: Uint8Array): SfntTables {
  const file = new ByteView(bytes, 0, bytes.length, 'font');
  if (bytes.length < 12) throw parseError('font: shorter than the 12-byte sfnt header');
  const version = file.u32(0);
  const tag = file.ascii(0, 4);
  if (tag === 'OTTO')
    throw new FontError(
      'WRP_FONT_FORMAT_UNSUPPORTED',
      'font: CFF outlines (OpenType OTTO) are not supported yet; use a TrueType (.ttf) font',
    );
  if (tag === 'wOFF' || tag === 'wOF2')
    throw new FontError('WRP_FONT_FORMAT_UNSUPPORTED', 'font: WOFF files are not supported; use a TrueType (.ttf) font');
  if (tag === 'ttcf') throw new FontError('WRP_FONT_FORMAT_UNSUPPORTED', 'font: TrueType collections are not supported; extract one font');
  if (version !== 0x00010000 && tag !== 'true') throw parseError('font: not an sfnt font (unknown version tag)');
  const count = file.u16(4);
  if (count === 0 || count > MAX_TABLES) throw parseError(`font: ${count} tables (expected 1..${MAX_TABLES})`);
  const tables = new Map<string, ByteView>();
  for (let k = 0; k < count; k++) {
    const record = 12 + 16 * k;
    const name = file.ascii(record, 4);
    tables.set(name, file.sub(file.u32(record + 8), file.u32(record + 12), `table '${name}'`));
  }
  return { file, table: (name) => tables.get(name) ?? null };
}

export function requireTable(tables: SfntTables, name: string): ByteView {
  const table = tables.table(name);
  if (table === null) throw parseError(`font: required table '${name}' is missing`);
  return table;
}

export interface FontHeader {
  readonly unitsPerEm: number;
  readonly longLoca: boolean;
  readonly numGlyphs: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly numberOfHMetrics: number;
}

export function readHeader(tables: SfntTables): FontHeader {
  const head = requireTable(tables, 'head');
  const unitsPerEm = head.u16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw parseError(`head: unitsPerEm ${unitsPerEm} is outside 16..16384`);
  const format = head.i16(50);
  if (format !== 0 && format !== 1) throw parseError(`head: indexToLocFormat ${format} must be 0 or 1`);
  const numGlyphs = requireTable(tables, 'maxp').u16(4);
  if (numGlyphs === 0 || numGlyphs > MAX_GLYPHS) throw parseError(`maxp: ${numGlyphs} glyphs`);
  const hhea = requireTable(tables, 'hhea');
  const numberOfHMetrics = hhea.u16(34);
  if (numberOfHMetrics === 0 || numberOfHMetrics > numGlyphs)
    throw parseError(`hhea: ${numberOfHMetrics} horizontal metrics for ${numGlyphs} glyphs`);
  const hmtx = requireTable(tables, 'hmtx');
  if (hmtx.length < 4 * numberOfHMetrics + 2 * (numGlyphs - numberOfHMetrics))
    throw parseError('hmtx: shorter than its glyph count requires');
  return {
    unitsPerEm,
    longLoca: format === 1,
    numGlyphs,
    ascender: hhea.i16(4),
    descender: hhea.i16(6),
    lineGap: hhea.i16(8),
    numberOfHMetrics,
  };
}

/** Advance width (font units) of glyph `glyph`. */
export function advanceOf(tables: SfntTables, header: FontHeader, glyph: number): number {
  const hmtx = requireTable(tables, 'hmtx');
  return hmtx.u16(4 * Math.min(glyph, header.numberOfHMetrics - 1));
}

export type Embedding = 'installable' | 'editable' | 'preview_print';

export interface FontPermissions {
  readonly fsType: number;
  readonly embedding: Embedding;
  /** OS/2 sCapHeight (font units) when the table has one. */
  readonly capHeight: number | null;
}

/** `OS/2` embedding permission (fsType bits 0..3, bit 9 = bitmap-only) and cap height; a missing table means an unrestricted font without cap height. */
export function readPermissions(tables: SfntTables): FontPermissions {
  const os2 = tables.table('OS/2');
  if (os2 === null) return { fsType: 0, embedding: 'installable', capHeight: null };
  const fsType = os2.u16(8);
  const level = fsType & 0xf;
  if (level === 2)
    throw new FontError('WRP_FONT_EMBEDDING_RESTRICTED', 'OS/2: fsType 2 (restricted license embedding) forbids embedding this font');
  if ((fsType & 0x0200) !== 0)
    throw new FontError('WRP_FONT_EMBEDDING_RESTRICTED', 'OS/2: fsType bit 9 (bitmap embedding only) forbids embedding outlines');
  const embedding: Embedding = level === 8 ? 'editable' : level === 4 ? 'preview_print' : 'installable';
  const version = os2.u16(0);
  const capHeight = version >= 2 && os2.length >= 90 ? os2.i16(88) : null;
  return { fsType, embedding, capHeight: capHeight !== null && capHeight > 0 ? capHeight : null };
}

export interface FontNames {
  readonly family: string;
  readonly style: string;
  readonly licence?: string;
}

/** Name records of a platform: Windows (3) / Unicode (0) strings are UTF-16BE, Macintosh (1) strings ASCII. */
export function readNames(tables: SfntTables): FontNames {
  const name = tables.table('name');
  const found = new Map<number, string>();
  if (name !== null) {
    const count = Math.min(name.u16(2), 512);
    const storage = name.u16(4);
    for (let k = 0; k < count; k++) {
      const record = 6 + 12 * k;
      if (record + 12 > name.length) break;
      const platform = name.u16(record);
      const id = name.u16(record + 6);
      const length = name.u16(record + 8);
      const offset = storage + name.u16(record + 10);
      if (offset + length > name.length || (platform === 1 && found.has(id))) continue;
      const text = platform === 1 ? name.ascii(offset, length) : name.utf16(offset, length);
      if (text.length > 0) found.set(id, text.slice(0, 256));
    }
  }
  const licence = found.get(13);
  return {
    family: found.get(16) ?? found.get(1) ?? 'Unknown',
    style: found.get(17) ?? found.get(2) ?? 'Regular',
    ...(licence !== undefined ? { licence } : {}),
  };
}
