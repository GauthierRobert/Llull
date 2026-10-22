/**
 * `lib/font` against synthetic TrueType fonts whose contents are known (03 WRP, TECHNICAL_SPEC §5.4): every cmap format, glyph encoding, composite transform,
 * OS/2 / name / kern variant and every refusal of a damaged table (bounded reads, glyph / point / component caps).
 */

import { describe, expect, it } from 'vitest';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { layoutText } from '@lib/font/layout';
import { loopArea, loopBox, loopLength } from '@lib/font/outline';
import { buildFont, lensContour, squareContour, type FontSpec, type GlyphSpec } from './fontBuilder';

const EMPTY: GlyphSpec = { kind: 'empty' };
const H: GlyphSpec = { kind: 'simple', contours: [squareContour(0, 0, 700)] };
const A: GlyphSpec = { kind: 'simple', contours: [lensContour()] };

const BASE: FontSpec = {
  glyphs: [EMPTY, H, A, EMPTY],
  advances: [400, 600, 650],
  metrics: 3,
  codePoints: [
    [0x20, 3],
    [0x41, 2],
    [0x48, 1],
  ],
  cmap: 'f4',
  os2: { version: 2, fsType: 0, capHeight: 700 },
  names: [
    { platform: 3, id: 1, text: 'Test Sans' },
    { platform: 3, id: 2, text: 'Italic' },
    { platform: 3, id: 13, text: 'Free licence' },
  ],
};

const font = (spec: FontSpec): ParsedFont => {
  const parsed = parseFont(buildFont(spec));
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
};

const failure = (spec: FontSpec | Uint8Array): string => {
  const parsed = parseFont(spec instanceof Uint8Array ? spec : buildFont(spec));
  return parsed.ok ? 'ok' : parsed.code;
};

const outlineFailure = (spec: FontSpec, glyph: number): string => {
  const parsed = font(spec);
  try {
    parsed.outline(glyph);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'other';
  }
};

describe('synthetic font: metrics, cmap formats, names, permissions', () => {
  it('reads metrics, names, advances (a short hmtx repeats the last advance) and glyph outlines', () => {
    const parsed = font(BASE);
    expect(parsed).toMatchObject({
      unitsPerEm: 1000,
      numGlyphs: 4,
      ascender: 900,
      descender: -250,
      lineGap: 100,
      capHeight: 700,
      capHeightSource: 'os2',
    });
    expect(parsed.names).toEqual({ family: 'Test Sans', style: 'Italic', licence: 'Free licence' });
    expect([parsed.advance(0), parsed.advance(1), parsed.advance(2), parsed.advance(3)]).toEqual([400, 600, 650, 650]);
    expect(parsed.glyphIndex(0x41)).toBe(2);
    expect(parsed.glyphIndex(0x42)).toBe(0);
    expect(parsed.glyphIndex(0x1f600)).toBe(0);
    const [square] = parsed.outline(1);
    expect(loopArea(square ?? [])).toBe(-490000);
    expect(loopLength(square ?? [])).toBe(2800);
    expect(loopBox(square ?? [])).toEqual({ min: [0, 0], max: [700, 700] });
    const [lens] = parsed.outline(2);
    expect(lens?.some((segment) => segment.kind === 'quad')).toBe(true);
    expect(parsed.outline(3)).toEqual([]);
    expect(parsed.outline(1)).toBe(parsed.outline(1));
    expect(() => parsed.scanGlyphs()).not.toThrow();
    expect(validateGlyphs(parsed)).toEqual({ ok: true });
  });

  it('reads the three cmap forms and refuses a font without a Unicode subtable or with damaged ones', () => {
    for (const cmap of ['f4', 'f4-range', 'f12'] as const) {
      const parsed = font({ ...BASE, cmap });
      expect(
        [parsed.glyphIndex(0x41), parsed.glyphIndex(0x48), parsed.glyphIndex(0x20), parsed.glyphIndex(0x50), parsed.glyphIndex(0x10)],
        cmap,
      ).toEqual([2, 1, 3, 0, 0]);
    }
    expect(font({ ...BASE, cmap: 'f4' }).glyphIndex(0x10000)).toBe(0);
    expect(failure({ ...BASE, cmap: 'none' })).toBe('WRP_FONT_PARSE');
    expect(failure({ ...BASE, cmap: 'f4-bad' })).toBe('WRP_FONT_PARSE');
    expect(failure({ ...BASE, cmap: 'f12-bad' })).toBe('WRP_FONT_PARSE');
  });

  it('takes the cap height from the H outline when OS/2 has none, and refuses a font that cannot be measured', () => {
    const fallback = font({ ...BASE, os2: { version: 1, fsType: 0 } });
    expect(fallback).toMatchObject({ capHeight: 700, capHeightSource: 'glyph_H' });
    expect(font({ ...BASE, os2: null }).capHeightSource).toBe('glyph_H');
    expect(failure({ ...BASE, os2: null, codePoints: [[0x41, 2]] })).toBe('WRP_FONT_PARSE');
    expect(font({ ...BASE, os2: { version: 2, fsType: 0, capHeight: -5 } }).capHeightSource).toBe('glyph_H');
  });

  it('reads the embedding permission and refuses restricted and bitmap-only fonts', () => {
    expect(font({ ...BASE, os2: { version: 2, fsType: 8, capHeight: 700 } }).embedding).toBe('editable');
    expect(font({ ...BASE, os2: { version: 2, fsType: 4, capHeight: 700 } }).embedding).toBe('preview_print');
    expect(failure({ ...BASE, os2: { version: 2, fsType: 2, capHeight: 700 } })).toBe('WRP_FONT_EMBEDDING_RESTRICTED');
    expect(failure({ ...BASE, os2: { version: 2, fsType: 0x0200, capHeight: 700 } })).toBe('WRP_FONT_EMBEDDING_RESTRICTED');
  });

  it('prefers typographic family names, falls back to ASCII Macintosh names and to defaults', () => {
    const typographic = font({
      ...BASE,
      names: [
        { platform: 1, id: 1, text: 'Mac Family' },
        { platform: 3, id: 1, text: 'Family' },
        { platform: 3, id: 16, text: 'Preferred Family' },
        { platform: 3, id: 17, text: 'Bold' },
        { platform: 1, id: 17, text: 'Mac Bold' },
      ],
    });
    expect(typographic.names).toEqual({ family: 'Preferred Family', style: 'Bold' });
    expect(font({ ...BASE, names: [{ platform: 1, id: 1, text: 'Only Mac' }] }).names.family).toBe('Only Mac');
    expect(font({ ...BASE, names: [] }).names).toEqual({ family: 'Unknown', style: 'Regular' });
    expect(font({ ...BASE, names: undefined as never }).names.family).toBe('Unknown');
  });

  it('applies legacy kern pairs from every horizontal subtable and ignores vertical or unknown tables', () => {
    const spec: FontSpec = {
      ...BASE,
      kern: [
        [[1, 2, -80]],
        [
          [1, 2, -20],
          [2, 1, 15],
        ],
      ],
    };
    const parsed = font(spec);
    expect(parsed.kerning(1, 2)).toBe(-100);
    expect(parsed.kerning(2, 1)).toBe(15);
    expect(parsed.kerning(1, 1)).toBe(0);
    expect(font({ ...BASE, kern: 'vertical' }).kerning(1, 2)).toBe(0);
    expect(font({ ...BASE, kern: 'version1' }).kerning(1, 2)).toBe(0);
    expect(font(BASE).kerning(1, 2)).toBe(0);
    const options = { height: 7, anchor: 'left', verticalAnchor: 'baseline', letterSpacing: 0, lineSpacing: 1 } as const;
    const plain = layoutText(parsed, 'HA', { ...options, kerning: false });
    const kerned = layoutText(parsed, 'HA', { ...options, kerning: true });
    expect(kerned.advanceWidth - plain.advanceWidth).toBeCloseTo(parsed.kerning(1, 2) * 0.01, 9);
  });
});

describe('synthetic font: composites, encodings and refusals', () => {
  it('places composite components by offsets (bytes and words) and transforms (scale, x / y scale, 2 x 2)', () => {
    const composite = (transform?: 'scale' | 'xy' | 'matrix'): FontSpec => ({
      ...BASE,
      glyphs: [
        EMPTY,
        H,
        A,
        EMPTY,
        {
          kind: 'composite',
          components: [
            { glyph: 1, dx: 10, dy: 20, ...(transform ? { transform } : {}) },
            { glyph: 1, dx: 1000, dy: -50, words: true },
          ],
        },
      ],
    });
    const plain = font(composite()).outline(4);
    expect(plain).toHaveLength(2);
    expect(loopBox(plain[0] ?? [])?.min).toEqual([10, 20]);
    expect(loopBox(plain[1] ?? [])?.min).toEqual([1000, -50]);
    expect(Math.abs(loopArea(font(composite('scale')).outline(4)[0] ?? []))).toBeCloseTo(490000 * 0.25, 3);
    expect(Math.abs(loopArea(font(composite('xy')).outline(4)[0] ?? []))).toBeCloseTo(490000 * 0.5 * 2, 3);
    expect(Math.abs(loopArea(font(composite('matrix')).outline(4)[0] ?? []))).toBeGreaterThan(0);
  });

  it('reads the encodings a real font uses: short vectors, repeated flags, 16-bit deltas, long loca', () => {
    const wide: GlyphSpec = { kind: 'simple', contours: [squareContour(0, 0, 3000), squareContour(100, 100, 200)] };
    const parsed = font({ ...BASE, glyphs: [EMPTY, H, wide, EMPTY], longLoca: true });
    const outline = parsed.outline(2);
    expect(outline).toHaveLength(2);
    expect(loopBox(outline[0] ?? [])?.max).toEqual([3000, 3000]);
    expect(loopBox(outline[1] ?? [])?.min).toEqual([100, 100]);
  });

  it('refuses damaged glyphs with WRP_FONT_PARSE: bad end points, caps, point matching, wild references, loops', () => {
    const raw = (...bytes: number[]): GlyphSpec => ({ kind: 'raw', bytes });
    const withGlyph = (glyph: GlyphSpec): FontSpec => ({ ...BASE, glyphs: [EMPTY, H, glyph, EMPTY] });
    const noBox = [0, 0, 0, 0, 0, 0, 0, 0];
    expect(outlineFailure(withGlyph(raw(0, 2, ...noBox, 0, 3, 0, 2, 0, 0)), 2)).toBe('WRP_FONT_PARSE');
    expect(outlineFailure(withGlyph(raw(0x13, 0x88, ...noBox)), 2)).toBe('WRP_FONT_PARSE');
    expect(outlineFailure(withGlyph(raw(0, 1, ...noBox, 0x75, 0x30, 0, 0)), 2)).toBe('WRP_FONT_PARSE');
    expect(outlineFailure(withGlyph(raw(0, 1, ...noBox, 0, 1)), 2)).toBe('WRP_FONT_PARSE');
    const component = (extra: Record<string, unknown>): GlyphSpec => ({
      kind: 'composite',
      components: [{ glyph: 1, dx: 0, dy: 0, ...extra }],
    });
    expect(outlineFailure(withGlyph(component({ pointMatching: true })), 2)).toBe('WRP_FONT_PARSE');
    expect(outlineFailure(withGlyph(component({ glyph: 999 })), 2)).toBe('WRP_FONT_PARSE');
    expect(outlineFailure(withGlyph(component({ glyph: 2 })), 2)).toBe('WRP_FONT_PARSE');
    const crowd: GlyphSpec = { kind: 'composite', components: Array.from({ length: 300 }, () => ({ glyph: 1, dx: 0, dy: 0 })) };
    expect(outlineFailure(withGlyph(crowd), 2)).toBe('WRP_FONT_PARSE');
    const parsed = font(withGlyph(raw(0, 1, ...noBox, 0, 1)));
    expect(validateGlyphs(parsed).ok).toBe(false);
  });

  it('refuses damaged tables with WRP_FONT_PARSE', () => {
    expect(failure({ ...BASE, unitsPerEm: 8 })).toBe('WRP_FONT_PARSE');
    expect(failure({ ...BASE, unitsPerEm: 20000 })).toBe('WRP_FONT_PARSE');
    for (const tag of ['head', 'maxp', 'hhea', 'hmtx', 'cmap', 'loca', 'glyf'])
      expect(failure({ ...BASE, omit: [tag] }), tag).toBe('WRP_FONT_PARSE');
    expect(failure({ ...BASE, glyphs: [] })).toBe('WRP_FONT_PARSE');
    expect(failure({ ...BASE, metrics: 9 })).toBe('WRP_FONT_PARSE');
    expect(failure({ ...BASE, metrics: 0 })).toBe('WRP_FONT_PARSE');
    expect(failure({ ...BASE, hmtxLength: 6 })).toBe('WRP_FONT_PARSE');
    const bytes = buildFont(BASE);
    const loca = new Uint8Array(bytes);
    for (let k = 0, count = (loca[4] as number) * 256 + (loca[5] as number); k < count; k++) {
      const record = 12 + 16 * k;
      if (String.fromCharCode(...loca.subarray(record, record + 4)) === 'loca') loca[record + 15] = 4;
    }
    expect(failure(loca)).toBe('WRP_FONT_PARSE');
    const outside = new Uint8Array(bytes);
    outside[12 + 8] = 0x7f;
    expect(failure(outside)).toBe('WRP_FONT_PARSE');
    const crowded = new Uint8Array(bytes);
    crowded[4] = 0x01;
    crowded[5] = 0x00;
    expect(failure(crowded)).toBe('WRP_FONT_PARSE');
    const version = new Uint8Array(bytes);
    version[0] = 0x7f;
    expect(failure(version)).toBe('WRP_FONT_PARSE');
    expect(failure(bytes.subarray(0, 8))).toBe('WRP_FONT_PARSE');
  });
});
