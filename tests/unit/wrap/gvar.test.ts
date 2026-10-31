/**
 * 03 WRP variable TrueType fonts (spec §14.14): `gvar` tuple variations (shared and embedded peaks, intermediate regions, private / shared / packed point numbers, packed deltas,
 * IUP for untouched points, composite offsets, phantom-point advances), `avar` version 2, `MVAR` and the hostile-table bounds. The fonts are generated (gvarBuilder.ts), so every
 * expected coordinate follows from the numbers written here; a real variable font of the system (Bahnschrift) is checked for the properties that must hold.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { readGvar } from '@lib/font/gvar';
import { ByteView } from '@lib/font/reader';
import { loopBox, type OutlineLoop } from '@lib/font/outline';
import { gvarTupleFanFont } from './hostileFonts';
import type { StoreSpec } from './cff2Builder';
import { buildGvar, buildAvar2, buildMvar, packDeltas, packPoints } from './gvarBuilder';
import { BASE_SQUARE, NAMED, SHARED, SQUARE, TRIANGLE, TUPLES, t, variable } from './variableTrueType';
import { buildHvar } from './cff2Builder';

const F14 = (value: number): number => Math.round(value * 16384) / 16384;
/** Normalised wght coordinate of a value (default 400, 100..900). */
const wght = (value: number): number => F14(value < 400 ? (value - 400) / 300 : (value - 400) / 500);

const load = (bytes: Uint8Array, values: Record<string, number> = {}): ParsedFont => {
  const parsed = parseFont(bytes, values);
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
};
const refusal = (bytes: Uint8Array, values: Record<string, number> = {}): { code: string; message: string } => {
  const parsed = parseFont(bytes, values);
  if (parsed.ok) {
    const scan = validateGlyphs(parsed.font);
    if (scan.ok) throw new Error('expected a refusal');
    return scan;
  }
  return parsed;
};
/** The points of the first contour of a glyph, in outline order. */
const points = (font: ParsedFont, glyph: number): Array<readonly [number, number]> =>
  (font.outline(glyph)[0] as OutlineLoop).map((segment) => [segment.from[0], segment.from[1]] as const);
const sorted = (list: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> =>
  [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const expectPoints = (font: ParsedFont, glyph: number, expected: ReadonlyArray<readonly [number, number]>): void => {
  const got = sorted(points(font, glyph));
  const want = sorted(expected);
  expect(got).toHaveLength(want.length);
  got.forEach(([x, y], k) => {
    expect(x).toBeCloseTo((want[k] as readonly [number, number])[0], 9);
    expect(y).toBeCloseTo((want[k] as readonly [number, number])[1], 9);
  });
};
/** The square with the x-deltas of a wght+ scalar `s` (corners 40 s, the rest inferred) and an extra offset. */
const squareAt = (s: number, shift = 0, rise = 0): Array<readonly [number, number]> => {
  const dx = [0, 20 * s, 40 * s, 40 * s, 40 * s, 20 * s, 0, 0];
  const dy = [0, 0, 0, 0, rise, rise, rise, 0];
  return BASE_SQUARE.map(([x, y], k) => [x + (dx[k] as number) + shift, y + (dy[k] as number)] as const);
};

describe('gvar: the tuple variation store', () => {
  it('the default instance is the static glyf outline (no variation is applied) and the axes are listed', () => {
    const font = load(variable());
    expect(font.axes.map((a) => a.tag)).toEqual(['wght', 'wdth']);
    expect(font.instance).toEqual({});
    expectPoints(font, 1, BASE_SQUARE);
    expect(font.advance(1)).toBe(600);
    expect(load(variable(), { wght: 400, wdth: 100 }).advance(1)).toBe(600);
  });

  it('wght 900 (coordinate 1): the right corners move by 40, untouched points are inferred (IUP) between the corners, and the advance follows the phantom point', () => {
    const font = load(variable(), { wght: 900 });
    expect(font.instance).toEqual({ wght: 900 });
    expectPoints(font, 1, squareAt(1));
    expect(font.advance(1)).toBe(640);
    // untouched points: P1 and P5 between corners of delta 0 and 40 get 20, P3 (same x as P2 and P4, equal deltas) gets 40, P7 (same x as P6 and P0) gets 0
    const xs = points(font, 1).map(([x]) => x);
    expect(sorted(points(font, 1)).map(([x]) => x)).toEqual([0, 0, 0, 70, 70, 140, 140, 140]);
    expect(xs).toHaveLength(8);
  });

  it('wght 650 (coordinate 0.5): the shared tuple scales by 0.5 and the intermediate tuple (0.25 / 0.5 / 1) is at its peak, so everything also moves by 8', () => {
    const font = load(variable(), { wght: 650 });
    expectPoints(font, 1, squareAt(0.5, 8));
    expect(font.advance(1)).toBe(620);
  });

  it('an intermediate region scales between its start, peak and end, and is zero at the start and at the end', () => {
    const c = wght(550);
    const scalar = (c - 0.25) / 0.25;
    const font = load(variable(), { wght: 550 });
    expectPoints(font, 1, squareAt(c, 8 * scalar));
    expectPoints(load(variable(), { wght: 525 }), 1, squareAt(wght(525), 0));
    expectPoints(load(variable(), { wght: 900 }), 1, squareAt(1, 0));
  });

  it('wght 100 (coordinate -1): the wght- tuple has one touched point, so the whole contour moves by -10 (the positive tuples are zero)', () => {
    const font = load(variable(), { wght: 100 });
    expectPoints(
      font,
      1,
      BASE_SQUARE.map(([x, y]) => [x - 10, y] as const),
    );
    expect(font.advance(1)).toBe(600);
    const part = load(variable(), { wght: 250 });
    expectPoints(
      part,
      1,
      BASE_SQUARE.map(([x, y]) => [x + wght(250) * 10, y] as const),
    );
  });

  it('wdth 125 raises the top three points by 10; both axes together add up', () => {
    expectPoints(load(variable(), { wdth: 125 }), 1, squareAt(0, 0, 10));
    expectPoints(load(variable(), { wght: 900, wdth: 125 }), 1, squareAt(1, 0, 10));
    expectPoints(load(variable(), { wdth: 112.5 }), 1, squareAt(0, 0, 5));
  });

  it('shared point numbers (flag 0x8000) name the points of tuples without their own list; an untouched third point is inferred or left at 0 when the coordinates are equal', () => {
    const font = load(variable(), { wght: 900 });
    // points 0 and 1 move by (10, 0) and (20, 5); point 2 (x = 50 between 0 and 100) gets x delta 15, and y (equal y of points 0 and 1, different deltas) gets 0
    expectPoints(font, 2, [
      [10, 0],
      [120, 5],
      [65, 100],
    ]);
    // the private single touched point of the wdth tuple moves the whole triangle down by 20 at wdth 125
    expectPoints(load(variable(), { wdth: 125 }), 2, [
      [0, -20],
      [100, -20],
      [50, 80],
    ]);
  });

  it('composite glyphs: the deltas move the component offsets (all points listed, components + 4 phantom points), and each component keeps its own variation', () => {
    const font = load(variable(), { wght: 900 });
    const loops = font.outline(3);
    expect(loops).toHaveLength(2);
    const first = loops[0] as OutlineLoop;
    const second = loops[1] as OutlineLoop;
    expect(loopBox(first)).toEqual({ min: [0, 0], max: [140, 100] });
    // the second copy of glyph 1 sits at 200 + 30 (the composite's own delta) and is varied itself
    expect(loopBox(second)).toEqual({ min: [230, 0], max: [370, 100] });
  });

  it('packed formats: a 150-point list needs a two-byte count, a step of 300 needs word point numbers, a delta of 300 needs words, zero runs are packed', () => {
    const font = load(variable(), { wght: 900 });
    const moved = points(font, 4);
    const base = points(load(variable()), 4);
    NAMED.forEach((index, k) => {
      const dx = k % 3 === 0 ? 0 : k === 150 ? 300 : 2 * k;
      const dy = k % 2 === 0 ? 0 : -k;
      expect(moved[index]?.[0]).toBeCloseTo((base[index]?.[0] as number) + dx, 9);
      expect(moved[index]?.[1]).toBeCloseTo((base[index]?.[1] as number) + dy, 9);
    });
    // the point after the first named point is between two touched points: inferred, never NaN
    expect(moved.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(packPoints(NAMED).slice(0, 2)).toEqual([0x80, 151]);
    expect(packPoints([1, 300])).toEqual([2, 0x81, 0, 1, 1, 43]);
  });

  it('the advance comes from HVAR when the font has one, from the phantom points otherwise', () => {
    const store: StoreSpec = {
      axisCount: 2,
      regions: [
        [
          [0, 1, 1],
          [0, 0, 0],
        ],
      ],
      data: [{ regionIndexes: [0], rows: [[0], [100], [0], [0], [0]] }],
    };
    const withHvar = load(variable({ tables: { HVAR: buildHvar(store) } }), { wght: 900 });
    expect(withHvar.advance(1)).toBe(700);
    expect(load(variable(), { wght: 900 }).advance(1)).toBe(640);
    expect(load(variable(), { wght: 900 }).advance(2)).toBe(700);
  });

  it('a glyph without variation data (gvar glyph count shorter than the font) is unchanged', () => {
    const font = load(variable({ gvar: { glyphs: [null, TUPLES[1] as never], glyphCount: 2 } }), { wght: 900 });
    expectPoints(font, 1, squareAt(1));
    expectPoints(
      font,
      2,
      TRIANGLE.map((p) => [p.x, p.y] as const),
    );
  });
});

describe('avar version 2', () => {
  const identity: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [
      [-1, -1],
      [0, 0],
      [1, 1],
    ],
    [
      [-1, -1],
      [0, 0],
      [1, 1],
    ],
  ];
  /** One region (wght 0..1..1): at the wght peak the wdth axis moves by 8192 / 16384 = 0.5 and wght itself by 0. */
  const store: StoreSpec = {
    axisCount: 2,
    regions: [
      [
        [0, 1, 1],
        [0, 0, 0],
      ],
    ],
    data: [{ regionIndexes: [0], rows: [[0], [8192]] }],
  };

  it('the delta store moves the other axis: wght 900 puts wdth at 0.5 (also at its default), so the wdth tuple scales by 0.5; at wght 650 by 0.25', () => {
    const bytes = variable({ tables: { avar: buildAvar2(identity, { store }) } });
    expectPoints(load(bytes, { wght: 900 }), 1, squareAt(1, 0, 5));
    expectPoints(load(bytes, { wght: 650 }), 1, squareAt(0.5, 8, 2.5));
    expectPoints(load(bytes), 1, BASE_SQUARE);
  });

  it('an axis index map picks the rows: axis 1 -> row 1 of subtable 0, axis 0 -> row 0 (the same result) and swapped rows give the wght axis the 0.5', () => {
    const mapped = variable({ tables: { avar: buildAvar2(identity, { store, map: [0, 1] }) } });
    expectPoints(load(mapped, { wght: 900 }), 1, squareAt(1, 0, 5));
    const swapped = variable({ tables: { avar: buildAvar2(identity, { store, map: [1, 0] }) } });
    // axis 0 takes row 1 (+0.5 at the wght peak: wght stays clamped at 1), axis 1 row 0 (0): no wdth effect
    expectPoints(load(swapped, { wght: 900 }), 1, squareAt(1, 0, 0));
  });

  it('the segment maps of version 2 apply first: a bent wght axis changes where the store is evaluated', () => {
    const bent: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
      [
        [-1, -1],
        [0, 0],
        [0.5, 0.25],
        [1, 1],
      ],
      identity[1] as ReadonlyArray<readonly [number, number]>,
    ];
    const bytes = variable({ tables: { avar: buildAvar2(bent, { store }) } });
    // wght 650 is 0.5, bent to 0.25: the wght tuple scalar is 0.25, the intermediate tuple (start 0.25) is 0, and the store (scalar 0.25 x 8192) moves wdth to 0.125, so the top rises by 1.25
    expectPoints(load(bytes, { wght: 650 }), 1, squareAt(0.25, 0, 10 * 0.125));
  });

  it('an avar 2 table without a store, or with a damaged one, is read or refused cleanly', () => {
    const plain = variable({ tables: { avar: buildAvar2(identity) } });
    expectPoints(load(plain, { wght: 900 }), 1, squareAt(1, 0, 0));
    const wideStore: StoreSpec = { ...store, axisCount: 3 };
    expect(refusal(variable({ tables: { avar: buildAvar2(identity, { store: wideStore }) } }), {}).code).toBe('WRP_FONT_PARSE');
  });
});

describe('MVAR', () => {
  const store: StoreSpec = {
    axisCount: 2,
    regions: [
      [
        [0, 1, 1],
        [0, 0, 0],
      ],
    ],
    data: [{ regionIndexes: [0], rows: [[50], [-20], [10], [30], [7]] }],
  };
  const records = [
    ['hasc', 0, 0],
    ['hdsc', 0, 1],
    ['hlgp', 0, 2],
    ['cpht', 0, 3],
    ['xhgt', 0, 4],
  ] as const;

  it('the ascender, descender, line gap and cap height follow the instance (rounded), the default instance and an unvaried axis are unchanged', () => {
    const bytes = variable({ tables: { MVAR: buildMvar(records, store) } });
    const base = load(bytes);
    expect([base.ascender, base.descender, base.lineGap, base.capHeight]).toEqual([900, -250, 100, 700]);
    const full = load(bytes, { wght: 900 });
    expect([full.ascender, full.descender, full.lineGap, full.capHeight]).toEqual([950, -270, 110, 730]);
    const half = load(bytes, { wght: 650 });
    expect([half.ascender, half.descender, half.lineGap, half.capHeight]).toEqual([925, -260, 105, 715]);
    const other = load(bytes, { wdth: 125 });
    expect([other.ascender, other.capHeight]).toEqual([900, 700]);
  });

  it('records the layout does not read (xhgt) are accepted, a larger record size is honoured, and damaged tables are refused', () => {
    const wide = variable({ tables: { MVAR: buildMvar(records, store, 12) } });
    expect(load(wide, { wght: 900 }).ascender).toBe(950);
    const bad = (bytes: number[]): { code: string } => refusal(variable({ tables: { MVAR: bytes } }), { wght: 900 });
    const good = buildMvar(records, store);
    expect(bad([0, 2, ...good.slice(2)]).code).toBe('WRP_FONT_PARSE');
    expect(bad([...good.slice(0, 6), 0, 4, ...good.slice(8)]).code).toBe('WRP_FONT_PARSE');
    expect(bad([...good.slice(0, 8), 1, 0, ...good.slice(10)]).code).toBe('WRP_FONT_PARSE');
    expect(bad([...good.slice(0, 10), 0, 0, ...good.slice(12)]).code).toBe('WRP_FONT_PARSE');
    expect(bad(good.slice(0, 20)).code).toBe('WRP_FONT_PARSE');
    expect(load(variable({ tables: { MVAR: buildMvar([], store) } }), { wght: 900 }).ascender).toBe(900);
  });
});

describe('gvar: hostile tables', () => {
  const good = (): number[] => buildGvar({ axisCount: 2, shared: SHARED, glyphs: TUPLES });
  const withGvar = (bytes: readonly number[]): Uint8Array => variable({ tables: { gvar: bytes } });
  const patch = (bytes: number[], at: number, ...values: number[]): number[] =>
    bytes.map((b, k) => (k >= at && k < at + values.length ? (values[k - at] as number) : b));

  it('header damage is WRP_FONT_PARSE: version, axis count, shared tuple count, glyph count, truncation', () => {
    const table = good();
    expect(refusal(withGvar(patch(table, 1, 2)), { wght: 900 }).code).toBe('WRP_FONT_PARSE');
    expect(refusal(withGvar(patch(table, 5, 3)), { wght: 900 }).message).toContain('axes');
    expect(refusal(withGvar(patch(table, 6, 0x20, 0)), { wght: 900 }).message).toContain('shared tuples');
    expect(refusal(withGvar(patch(table, 12, 0, 50)), { wght: 900 }).message).toContain('glyphs');
    expect(refusal(withGvar(table.slice(0, 30)), { wght: 900 }).code).toBe('WRP_FONT_PARSE');
    expect(refusal(withGvar([]), { wght: 900 }).code).toBe('WRP_FONT_PARSE');
  });

  it('glyph data damage is WRP_FONT_PARSE: offsets running backwards, a shared tuple outside the list, point numbers outside the glyph, runs past their counts, tuples past the data', () => {
    const base = good();
    const dataAt = 20 + 2 * 6 + SHARED.length * 4;
    // glyph 1 starts at its offset in the glyph offset array (entries are half the byte offset)
    expect(refusal(withGvar(patch(base, 20 + 2 * 2, 0, 200)), { wght: 900 }).message).toContain('ends before it starts');
    const outsidePoints = buildGvar({
      axisCount: 2,
      shared: SHARED,
      glyphs: [null, { tuples: [t({ shared: 0, points: [20], dx: [1], dy: [1] })] }, null, null, null],
    });
    expect(refusal(withGvar(outsidePoints), { wght: 900 }).message).toContain('outside');
    const tooMany = buildGvar({
      axisCount: 2,
      shared: SHARED,
      glyphs: [
        null,
        { tuples: [t({ shared: 0, points: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], dx: [], dy: [] })] },
        null,
        null,
        null,
      ],
    });
    expect(refusal(withGvar(tooMany), { wght: 900 }).message).toContain('point numbers');
    const badShared = buildGvar({
      axisCount: 2,
      shared: SHARED,
      glyphs: [null, { tuples: [t({ shared: 9, points: [0], dx: [1], dy: [1] })] }, null, null, null],
    });
    expect(refusal(withGvar(badShared), { wght: 900 }).message).toContain('shared tuple');
    const short = buildGvar({
      axisCount: 2,
      shared: SHARED,
      glyphs: [null, { tuples: [t({ shared: 0, points: [0, 1], dx: [1], dy: [1, 2] })] }, null, null, null],
    });
    expect(refusal(withGvar(short), { wght: 900 }).code).toBe('WRP_FONT_PARSE');
    // 4000 tuple headers claimed, almost no data behind them
    const claimed = patch(base, dataAt + 0, 0x0f, 0xa0);
    expect(refusal(withGvar(claimed), { wght: 900 }).code).toBe('WRP_FONT_PARSE');
  });

  it('long offsets (flags bit 0) and a glyph count short of the font are read', () => {
    const font = load(variable({ gvar: { long: true } }), { wght: 900 });
    expectPoints(font, 1, squareAt(1));
  });

  it('a point-number run past its count, and deltas past the own variationDataSize of a tuple (not just the data of the glyph), are refused', () => {
    const single = (dx: number[], dy: number[], points: number[]): number[] =>
      buildGvar({ axisCount: 2, shared: SHARED, glyphs: [null, { tuples: [t({ shared: 0, points, dx, dy })] }, null, null, null] });
    const table = single([1, 2, 3], [4, 5, 6], [0, 1, 2]);
    const runAt = table.findIndex((byte, k) => byte === 3 && table[k + 1] === 2 && table[k + 2] === 0);
    expect(runAt).toBeGreaterThan(0);
    // a run control of 5 (6 points) for a count of 3
    expect(refusal(withGvar(patch(table, runAt + 1, 5)), { wght: 900 }).message).toContain('point-number run');
    // the tuple header says one byte less than its body needs: the y deltas run past the tuple's own data
    const dataStart =
      (table[16] as number) * 16777216 + (table[17] as number) * 65536 + (table[18] as number) * 256 + (table[19] as number);
    const sizeAt = dataStart + 4;
    const size = (table[sizeAt] as number) * 256 + (table[sizeAt + 1] as number);
    const shortened = patch(table, sizeAt, (size - 1) >> 8, (size - 1) & 0xff);
    const refused = refusal(withGvar(shortened), { wght: 900 });
    expect(refused.code).toBe('WRP_FONT_PARSE');
    expect(refused.message).toContain('runs past');
    // the honest table reads
    expect(parseFont(withGvar(table), { wght: 900 }).ok).toBe(true);
  });

  it('a glyph of 20 000 points with 4095 tuples is refused before any tuple is read, within a time bound (the fan font)', () => {
    const started = Date.now();
    const refused = refusal(gvarTupleFanFont(4095), { wght: 900 });
    expect(refused.code).toBe('WRP_FONT_PARSE');
    expect(refused.message).toContain('more than');
    expect(Date.now() - started).toBeLessThan(2000);
    // fewer tuples is cheap enough to be read
    expect(parseFont(gvarTupleFanFont(8), { wght: 900 }).ok).toBe(true);
  });

  it('the no-variation index 0xFFFF / 0xFFFF is a delta of 0, not a damaged table', () => {
    const store: StoreSpec = {
      axisCount: 2,
      regions: [
        [
          [0, 1, 1],
          [0, 0, 0],
        ],
      ],
      data: [{ regionIndexes: [0], rows: [[50]] }],
    };
    const bytes = variable({
      tables: {
        MVAR: buildMvar(
          [
            ['hasc', 0xffff, 0xffff],
            ['hdsc', 0, 0],
          ],
          store,
        ),
      },
    });
    const font = load(bytes, { wght: 900 });
    expect(font.ascender).toBe(900);
    expect(font.descender).toBe(-250 + 50);
  });

  it('the origin of the root glyph stays at phantom point 1: its x delta moves the whole outline the other way, and the advance is pp2 - pp1', () => {
    // triangle: 3 points, so pp1 = 3 and pp2 = 4; at wght 900 pp1 moves by +10 and pp2 by +30
    const bytes = variable({
      gvar: { glyphs: [null, TUPLES[1] as never, { tuples: [t({ shared: 0, points: [3, 4], dx: [10, 30], dy: [0, 0] })] }, null, null] },
    });
    const font = load(bytes, { wght: 900 });
    expectPoints(font, 2, [
      [-10, 0],
      [90, 0],
      [40, 100],
    ]);
    expect(font.advance(2)).toBe(720);
    // the root composite: pp1 is point 2 (after its two components); its delta of +7 moves both components the other way
    const root = variable({
      gvar: { glyphs: [null, TUPLES[1] as never, null, { tuples: [t({ shared: 0, points: [2], dx: [7], dy: [0] })] }, null] },
    });
    const loops = load(root, { wght: 900 }).outline(3);
    expect(loopBox(loops[0] as OutlineLoop)).toEqual({ min: [-7, 0], max: [133, 100] });
    expect(loopBox(loops[1] as OutlineLoop)).toEqual({ min: [193, 0], max: [333, 100] });
    // a component of a composite keeps its own offsets: only the root's pp1 shifts the composite
    const composite = variable({
      gvar: { glyphs: [null, { tuples: [t({ shared: 0, points: [8], dx: [5], dy: [0] })] }, null, null, null] },
    });
    expectPoints(
      load(composite, { wght: 900 }),
      1,
      BASE_SQUARE.map(([x, y]) => [x - 5, y] as const),
    );
    expect(loopBox(load(composite, { wght: 900 }).outline(3)[1] as OutlineLoop)).toEqual({ min: [200, 0], max: [300, 100] });
  });

  it('the work of a font is charged to a shared budget: one tuple of every point of a glyph costs its points', () => {
    const table = good();
    const gvar = readGvar(new ByteView(new Uint8Array(table), 0, table.length, 'gvar'), 5, 2);
    const geometry = { xs: SQUARE.map((p) => p.x), ys: SQUARE.map((p) => p.y), ends: [7] };
    const budget = { remaining: 3 };
    expect(() => gvar.deltas(1, [1, 0], geometry, budget)).toThrow(/more tuple work/);
    const roomy = { remaining: 1000 };
    expect(gvar.deltas(1, [1, 0], geometry, roomy)).not.toBeNull();
    expect(roomy.remaining).toBeLessThan(1000);
    expect(gvar.deltas(1, [0, 0], geometry)).toBeNull();
    // a tuple whose scalar is 0 still costs the points of the glyph: four of them exhaust a budget of 40
    expect(() => gvar.deltas(1, [0, 0], geometry, { remaining: 40 })).toThrow(/more tuple work/);
    expect(gvar.deltas(40, [1, 0], geometry)).toBeNull();
  });

  it('IUP of an untouched point beyond the range of the two touched points takes the delta of the nearer end, inside it the interpolation', () => {
    const table = buildGvar({ axisCount: 1, glyphs: [{ tuples: [t({ peak: [1], points: [0, 1], dx: [0, 10], dy: [0, 0] })] }] });
    const gvar = readGvar(new ByteView(new Uint8Array(table), 0, table.length, 'gvar'), 1, 1);
    const geometry = { xs: [0, 100, 200, 50, -50], ys: [0, 0, 0, 0, 0], ends: [4] };
    const found = gvar.deltas(0, [1], geometry);
    expect(found?.dx.slice(0, 5)).toEqual([0, 10, 10, 5, 0]);
  });

  it('packed point and delta encoders agree with the layout the parser reads', () => {
    expect(packPoints('all')).toEqual([0]);
    expect(packPoints([3, 5])).toEqual([2, 1, 3, 2]);
    expect(packDeltas([0, 0, 5, -3, 300])).toEqual([0x81, 1, 5, 0xfd, 0x40, 1, 44]);
  });

  it('a TrueType font with fvar but without gvar refuses an instance; without fvar a variation is refused', () => {
    const noGvar = variable({ omit: ['gvar'] });
    expect(refusal(noGvar, { wght: 900 }).message).toContain('only CFF2 and TrueType gvar');
    expect(load(noGvar, { wght: 400 }).instance).toEqual({});
    const noFvar = variable({ omit: ['fvar'] });
    expect(refusal(noFvar, { wght: 900 }).message).toContain('no variation axes');
  });
});

const BAHNSCHRIFT = 'C:/Windows/Fonts/bahnschrift.ttf';
describe.skipIf(!existsSync(BAHNSCHRIFT))('a real variable font (Bahnschrift: gvar + avar + HVAR + MVAR)', () => {
  const bytes = existsSync(BAHNSCHRIFT) ? new Uint8Array(readFileSync(BAHNSCHRIFT)) : new Uint8Array();
  const glyphWidth = (font: ParsedFont, char: string): number => {
    const loops = font.outline(font.glyphIndex(char.codePointAt(0) as number));
    const boxes = loops.map((loop) => loopBox(loop)).filter((box) => box !== null);
    return Math.max(...boxes.map((box) => box.max[0])) - Math.min(...boxes.map((box) => box.min[0]));
  };
  const segmentCount = (font: ParsedFont, char: string): number =>
    font.outline(font.glyphIndex(char.codePointAt(0) as number)).reduce((sum, loop) => sum + loop.length, 0);

  it('lists the axes and the default instance equals the static outlines', () => {
    const font = load(bytes);
    expect(font.axes.map((a) => a.tag)).toEqual(expect.arrayContaining(['wght', 'wdth']));
    expect(segmentCount(font, 'H')).toBeGreaterThan(0);
    expect(load(bytes, Object.fromEntries(font.axes.map((a) => [a.tag, a.default]))).instance).toEqual({});
  });

  it('the stem of the I grows with the weight and the H narrows (and its advance shrinks) with the width axis; point structure is the same at every instance', () => {
    const font = load(bytes);
    const wghtAxis = font.axes.find((a) => a.tag === 'wght') as { min: number; max: number };
    const wdthAxis = font.axes.find((a) => a.tag === 'wdth') as { min: number };
    const light = load(bytes, { wght: wghtAxis.min });
    const bold = load(bytes, { wght: wghtAxis.max });
    expect(glyphWidth(light, 'I')).toBeLessThan(glyphWidth(font, 'I'));
    expect(glyphWidth(font, 'I')).toBeLessThan(glyphWidth(bold, 'I'));
    const condensed = load(bytes, { wdth: wdthAxis.min });
    expect(glyphWidth(condensed, 'H')).toBeLessThan(glyphWidth(font, 'H'));
    expect(condensed.advance(condensed.glyphIndex(0x48))).toBeLessThan(font.advance(font.glyphIndex(0x48)));
    for (const other of [light, bold, condensed]) expect(segmentCount(other, 'H')).toBe(segmentCount(font, 'H'));
  });

  it('every glyph of three instances reads within the budgets, and a half-way weight lies between the extremes', () => {
    for (const values of [{}, { wght: 700 }, { wght: 300, wdth: 90 }]) {
      const font = load(bytes, values);
      expect(validateGlyphs(font)).toEqual({ ok: true });
    }
    const font = load(bytes);
    const wghtAxis = font.axes.find((a) => a.tag === 'wght') as { min: number; max: number };
    const middle = glyphWidth(load(bytes, { wght: (wghtAxis.min + wghtAxis.max) / 2 }), 'I');
    expect(middle).toBeGreaterThan(glyphWidth(load(bytes, { wght: wghtAxis.min }), 'I'));
    expect(middle).toBeLessThan(glyphWidth(load(bytes, { wght: wghtAxis.max }), 'I'));
  });
});
