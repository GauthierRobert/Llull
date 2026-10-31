/**
 * The sfnt container of a TrueType font (03 WRP, TECHNICAL_SPEC §5.4): table directory, `head`, `maxp`, `hhea`, `hmtx`, `OS/2` and `name`.
 * @invariant every table lies inside the file; the table count, glyph count and metric counts are capped
 * @failure not an sfnt / truncated / out-of-range table -> WRP_FONT_PARSE; an OpenType font with neither CFF nor CFF2, WOFF, collections -> WRP_FONT_FORMAT_UNSUPPORTED
 */

import { ByteView, FontError, parseError } from './reader';

export const MAX_FONT_BYTES = 4 * 1024 * 1024;
const MAX_TABLES = 64;
const MAX_GLYPHS = 65535;

export interface SfntTables {
  readonly file: ByteView;
  /** Outline flavour: TrueType glyphs (`glyf`) or Compact Font Format (`CFF ` or `CFF2`, an OpenType font with the OTTO tag). */
  readonly flavor: 'truetype' | 'cff';
  readonly table: (tag: string) => ByteView | null;
}

/** The table directory of `bytes`. */
export function readDirectory(bytes: Uint8Array): SfntTables {
  const file = new ByteView(bytes, 0, bytes.length, 'font');
  if (bytes.length < 12) throw parseError('font: shorter than the 12-byte sfnt header');
  const version = file.u32(0);
  const tag = file.ascii(0, 4);
  if (tag === 'wOFF' || tag === 'wOF2')
    throw new FontError('WRP_FONT_FORMAT_UNSUPPORTED', 'font: WOFF files are not supported; use a TrueType (.ttf) font');
  if (tag === 'ttcf') throw new FontError('WRP_FONT_FORMAT_UNSUPPORTED', 'font: TrueType collections are not supported; extract one font');
  if (version !== 0x00010000 && tag !== 'true' && tag !== 'OTTO') throw parseError('font: not an sfnt font (unknown version tag)');
  const count = file.u16(4);
  if (count === 0 || count > MAX_TABLES) throw parseError(`font: ${count} tables (expected 1..${MAX_TABLES})`);
  const tables = new Map<string, ByteView>();
  for (let k = 0; k < count; k++) {
    const record = 12 + 16 * k;
    const name = file.ascii(record, 4);
    tables.set(name, file.sub(file.u32(record + 8), file.u32(record + 12), `table '${name}'`));
  }
  if (tag === 'OTTO' && !tables.has('CFF ') && !tables.has('CFF2'))
    throw new FontError('WRP_FONT_FORMAT_UNSUPPORTED', 'font: an OpenType font without a CFF or CFF2 table is not supported');
  return { file, flavor: tag === 'OTTO' ? 'cff' : 'truetype', table: (name) => tables.get(name) ?? null };
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

/**
 * Advance height (font units) of glyph `glyph` from `vhea` / `vmtx`, or null when the font has no vertical metrics.
 * @failure a `vmtx` shorter than `vhea` says -> WRP_FONT_PARSE
 */
export function verticalAdvanceOf(tables: SfntTables, header: FontHeader, glyph: number): number | null {
  const vhea = tables.table('vhea');
  const vmtx = tables.table('vmtx');
  if (vhea === null || vmtx === null) return null;
  const count = vhea.u16(34);
  if (count === 0 || count > header.numGlyphs) throw parseError(`vhea: ${count} vertical metrics for ${header.numGlyphs} glyphs`);
  if (vmtx.length < 4 * count + 2 * (header.numGlyphs - count)) throw parseError('vmtx: shorter than its glyph count requires');
  return vmtx.u16(4 * Math.min(glyph, count - 1));
}

/**
 * Vertical origin y (font units, above the baseline) of glyph `glyph` from the `VORG` table of a CFF font: the record of the glyph, else `defaultVertOriginY`; null when the font has no `VORG`.
 * @failure a version other than 1.0, a table shorter than its header or its records -> WRP_FONT_PARSE
 */
export function verticalOriginOf(tables: SfntTables, glyph: number): number | null {
  const vorg = tables.table('VORG');
  if (vorg === null) return null;
  if (vorg.length < 8) throw parseError('VORG: shorter than its 8-byte header');
  if (vorg.u16(0) !== 1 || vorg.u16(2) !== 0) throw parseError(`VORG: version ${vorg.u16(0)}.${vorg.u16(2)} is not 1.0`);
  const count = vorg.u16(6);
  if (vorg.length < 8 + 4 * count) throw parseError('VORG: shorter than its record count requires');
  let low = 0;
  let high = count - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const found = vorg.u16(8 + 4 * middle);
    if (found === glyph) return vorg.i16(10 + 4 * middle);
    if (found < glyph) low = middle + 1;
    else high = middle - 1;
  }
  return vorg.i16(4);
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

/** Language preference of a name record: Windows English (0x0409, or the unset language 0 of a careless font), then Unicode, then Macintosh English, then any other Windows language, any other Macintosh one, the rest. */
function nameRank(platform: number, language: number): number {
  if (platform === 3) return language === 0x0409 || language === 0 ? 0 : 3;
  if (platform === 0) return 1;
  if (platform === 1) return language === 0 ? 2 : 4;
  return 5;
}

const MAX_NAME_RECORDS = 65_535;
const MAX_STRINGS_PER_ID = 16;

/**
 * The strings of the `name` table by name id, every language, the preferred one first (Windows English, then Unicode, then Macintosh English, then the others in table order), each at most 256
 * characters and at most 16 per id. Windows (3) / Unicode (0) strings are UTF-16BE, Macintosh (1) strings ASCII; records outside the table are skipped.
 */
export function readNameStrings(tables: SfntTables): ReadonlyMap<number, readonly string[]> {
  const name = tables.table('name');
  const ranked = new Map<number, Array<{ rank: number; text: string }>>();
  if (name !== null) {
    const count = Math.min(name.u16(2), MAX_NAME_RECORDS);
    const storage = name.u16(4);
    for (let k = 0; k < count; k++) {
      const record = 6 + 12 * k;
      if (record + 12 > name.length) break;
      const platform = name.u16(record);
      const language = name.u16(record + 4);
      const id = name.u16(record + 6);
      const length = name.u16(record + 8);
      const offset = storage + name.u16(record + 10);
      if (offset + length > name.length) continue;
      const text = (platform === 1 ? name.ascii(offset, length) : name.utf16(offset, length)).slice(0, 256);
      const list = ranked.get(id) ?? [];
      if (text.length === 0 || list.length >= MAX_STRINGS_PER_ID || list.some((entry) => entry.text === text)) continue;
      list.push({ rank: nameRank(platform, language), text });
      ranked.set(id, list);
    }
  }
  return new Map([...ranked].map(([id, list]) => [id, [...list].sort((x, y) => x.rank - y.rank).map((entry) => entry.text)]));
}

/** The family, style and licence of the font. */
export function readNames(tables: SfntTables): FontNames {
  const found = readNameStrings(tables);
  const first = (id: number): string | undefined => found.get(id)?.[0];
  const licence = first(13);
  return {
    family: first(16) ?? first(1) ?? 'Unknown',
    style: first(17) ?? first(2) ?? 'Regular',
    ...(licence !== undefined ? { licence } : {}),
  };
}
