/**
 * Hostile or unusual fonts (03 WRP review): glyph ids beyond numGlyphs, a glyph that cannot be read at layout time, all-off-curve contours, mirrored
 * composite components, overlapping glyph clusters and the whole-font point budget.
 */

import { describe, expect, it } from 'vitest';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { fillRegions } from '@lib/font/fill';
import { loopArea, loopBox, type OutlineLoop } from '@lib/font/outline';
import { outlineErrorCode, textOutline } from '@core/geometry/textOutline';
import { buildFont, squareContour, type FontSpec, type GlyphPointSpec, type GlyphSpec } from './fontBuilder';

const EMPTY: GlyphSpec = { kind: 'empty' };
const SQUARE: GlyphSpec = { kind: 'simple', contours: [squareContour(0, 0, 700)] };

const font = (spec: FontSpec): ParsedFont => {
  const parsed = parseFont(buildFont(spec));
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
};

const BASE: FontSpec = {
  glyphs: [EMPTY, SQUARE],
  advances: [400, 600],
  metrics: 2,
  codePoints: [[0x48, 1]],
  cmap: 'f4',
  os2: { version: 2, fsType: 0, capHeight: 700 },
};

describe('glyph ids the font does not have', () => {
  it('map to the missing glyph in format 4 and format 12, so layout never reads outside glyf', () => {
    for (const cmap of ['f4', 'f12'] as const) {
      const parsed = font({
        ...BASE,
        cmap,
        codePoints: [
          [0x48, 1],
          [0x49, 0xfff0],
          [0x4a, 2],
        ],
      });
      expect(parsed.glyphIndex(0x48)).toBe(1);
      expect(parsed.glyphIndex(0x49)).toBe(0);
      expect(parsed.glyphIndex(0x4a)).toBe(0);
    }
  });

  it('a glyph that cannot be read at layout time is a coded no-op, not a throw', () => {
    const parsed = font({
      ...BASE,
      glyphs: [EMPTY, SQUARE, { kind: 'raw', bytes: [0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9] }],
      codePoints: [
        [0x41, 2],
        [0x48, 1],
      ],
    });
    const result = textOutline({ content: 'A', height: 10 }, parsed);
    expect('error' in result && result.error).toBe('font_parse');
    expect(outlineErrorCode('font_parse')).toBe('WRP_FONT_PARSE');
    expect(outlineErrorCode('too_long')).toBe('WRP_TEXT_TOO_LONG');
    expect(outlineErrorCode('self_intersect')).toBe('WRP_PROFILE_SELF_INTERSECT');
  });
});

describe('outline details', () => {
  it('an all-off-curve contour starts at the midpoint of its last and first points (area 16666.67 for a diamond of half-diagonal 100)', () => {
    const diamond: GlyphSpec = {
      kind: 'simple',
      contours: [
        [
          { x: 100, y: 0, on: false },
          { x: 0, y: 100, on: false },
          { x: -100, y: 0, on: false },
          { x: 0, y: -100, on: false },
        ],
      ],
    };
    const loop =
      font({
        ...BASE,
        glyphs: [EMPTY, SQUARE, diamond],
        codePoints: [
          [0x48, 1],
          [0x4f, 2],
        ],
      }).outline(2)[0] ?? [];
    expect(loop).toHaveLength(4);
    expect(Math.abs(loopArea(loop))).toBeCloseTo(10000 + (4 * 2 * 2500) / 3, 6);
    const box = loopBox(loop);
    expect(box?.min[0]).toBeCloseTo(-(box?.max[0] ?? 0), 9);
  });

  it('a mirrored composite component keeps the winding of the original', () => {
    const composite: GlyphSpec = {
      kind: 'composite',
      components: [
        { glyph: 1, dx: 0, dy: 0 },
        { glyph: 1, dx: 100, dy: 0, words: true, transform: 'mirror' },
      ],
    };
    const loops = font({ ...BASE, glyphs: [EMPTY, SQUARE, composite] }).outline(2);
    expect(Math.sign(loopArea(loops[0] ?? []))).toBe(Math.sign(loopArea(loops[1] ?? [])));
  });

  it('only the crossing glyphs are united; the others keep their exact curves', () => {
    const lens = (x: number): GlyphPointSpec[] => [
      { x, y: 0, on: true },
      { x: x + 100, y: 300, on: false },
      { x: x + 200, y: 300, on: false },
      { x: x + 300, y: 0, on: true },
      { x: x + 150, y: -200, on: false },
    ];
    const loopOf = (x: number): OutlineLoop => {
      const spec: GlyphSpec = { kind: 'simple', contours: [lens(x)] };
      return font({ ...BASE, glyphs: [EMPTY, SQUARE, spec] }).outline(2)[0] ?? [];
    };
    const result = fillRegions([loopOf(0), loopOf(150), loopOf(5000)]);
    if ('error' in result) throw new Error('unexpected');
    expect(result.united).toBe(true);
    expect(result.regions).toHaveLength(2);
    expect(result.regions.some((region) => region.outer.some((segment) => segment.kind === 'quad'))).toBe(true);
  });
});

describe('font-wide point budget', () => {
  it('refuses a font whose glyphs add up to more points than the budget even though each glyph is small', () => {
    const base: GlyphSpec = {
      kind: 'simple',
      contours: [
        Array.from({ length: 78 }, (_, k) => ({ x: Math.round(100 * Math.cos(k / 12)), y: Math.round(100 * Math.sin(k / 12)), on: true })),
      ],
    };
    const heavy: GlyphSpec = { kind: 'composite', components: Array.from({ length: 256 }, () => ({ glyph: 1, dx: 0, dy: 0 })) };
    const glyphs: GlyphSpec[] = [EMPTY, base, ...Array.from({ length: 260 }, () => heavy)];
    const parsed = font({ ...BASE, glyphs, longLoca: true, advances: [400], metrics: 1, codePoints: [[0x48, 1]] });
    const verdict = validateGlyphs(parsed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.message).toContain('whole font');
  });
});
