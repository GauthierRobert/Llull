/**
 * A parsed TrueType font (03 WRP M1): metrics, embedding permission, names and lazy glyph access over the original bytes.
 * @invariant parsing validates every table once; `parseFont` never throws (errors come back as `{ ok: false, code }`) and reads only inside `bytes`
 * @failure not a font / truncated / out-of-range table -> WRP_FONT_PARSE; WOFF, collections -> WRP_FONT_FORMAT_UNSUPPORTED; a variation the font cannot take -> WRP_FONT_VARIATION; fsType restricted ->
 *   WRP_FONT_EMBEDDING_RESTRICTED; over 4 MB -> WRP_FONT_TOO_LARGE
 */

import { readCff } from './cff';
import { FONT_OPERATOR_BUDGET } from './type2';
import { buildCmap } from './cmap';
import { glyphContours, phantomAdvanceDeltas, type GlyphSource } from './glyf';
import { readGvar } from './gvar';
import { readMetricDeltas } from './mvar';
import { buildGposKerning } from './gpos';
import { buildKerning } from './kern';
import { isStrokeFont, readStrokeFont } from './stroke';
import {
  readAdvanceDeltas,
  readTopSideBearingDeltas,
  readVariationSpace,
  readVerticalAdvanceDeltas,
  type AxisValues,
  type VariationAxis,
} from './variation';
import type { Vec2 } from '../../model/vectors';
import { contourLoop, loopBox, type OutlineLoop } from './outline';
import { FontError, type FontErrorCode } from './reader';
import {
  advanceOf,
  MAX_FONT_BYTES,
  readDirectory,
  readHeader,
  readNames,
  readNameStrings,
  readPermissions,
  requireTable,
  verticalAdvanceOf,
  topSideBearingOf,
  verticalLineOf,
  verticalOriginOf,
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
  /** The named instances of `fvar` with a name in the `name` table, in `fvar` order: what `instance` (import_font) picks by name. */
  readonly namedInstances: readonly NamedInstance[];
  /** Why instance records of `fvar` were left out (a value outside its axis, an unreadable record table); the font is still usable. */
  readonly namedInstanceProblems: readonly string[];
  /** Variation axes of the font (`fvar`), empty for a static font. */
  readonly axes: readonly VariationAxis[];
  /** The instance this font was read at: the axes that differ from their default, in tag order (empty = the default instance). */
  readonly instance: Readonly<Record<string, number>>;
  /** Advance height in font units (`vmtx` + `VVAR`, or the phantom points of a gvar font; ascender - descender without vertical metrics). */
  readonly verticalAdvance: (glyph: number) => number;
  /**
   * Where the glyph hangs in vertical text: y of its vertical origin above the baseline (font units). `VORG` for a CFF font that has one; else, for a font with `vmtx`, the top of the glyph (control-point yMax)
   * plus its top side bearing (moved by the `VVAR` bearing map, or by the top phantom point of a gvar font without `VVAR`); else (and for a blank glyph) the ascender. The horizontal origin is the middle of the advance width.
   */
  readonly verticalOrigin: (glyph: number) => { readonly y: number; readonly source: 'VORG' | 'vmtx' | 'ascender' };
  /** Line pitch of vertical text in font units: `vhea` typographic ascender - descender + line gap (moved by MVAR vasc / vdsc / vlgp), else the horizontal line height. */
  readonly verticalLine: { readonly height: number; readonly source: 'vhea' | 'hhea' };
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

/** A named instance of a variable font: its subfamily name (e.g. `Bold`), its PostScript name when the font gives one, and the design value of every axis. */
export interface NamedInstance {
  readonly name: string;
  readonly postScriptName: string | null;
  readonly variation: Readonly<Record<string, number>>;
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

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
    axes: [],
    namedInstances: [],
    namedInstanceProblems: [],
    instance: {},
    glyphIndex: font.glyphIndex,
    advance: font.advance,
    verticalAdvance: () => font.ascender - font.descender,
    verticalOrigin: () => ({ y: font.ascender, source: 'ascender' }),
    verticalLine: { height: font.ascender - font.descender + font.lineGap, source: 'hhea' },
    kerning: () => 0,
    outline: () => [],
    scanGlyphs: () => undefined,
  };
}

function build(bytes: Uint8Array, asked: AxisValues, instanceName: string | undefined): ParsedFont {
  if (bytes.length > MAX_FONT_BYTES)
    throw new FontError('WRP_FONT_TOO_LARGE', `font: ${bytes.length} bytes exceed the ${MAX_FONT_BYTES}-byte limit`);
  if (isStrokeFont(bytes)) return buildStroke(bytes);
  const tables = readDirectory(bytes);
  const header = readHeader(tables);
  const permissions = readPermissions(tables);
  const space = readVariationSpace(tables.table('fvar'), tables.table('avar'));
  const strings = readNameStrings(tables);
  // a name is matched in every language of the name table (a localised record never hides the English one), listed in the preferred language
  const namedInstances: NamedInstance[] = [];
  const languages = new Map<NamedInstance, readonly string[]>();
  for (const record of space?.instances ?? []) {
    const names = strings.get(record.subfamilyNameId);
    if (names === undefined) continue;
    const postScript = record.postScriptNameId === null ? undefined : strings.get(record.postScriptNameId);
    const instance: NamedInstance = { name: names[0] as string, postScriptName: postScript?.[0] ?? null, variation: record.coordinates };
    namedInstances.push(instance);
    languages.set(instance, [...names, ...(postScript ?? [])]);
  }
  let variation = asked;
  if (instanceName !== undefined) {
    if (Object.keys(asked).length > 0)
      throw new FontError('WRP_FONT_VARIATION', 'variation: give the axis values or a named instance, not both');
    const found = namedInstances.find((candidate) => (languages.get(candidate) ?? []).some((text) => sameName(text, instanceName)));
    if (found === undefined)
      throw new FontError(
        'WRP_FONT_VARIATION',
        `variation: the font has no named instance '${instanceName}' (named instances: ${namedInstances.map((candidate) => candidate.name).join(', ') || 'none'})`,
      );
    variation = found.variation;
  }
  const cffTable = tables.flavor === 'cff' ? (tables.table('CFF ') ?? requireTable(tables, 'CFF2')) : null;
  const variable = cffTable !== null && cffTable.u8(0) === 2;
  const gvarTable = cffTable === null ? tables.table('gvar') : null;
  const variableGlyf = gvarTable !== null && space !== null;
  const varying = variable || variableGlyf;
  if (Object.keys(variation).length > 0 && space === null)
    throw new FontError('WRP_FONT_VARIATION', 'variation: the font has no variation axes (no fvar table)');
  const instance = space === null ? {} : space.instance(variation);
  if (Object.keys(instance).length > 0 && !varying)
    throw new FontError(
      'WRP_FONT_VARIATION',
      'variation: only CFF2 and TrueType gvar variable fonts can be instanced (CFF 1.x and TrueType fonts without gvar have no variation data)',
    );
  const coords = space === null || !varying ? [] : space.coordinates(variation);
  const moved = !coords.every((coord) => coord === 0);
  const cff = cffTable === null ? null : readCff(cffTable, coords);
  const hvar = varying ? tables.table('HVAR') : null;
  const advanceDelta = hvar === null || !moved ? null : readAdvanceDeltas(hvar, coords);
  const mvar = varying && moved ? tables.table('MVAR') : null;
  const metricDeltas = mvar === null ? new Map<string, number>() : readMetricDeltas(mvar, coords);
  const metric = (tag: string): number => Math.round(metricDeltas.get(tag) ?? 0);
  const vvar = varying ? tables.table('VVAR') : null;
  const verticalDelta = vvar === null || !moved ? null : readVerticalAdvanceDeltas(vvar, coords);
  const bearingDelta = vvar === null || !moved ? null : readTopSideBearingDeltas(vvar, coords);
  const advances = new Map<number, number>();
  const heights = new Map<number, number>();
  const advanceWork = { remaining: FONT_OPERATOR_BUDGET };
  const phantoms = new Map<number, ReturnType<typeof phantomAdvanceDeltas>>();
  const source: GlyphSource | null =
    cff === null
      ? {
          glyf: requireTable(tables, 'glyf'),
          loca: requireTable(tables, 'loca'),
          longLoca: header.longLoca,
          numGlyphs: header.numGlyphs,
          ...(moved && gvarTable !== null && space !== null
            ? { variation: { gvar: readGvar(gvarTable, header.numGlyphs, space.axes.length), coords } }
            : {}),
        }
      : null;
  if (source !== null && source.loca.length < (header.numGlyphs + 1) * (header.longLoca ? 4 : 2))
    throw new FontError('WRP_FONT_PARSE', 'loca: shorter than its glyph count requires');
  const glyphIndex = buildCmap(requireTable(tables, 'cmap'), header.numGlyphs);
  /** The phantom-point advance variations of a glyph (one read per glyph, charged to one budget for the font). */
  const phantomsOf = (glyph: number): ReturnType<typeof phantomAdvanceDeltas> => {
    let known = phantoms.get(glyph);
    if (known === undefined) {
      known = phantomAdvanceDeltas(source as GlyphSource, glyph, advanceWork);
      phantoms.set(glyph, known);
    }
    return known;
  };
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
  /** Highest control point of a glyph (the yMax of its header for TrueType, of its charstring for CFF) at the instance, or at the default instance with `atDefault`; null for a blank glyph. */
  const pointsTop = (glyph: number, atDefault: boolean): number | null => {
    const ys =
      cff !== null
        ? cff
            .outline(glyph)
            .flatMap((loop) =>
              loop.flatMap((segment) =>
                segment.kind === 'line'
                  ? [segment.from[1], segment.to[1]]
                  : segment.kind === 'quad'
                    ? [segment.from[1], segment.control[1], segment.to[1]]
                    : [segment.from[1], segment.control1[1], segment.control2[1], segment.to[1]],
              ),
            )
        : glyphContours(
            atDefault && source?.variation !== undefined
              ? { glyf: source.glyf, loca: source.loca, longLoca: source.longLoca, numGlyphs: source.numGlyphs }
              : (source as GlyphSource),
            glyph,
          ).flatMap((contour) => contour.map((p) => p.y));
    return ys.length === 0 ? null : Math.max(...ys);
  };
  const lineOfVhea = verticalLineOf(tables);
  const verticalLine: ParsedFont['verticalLine'] =
    lineOfVhea === null
      ? { height: header.ascender + metric('hasc') - (header.descender + metric('hdsc')) + header.lineGap + metric('hlgp'), source: 'hhea' }
      : {
          height: lineOfVhea.ascender + metric('vasc') - (lineOfVhea.descender + metric('vdsc')) + lineOfVhea.lineGap + metric('vlgp'),
          source: 'vhea',
        };
  let capHeight = permissions.capHeight === null ? null : permissions.capHeight + metric('cpht');
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
    ascender: header.ascender + metric('hasc'),
    descender: header.descender + metric('hdsc'),
    lineGap: header.lineGap + metric('hlgp'),
    capHeight,
    capHeightSource,
    embedding: permissions.embedding,
    names: readNames(tables),
    glyphIndex,
    advance: (glyph) => {
      const known = advances.get(glyph);
      if (known !== undefined) return known;
      const base = advanceOf(tables, header, glyph);
      // a variable TrueType font without HVAR varies the advance through the phantom points of its glyph variations (charged to one budget for the font)
      const advance =
        advanceDelta !== null
          ? Math.round(base + advanceDelta(glyph))
          : source?.variation === undefined
            ? base
            : Math.round(base + phantomsOf(glyph).width);
      advances.set(glyph, advance);
      return advance;
    },
    verticalAdvance: (glyph) => {
      const known = heights.get(glyph);
      if (known !== undefined) return known;
      const base = verticalAdvanceOf(tables, header, glyph) ?? header.ascender - header.descender;
      const height =
        verticalDelta !== null
          ? Math.round(base + verticalDelta(glyph))
          : source?.variation === undefined
            ? base
            : Math.round(base + phantomsOf(glyph).height);
      heights.set(glyph, height);
      return height;
    },
    verticalOrigin: (glyph) => {
      const declared = tables.flavor === 'cff' ? verticalOriginOf(tables, glyph) : null;
      if (declared !== null) return { y: declared, source: 'VORG' };
      const bearing = topSideBearingOf(tables, header, glyph);
      if (bearing !== null) {
        // a gvar font without VVAR moves the origin with the top phantom point (from the default outline); otherwise the origin is the top of the glyph at the instance plus its (VVAR moved) bearing
        const byPhantom = source?.variation !== undefined && vvar === null;
        const top = pointsTop(glyph, byPhantom);
        if (top !== null)
          return { y: top + bearing + Math.round(byPhantom ? phantomsOf(glyph).top : (bearingDelta?.(glyph) ?? 0)), source: 'vmtx' };
      }
      return { y: header.ascender + metric('hasc'), source: 'ascender' };
    },
    verticalLine: verticalLine,
    axes: space?.axes ?? [],
    namedInstances,
    namedInstanceProblems: space?.instanceProblems ?? [],
    instance,
    kerning: buildGposKerning(tables.table('GPOS')) ?? buildKerning(tables.table('kern')),
    outline,
    scanGlyphs: () => {
      let points = 0;
      const budget = { remaining: FONT_OPERATOR_BUDGET };
      for (let glyph = 0; glyph < header.numGlyphs; glyph++) {
        points +=
          cff !== null
            ? cff.outline(glyph, budget).reduce((sum, loop) => sum + loop.length, 0)
            : glyphContours(source as GlyphSource, glyph, budget).reduce((sum, contour) => sum + contour.length, 0);
        if (points > MAX_FONT_POINTS) throw new FontError('WRP_FONT_PARSE', `glyf: more than ${MAX_FONT_POINTS} points in the whole font`);
      }
    },
  };
}

/** Parse `bytes`; see the module comment for the failure codes. Glyph outlines are read on first use and may then throw `FontError` for a hostile glyph. */
export function parseFont(bytes: Uint8Array, variation: AxisValues = {}, instance?: string): FontParse {
  try {
    return { ok: true, font: build(bytes, variation, instance) };
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
