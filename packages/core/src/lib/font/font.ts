/**
 * A parsed TrueType font (03 WRP M1): metrics, embedding permission, names and lazy glyph access over the original bytes.
 * @invariant parsing validates every table once; `parseFont` never throws (errors come back as `{ ok: false, code }`) and reads only inside `bytes`
 * @failure not a font / truncated / out-of-range table -> WRP_FONT_PARSE; CFF2, WOFF, collections -> WRP_FONT_FORMAT_UNSUPPORTED; fsType restricted ->
 *   WRP_FONT_EMBEDDING_RESTRICTED; over 4 MB -> WRP_FONT_TOO_LARGE
 */

import { readCff } from './cff';
import { buildCmap } from './cmap';
import { glyphContours, type GlyphSource } from './glyf';
import { buildGposKerning } from './gpos';
import { buildKerning } from './kern';
import { isStrokeFont, readStrokeFont } from './stroke';
import type { Vec2 } from '../../model/vectors';
import { contourLoop, loopBox, type OutlineLoop } from './outline';
import { FontError, type FontErrorCode } from './reader';
import {
  advanceOf,
  MAX_FONT_BYTES,
  readDirectory,
  readHeader,
  readNames,
  readPermissions,
  requireTable,
  type Embedding,
  type FontNames,
} from './sfnt';

export { MAX_FONT_BYTES };

/** Points over all glyphs (composites expanded) a font may hold: a total budget on top of the per-glyph one. */
const MAX_FONT_POINTS = 5_000_000;

export interface ParsedFont {
  /** truetype: quadratic `glyf` outlines; cff: cubic Compact Font Format outlines; stroke: the open-stroke engraving format of llull (`singleLine`). */
  readonly format: 'truetype' | 'cff' | 'stroke';
  /** Glyphs are open strokes (no closed outlines): engraved, never filled. */
  readonly singleLine: boolean;
  /** Strokes of a glyph in font units, y up; empty for outline fonts. */
  readonly strokes: (glyph: number) => readonly (readonly Vec2[])[];
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  /** Cap height in font units and where it came from (OS/2 sCapHeight, else the height of the outline of 'H'). */
  readonly capHeight: number;
  readonly capHeightSource: 'os2' | 'glyph_H' | 'declared';
  readonly embedding: Embedding;
  readonly names: FontNames;
  /** Glyph index of a code point; 0 (`.notdef`) when the font has none. */
  readonly glyphIndex: (codePoint: number) => number;
  readonly advance: (glyph: number) => number;
  /** Pair kerning in font units (GPOS `kern` feature, else the legacy `kern` table; 0 without a pair). */
  readonly kerning: (left: number, right: number) => number;
  /** Closed loops of a glyph in font units, y up (outer loops clockwise); empty for a blank glyph. */
  readonly outline: (glyph: number) => readonly OutlineLoop[];
  /** Reads every glyph once without keeping it; throws `FontError` for a hostile glyph. */
  readonly scanGlyphs: () => void;
}

export type FontParse =
  | { readonly ok: true; readonly font: ParsedFont }
  | { readonly ok: false; readonly code: FontErrorCode; readonly message: string };

function buildStroke(bytes: Uint8Array): ParsedFont {
  const font = readStrokeFont(bytes);
  return {
    format: 'stroke',
    singleLine: true,
    strokes: font.strokes,
    unitsPerEm: font.unitsPerEm,
    numGlyphs: font.glyphCount,
    ascender: font.ascender,
    descender: font.descender,
    lineGap: font.lineGap,
    capHeight: font.capHeight,
    capHeightSource: 'declared',
    embedding: 'installable',
    names: font.names,
    glyphIndex: font.glyphIndex,
    advance: font.advance,
    kerning: () => 0,
    outline: () => [],
    scanGlyphs: () => undefined,
  };
}

function build(bytes: Uint8Array): ParsedFont {
  if (bytes.length > MAX_FONT_BYTES)
    throw new FontError('WRP_FONT_TOO_LARGE', `font: ${bytes.length} bytes exceed the ${MAX_FONT_BYTES}-byte limit`);
  if (isStrokeFont(bytes)) return buildStroke(bytes);
  const tables = readDirectory(bytes);
  const header = readHeader(tables);
  const permissions = readPermissions(tables);
  const cff = tables.flavor === 'cff' ? readCff(requireTable(tables, 'CFF ')) : null;
  const source: GlyphSource | null =
    cff === null
      ? { glyf: requireTable(tables, 'glyf'), loca: requireTable(tables, 'loca'), longLoca: header.longLoca, numGlyphs: header.numGlyphs }
      : null;
  if (source !== null && source.loca.length < (header.numGlyphs + 1) * (header.longLoca ? 4 : 2))
    throw new FontError('WRP_FONT_PARSE', 'loca: shorter than its glyph count requires');
  const glyphIndex = buildCmap(requireTable(tables, 'cmap'), header.numGlyphs);
  const cache = new Map<number, readonly OutlineLoop[]>();
  const loopsOf = (glyph: number): readonly OutlineLoop[] =>
    cff !== null ? cff.outline(glyph) : glyphContours(source as GlyphSource, glyph).map(contourLoop);
  const outline = (glyph: number): readonly OutlineLoop[] => {
    let loops = cache.get(glyph);
    if (loops === undefined) {
      loops = loopsOf(glyph);
      cache.set(glyph, loops);
    }
    return loops;
  };
  let capHeight = permissions.capHeight;
  let capHeightSource: ParsedFont['capHeightSource'] = 'os2';
  if (capHeight === null) {
    const top = outline(glyphIndex(0x48))
      .map((loop) => loopBox(loop)?.max[1] ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    if (!(top > 0)) throw new FontError('WRP_FONT_PARSE', "font: no OS/2 sCapHeight and no outline for 'H' to measure the cap height from");
    capHeight = top;
    capHeightSource = 'glyph_H';
  }
  return {
    format: tables.flavor,
    singleLine: false,
    strokes: () => [],
    unitsPerEm: header.unitsPerEm,
    numGlyphs: header.numGlyphs,
    ascender: header.ascender,
    descender: header.descender,
    lineGap: header.lineGap,
    capHeight,
    capHeightSource,
    embedding: permissions.embedding,
    names: readNames(tables),
    glyphIndex,
    advance: (glyph) => advanceOf(tables, header, glyph),
    kerning: buildGposKerning(tables.table('GPOS')) ?? buildKerning(tables.table('kern')),
    outline,
    scanGlyphs: () => {
      let points = 0;
      for (let glyph = 0; glyph < header.numGlyphs; glyph++) {
        points +=
          cff !== null
            ? cff.outline(glyph).reduce((sum, loop) => sum + loop.length, 0)
            : glyphContours(source as GlyphSource, glyph).reduce((sum, contour) => sum + contour.length, 0);
        if (points > MAX_FONT_POINTS) throw new FontError('WRP_FONT_PARSE', `glyf: more than ${MAX_FONT_POINTS} points in the whole font`);
      }
    },
  };
}

/** Parse `bytes`; see the module comment for the failure codes. Glyph outlines are read on first use and may then throw `FontError` for a hostile glyph. */
export function parseFont(bytes: Uint8Array): FontParse {
  try {
    return { ok: true, font: build(bytes) };
  } catch (error) {
    if (error instanceof FontError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'WRP_FONT_PARSE', message: `font: ${error instanceof Error ? error.message : 'unreadable'}` };
  }
}

/** Parse every glyph once (import-time validation: a hostile glyph is found before the font is stored). */
export function validateGlyphs(
  font: ParsedFont,
): { readonly ok: true } | { readonly ok: false; readonly code: FontErrorCode; readonly message: string } {
  try {
    font.scanGlyphs();
    return { ok: true };
  } catch (error) {
    if (error instanceof FontError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'WRP_FONT_PARSE', message: `font: ${error instanceof Error ? error.message : 'unreadable'}` };
  }
}
