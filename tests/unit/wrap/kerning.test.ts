/**
 * 03 WRP M4: GPOS pair kerning (VC-WRP-40). The bundled Fira Sans has no legacy `kern` table, only GPOS: every kerned ASCII pair and the widths of the pack's text cases are compared with
 * `validation/generate_kerning_refs.mjs`, an independent reading of the same table; synthetic GPOS fonts reach every format, the extension lookup and the refusals.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFont, type ParsedFont } from '@lib/font/font';
import { layoutText } from '@lib/font/layout';
import { buildFont, squareContour, type FontSpec, type GlyphSpec } from './fontBuilder';
import { buildGpos, type GposLookup } from './gposBuilder';
import { firaBytes } from './fixtures';

interface KerningReference {
  readonly pairs: ReadonlyArray<{ readonly left: string; readonly right: string; readonly value: number }>;
  readonly cases: ReadonlyArray<{
    readonly text: string;
    readonly kerningUnits: number;
    readonly advanceNoKerningMm: number;
    readonly advanceWithKerningMm: number;
  }>;
}

const reference = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../docs/design/03-wrap-emboss/validation/data/kerning_firasans.json'), 'utf8'),
) as KerningReference;

const load = (bytes: Uint8Array): ParsedFont => {
  const parsed = parseFont(bytes);
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
};

const options = { height: 5, anchor: 'left', verticalAnchor: 'baseline', letterSpacing: 0, kerning: true, lineSpacing: 1 } as const;

describe('GPOS kerning of the bundled Fira Sans (VC-WRP-40)', () => {
  const fira = load(firaBytes());

  it('every kerned ASCII pair equals the independent reading, and no other pair kerns', () => {
    const listed = new Map(reference.pairs.map((pair) => [pair.left + pair.right, pair.value]));
    expect(listed.size).toBe(2086);
    for (let a = 32; a < 127; a++)
      for (let b = 32; b < 127; b++) {
        const pair = String.fromCharCode(a) + String.fromCharCode(b);
        expect(fira.kerning(fira.glyphIndex(a), fira.glyphIndex(b)), pair).toBe(listed.get(pair) ?? 0);
      }
  });

  it('"LLULL CAD 2026" is 51.1030479 mm without kerning (hmtx advances) and 50.8345428 mm with it', () => {
    const row = reference.cases.find((entry) => entry.text === 'LLULL CAD 2026');
    expect(row).toBeDefined();
    const plain = layoutText(fira, 'LLULL CAD 2026', { ...options, kerning: false }).advanceWidth;
    const kerned = layoutText(fira, 'LLULL CAD 2026', options).advanceWidth;
    expect(Math.abs(plain / 51.1030479 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(kerned / (row?.advanceWithKerningMm as number) - 1)).toBeLessThan(1e-6);
    expect(kerned).toBeLessThan(plain);
    for (const entry of reference.cases) {
      const width = layoutText(fira, entry.text, options).advanceWidth;
      expect(Math.abs(width / entry.advanceWithKerningMm - 1), entry.text).toBeLessThan(1e-6);
    }
  });
});

const EMPTY: GlyphSpec = { kind: 'empty' };
const box: GlyphSpec = { kind: 'simple', contours: [squareContour(0, 0, 700)] };
// glyphs 1 .. 6 with code points 'A' .. 'F'
const BASE: FontSpec = {
  glyphs: [EMPTY, box, box, box, box, box, box],
  advances: [400, 600, 600, 600, 600, 600, 600],
  metrics: 7,
  codePoints: [
    [0x41, 1],
    [0x42, 2],
    [0x43, 3],
    [0x44, 4],
    [0x45, 5],
    [0x46, 6],
  ],
  cmap: 'f4',
  os2: { version: 2, fsType: 0, capHeight: 700 },
};

const withGpos = (lookups: GposLookup[], extra: Partial<FontSpec> = {}, feature = 'kern'): ParsedFont =>
  load(buildFont({ ...BASE, tables: { GPOS: buildGpos(lookups, feature) }, ...extra }));

describe('GPOS pair adjustment (synthetic fonts)', () => {
  it('format 1: the x advance of the first value record, with coverage format 1 or 2 and a placement before it', () => {
    const pairs = [
      [1, 2, -80],
      [1, 3, 25],
      [4, 2, -10],
    ] as const;
    for (const coverage of [1, 2] as const) {
      const font = withGpos([{ type: 2, subtables: [{ format: 1, pairs, coverage }] }]);
      expect(font.kerning(1, 2)).toBe(-80);
      expect(font.kerning(1, 3)).toBe(25);
      expect(font.kerning(4, 2)).toBe(-10);
      expect(font.kerning(2, 1)).toBe(0);
      expect(font.kerning(1, 1)).toBe(0);
      expect(font.kerning(5, 5)).toBe(0);
    }
    expect(withGpos([{ type: 2, subtables: [{ format: 1, pairs, valueFormat: 5 }] }]).kerning(1, 2)).toBe(-80);
    expect(withGpos([{ type: 2, subtables: [{ format: 1, pairs, valueFormat: 1 }] }]).kerning(1, 2)).toBe(0);
  });

  it('format 2: class pairs, ClassDef formats 1 and 2, glyphs in class 0 and classes beyond the table', () => {
    for (const secondFormat1 of [false, true]) {
      const font = withGpos([
        {
          type: 2,
          subtables: [
            {
              format: 2,
              covered: [1, 2, 3],
              firstClasses: [
                [1, 1, 1],
                [2, 3, 2],
              ],
              secondClasses: [
                [4, 4, 1],
                [5, 6, 2],
              ],
              secondFormat1,
              values: [
                [0, 0, 0],
                [0, -30, -40],
                [0, 15, 0],
              ],
            },
          ],
        },
      ]);
      expect(font.kerning(1, 4)).toBe(-30);
      expect(font.kerning(1, 5)).toBe(-40);
      expect(font.kerning(2, 4)).toBe(15);
      expect(font.kerning(3, 6)).toBe(0);
      expect(font.kerning(1, 2)).toBe(0);
      expect(font.kerning(5, 4)).toBe(0);
    }
  });

  it('an extension lookup (type 9) is unwrapped; the first matching subtable wins; lookups add', () => {
    const font = withGpos([
      {
        type: 9,
        subtables: [
          { format: 1, pairs: [[1, 2, -60]] },
          {
            format: 1,
            pairs: [
              [1, 2, -1],
              [1, 3, 9],
            ],
          },
        ],
      },
      { type: 2, subtables: [{ format: 1, pairs: [[1, 2, -4]] }] },
    ]);
    expect(font.kerning(1, 2)).toBe(-64);
    expect(font.kerning(1, 3)).toBe(9);
  });

  it('uses GPOS before the legacy kern table; a font without the kern feature, or with other lookup types, does not kern', () => {
    const both = withGpos([{ type: 2, subtables: [{ format: 1, pairs: [[1, 2, -7]] }] }], { kern: [[[1, 2, -999]]] });
    expect(both.kerning(1, 2)).toBe(-7);
    const legacy = withGpos([{ type: 2, subtables: [{ format: 1, pairs: [[1, 2, -7]] }] }], { kern: [[[1, 2, -999]]] }, 'liga');
    expect(legacy.kerning(1, 2)).toBe(-999);
    expect(withGpos([{ type: 1, subtables: [] }]).kerning(1, 2)).toBe(0);
  });

  it('refuses a GPOS whose lists cannot be walked, and a hostile pair offset when the pair is asked', () => {
    const good = buildGpos([{ type: 2, subtables: [{ format: 1, pairs: [[1, 2, -7]] }] }]);
    expect(parseFont(buildFont({ ...BASE, tables: { GPOS: good.slice(0, 12) } })).ok).toBe(false);
    const missing = [...good];
    // the feature names lookup 0; make it name lookup 9 of 1
    const featureList = (missing[6] as number) * 256 + (missing[7] as number);
    missing[featureList + 2 + 6 + 2 + 3] = 9;
    const refused = parseFont(buildFont({ ...BASE, tables: { GPOS: missing } }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('WRP_FONT_PARSE');
    const hostile = [...good];
    hostile[hostile.length - 8] = 0xff;
    const lazily = parseFont(buildFont({ ...BASE, tables: { GPOS: hostile } }));
    expect(lazily.ok).toBe(true);
    const unsupported = new Uint8Array(buildFont({ ...BASE, tables: { GPOS: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0] } }));
    expect(load(unsupported).kerning(1, 2)).toBe(0);
  });
});

describe('multi-line text (M4)', () => {
  const fira = load(firaBytes());
  const pitch = (spacing: number): number => spacing * (fira.ascender - fira.descender + fira.lineGap) * (5 / fira.capHeight);
  const lowest = (text: string, spacing = 1): number => {
    const layout = layoutText(fira, text, { ...options, lineSpacing: spacing });
    return Math.min(...layout.loops.flatMap((loop) => loop.flatMap((segment) => [segment.from[1], segment.to[1]])));
  };

  it('breaks lines at newline, drops each by the font line height times lineSpacing, and doubles the outline', () => {
    const one = layoutText(fira, 'LL', options);
    const two = layoutText(fira, 'LL\nLL', options);
    expect(one.lines).toBe(1);
    expect(two.lines).toBe(2);
    expect(two.loops).toHaveLength(2 * one.loops.length);
    expect(two.advanceWidth).toBeCloseTo(one.advanceWidth, 9);
    expect(lowest('LL\nLL') - lowest('LL')).toBeCloseTo(-pitch(1), 9);
    expect(lowest('LL\nLL', 1.5) - lowest('LL')).toBeCloseTo(-pitch(1.5), 9);
    expect(lowest('LL\nLL\nLL') - lowest('LL')).toBeCloseTo(-2 * pitch(1), 9);
  });

  it('aligns every line on its own: a short line of a centred text is centred, not flush with the longer one', () => {
    const centred = layoutText(fira, 'L\nLLLL', { ...options, anchor: 'center' });
    const firstLine = centred.glyphs.filter((glyph) => glyph.character === 'L').slice(0, 1)[0];
    const firstX = Math.min(...(firstLine?.loops.flatMap((loop) => loop.flatMap((s) => [s.from[0], s.to[0]])) ?? [0]));
    const wide = centred.advanceWidth;
    const lone = fira.advance(fira.glyphIndex(0x4c)) * (5 / fira.capHeight);
    // the one-glyph line starts at -lone / 2 (plus its left bearing), well inside the widest line that starts at -wide / 2
    expect(firstX).toBeGreaterThan(-wide / 2 + 1);
    expect(firstX).toBeLessThan(-lone / 2 + lone);
    const flush = layoutText(fira, 'L\nLLLL', options);
    expect(flush.glyphs[0]?.loops[0]?.[0]?.from[0]).toBeCloseTo(
      layoutText(fira, 'L', options).glyphs[0]?.loops[0]?.[0]?.from[0] as number,
      9,
    );
  });
});
