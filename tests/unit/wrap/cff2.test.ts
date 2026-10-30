/**
 * 03 WRP M4: CFF2 variable fonts (fvar / avar / vstore / blend / vsindex / HVAR) read at an instance. The font is generated (tests/unit/wrap/variableFonts.ts), so every
 * expected area, box and advance follows from the charstring programs and the region geometry written there; the refusals of a hostile CFF2 table are covered here too.
 */

import { describe, expect, it } from 'vitest';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { loopArea, loopBox, type OutlineLoop } from '@lib/font/outline';
import { buildCff2, buildCff2Font, buildFvar, type Cff2Spec } from './cff2Builder';
import { AXES, STORE, variableCff2, variableFont } from './variableFonts';
import { buildFont } from './fontBuilder';

const load = (bytes: Uint8Array, variation: Record<string, number> = {}): ParsedFont => {
  const parsed = parseFont(bytes, variation);
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
};

const refusal = (bytes: Uint8Array, variation: Record<string, number> = {}): { code: string; message: string } => {
  const parsed = parseFont(bytes, variation);
  if (parsed.ok) {
    const scan = validateGlyphs(parsed.font);
    if (scan.ok) throw new Error('expected a refusal');
    return scan;
  }
  return parsed;
};

const A = 1;
const B = 2;
const C = 3;
const area = (font: ParsedFont, glyph: number): number => font.outline(glyph).reduce((sum, loop) => sum + loopArea(loop), 0);
const width = (loops: readonly OutlineLoop[]): number => {
  const box = loopBox(loops[0] as OutlineLoop);
  return (box?.max[0] ?? 0) - (box?.min[0] ?? 0);
};

describe('CFF2 default instance and axes', () => {
  it('reads the default instance: A is the 500 x 700 rectangle from x = 100, clockwise, and the axes are listed', () => {
    const font = load(variableFont());
    expect(font.format).toBe('cff');
    expect(font.axes).toEqual([
      { tag: 'wght', min: 100, default: 400, max: 900 },
      { tag: 'wdth', min: 75, default: 100, max: 125 },
    ]);
    expect(font.instance).toEqual({});
    const loops = font.outline(A);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
    expect(loopArea(loops[0] as OutlineLoop)).toBeCloseTo(-350000, 6);
    expect(loopBox(loops[0] as OutlineLoop)).toEqual({ min: [100, 0], max: [600, 700] });
    expect(font.advance(A)).toBe(600);
    expect(area(font, B)).toBeCloseTo(90000, 6);
    expect(area(font, C)).toBeCloseTo(-120000, 6);
    expect(font.outline(0)).toEqual([]);
    expect(font.glyphIndex(0x41)).toBe(A);
  });

  it('a value equal to the axis default is the default instance', () => {
    const font = load(variableFont(), { wght: 400, wdth: 100 });
    expect(font.instance).toEqual({});
    expect(area(font, A)).toBeCloseTo(-350000, 6);
  });
});

describe('CFF2 blend at an instance (the region scalars of the OpenType interpolation algorithm)', () => {
  it('wght 900 / 100 are the region peaks: A is 800 / 400 wide', () => {
    const high = load(variableFont(), { wght: 900 });
    expect(high.instance).toEqual({ wght: 900 });
    expect(loopBox(high.outline(A)[0] as OutlineLoop)).toEqual({ min: [100, 0], max: [900, 700] });
    expect(area(high, A)).toBeCloseTo(-560000, 6);
    expect(area(load(variableFont(), { wght: 100 }), A)).toBeCloseTo(-280000, 6);
  });

  it('half way between default and peak is half the delta (no avar), on the negative side too', () => {
    expect(area(load(variableFont(), { wght: 650 }), A)).toBeCloseTo(-650 * 700, 6);
    expect(width(load(variableFont(), { wght: 250 }).outline(A))).toBeCloseTo(450, 9);
  });

  it('avar bends the axis: wght 650 normalises to 0.5 and maps to 0.25 (width 575), 775 to 0.625 (687.5)', () => {
    expect(width(load(variableFont({ avar: true }), { wght: 650 }).outline(A))).toBeCloseTo(575, 9);
    expect(width(load(variableFont({ avar: true }), { wght: 775 }).outline(A))).toBeCloseTo(687.5, 9);
    expect(width(load(variableFont({ avar: true }), { wght: 250 }).outline(A))).toBeCloseTo(450, 9);
    expect(width(load(variableFont({ avar: true }), { wght: 100 }).outline(A))).toBeCloseTo(400, 9);
  });

  it('vsindex picks the variation data subtable of a glyph: B grows with wdth only, C blends wght, wdth and their product', () => {
    expect(area(load(variableFont(), { wdth: 125 }), B)).toBeCloseTo((300 * 800) / 2, 6);
    expect(area(load(variableFont(), { wdth: 75 }), B)).toBeCloseTo((300 * 600) / 2, 6);
    expect(area(load(variableFont(), { wght: 900 }), B)).toBeCloseTo((300 * 600) / 2, 6);
    const widthOfC = (variation: Record<string, number>): number => -area(load(variableFont(), variation), C) / 300;
    expect(widthOfC({})).toBeCloseTo(400, 9);
    expect(widthOfC({ wght: 900 })).toBeCloseTo(500, 9);
    expect(widthOfC({ wdth: 125 })).toBeCloseTo(450, 9);
    expect(widthOfC({ wght: 900, wdth: 125 })).toBeCloseTo(570, 9);
    expect(widthOfC({ wght: 650, wdth: 112.5 })).toBeCloseTo(480, 9);
  });

  it('intermediate regions: the tent over wght 0 / 0.5 / 1 rises and falls, and invalid regions are ignored axes (scalar 1)', () => {
    const widthOf = (variation: Record<string, number>, glyph: number): number => -area(load(variableFont(), variation), glyph) / 100;
    const f = (wght: number): number => (widthOf({ wght }, 6) * 100) / 100;
    expect(f(400)).toBeCloseTo(100, 9);
    expect(f(525)).toBeCloseTo(120, 9);
    expect(f(650)).toBeCloseTo(140, 9);
    expect(f(775)).toBeCloseTo(120, 9);
    expect(f(900)).toBeCloseTo(100, 9);
    expect(f(250)).toBeCloseTo(100, 9);
    for (const wght of [100, 400, 650, 900]) expect(-area(load(variableFont(), { wght }), 7)).toBeCloseTo((130 * 200) / 2, 6);
  });

  it('a blend inside a local subroutine, and hint operators with a mask, draw the same glyph', () => {
    const font = load(variableFont(), { wght: 900 });
    expect(loopBox(font.outline(4)[0] as OutlineLoop)).toEqual({ min: [100, 0], max: [900, 700] });
    expect(font.outline(5)).toHaveLength(1);
    expect(area(font, 5)).toBeCloseTo(-30000, 6);
  });

  it('the same bytes at the same instance give the same outlines (deterministic)', () => {
    const bytes = variableFont({ avar: true });
    const first = JSON.stringify(load(bytes, { wght: 777, wdth: 88 }).outline(C));
    expect(JSON.stringify(load(bytes, { wdth: 88, wght: 777 }).outline(C))).toBe(first);
  });
});

describe('HVAR advances', () => {
  it('adds the interpolated advance delta at an instance, rounded to a font unit', () => {
    const bytes = variableFont({ hvar: true });
    expect(load(bytes).advance(A)).toBe(600);
    expect(load(bytes, { wght: 900 }).advance(A)).toBe(700);
    expect(load(bytes, { wght: 100 }).advance(A)).toBe(550);
    expect(load(bytes, { wght: 650 }).advance(A)).toBe(650);
    expect(load(bytes, { wdth: 125 }).advance(B)).toBe(640);
    expect(load(bytes, { wdth: 87.5 }).advance(B)).toBe(600);
    expect(load(bytes, { wght: 900 }).advance(B)).toBe(600);
    expect(load(variableFont(), { wght: 900 }).advance(A)).toBe(600);
  });

  it('reads advances through a DeltaSetIndexMap (the last entry serves the glyphs past the map)', () => {
    const bytes = variableFont({ hvar: [3, 2, 1] });
    const font = load(bytes, { wght: 900, wdth: 125 });
    expect(font.advance(0)).toBe(600);
    expect(font.advance(A)).toBe(640);
    expect(font.advance(B)).toBe(700);
    expect(font.advance(C)).toBe(700);
  });
});

describe('variation refusals (WRP_FONT_VARIATION)', () => {
  it('an unknown axis, a value outside the range, a font without axes, a TrueType font without gvar and an avar version 2 without its offsets', () => {
    const bytes = variableFont();
    expect(refusal(bytes, { slnt: 0 })).toMatchObject({ code: 'WRP_FONT_VARIATION', message: expect.stringContaining("no axis 'slnt'") });
    expect(refusal(bytes, { wght: 901 }).message).toContain('outside 100..900');
    expect(refusal(bytes, { wght: Number.NaN }).code).toBe('WRP_FONT_VARIATION');
    const plain = buildCff2Font({ cff2: variableCff2({ store: null }) });
    expect(refusal(plain, { wght: 500 })).toMatchObject({
      code: 'WRP_FONT_VARIATION',
      message: expect.stringContaining('no variation axes'),
    });
    const ttf = buildFont({ glyphs: [{ kind: 'empty' }, { kind: 'empty' }], codePoints: [[0x41, 1]], tables: { fvar: buildFvar(AXES) } });
    expect(refusal(ttf, { wght: 500 }).message).toContain('only CFF2');
    expect(load(ttf, { wght: 400 }).instance).toEqual({});
    const v2 = buildCff2Font({ cff2: variableCff2(), axes: AXES, avar: [0, 2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0] });
    // version 2 now follows its segment maps with the offsets of the axis index map and the delta store: a table that stops short is damaged
    expect(refusal(v2, { wght: 500 }).code).toBe('WRP_FONT_PARSE');
  });

  it('damaged fvar / avar are WRP_FONT_PARSE', () => {
    const base = { cff2: variableCff2() };
    const fvar = (bytes: number[]): Uint8Array => buildCff2Font({ ...base, font: { tables: { fvar: bytes } } });
    expect(refusal(fvar([0, 2, 0, 0, 0, 16]), {}).code).toBe('WRP_FONT_PARSE');
    const good = buildFvar(AXES);
    expect(refusal(fvar(good.map((byte, k) => (k === 11 ? 4 : byte)))).message).toContain('shorter than 20');
    expect(refusal(fvar(good.map((byte, k) => (k === 9 ? 65 : byte)))).message).toContain('axes exceed 64');
    const swapped = [...good];
    swapped.splice(16 + 4, 4, ...good.slice(16 + 12, 16 + 16));
    expect(refusal(fvar(swapped)).message).toContain('out of order');
    const twice = buildFvar([AXES[0] as (typeof AXES)[number], AXES[0] as (typeof AXES)[number]]);
    expect(refusal(fvar(twice)).message).toContain('listed twice');
    const avar = (bytes: number[]): Uint8Array => buildCff2Font({ ...base, axes: AXES, avar: bytes });
    expect(refusal(avar([0, 9, 0, 0, 0, 0, 0, 2])).message).toContain('avar: version 9');
    expect(refusal(avar([0, 1, 0, 0, 0, 0, 0, 3])).message).toContain('3 axes');
    const unsorted = [0, 1, 0, 0, 0, 0, 0, 2, 0, 2, 0x20, 0, 0x20, 0, 0x10, 0, 0x10, 0, 0, 0];
    expect(refusal(avar(unsorted)).message).toContain('not sorted');
  });
});

describe('CFF2 table structure and hostile charstrings', () => {
  const font = (spec: Partial<Cff2Spec>, axes = AXES): Uint8Array => buildCff2Font({ cff2: variableCff2(spec), axes });
  const glyphsOf = (...programs: Array<ReadonlyArray<number | string | { raw: number[] }>>): Cff2Spec['glyphs'] => [
    { tokens: [] },
    ...programs.map((tokens) => ({ tokens })),
  ];

  it('refuses CFF 1.x-only operators: endchar, arithmetic and dotsection', () => {
    expect(refusal(font({ glyphs: glyphsOf([0, 0, 'rmoveto', 'endchar']) })).message).toContain('endchar is not a CFF2 operator');
    expect(refusal(font({ glyphs: glyphsOf([1, 2, 'add', 'drop']) })).message).toContain('not a CFF2 operator');
    expect(refusal(font({ glyphs: glyphsOf(['dotsection']) })).message).toContain('operator 12 0 is not a CFF2 operator');
  });

  it('refuses return (CFF2 subroutines end with their charstring) and a number whose bytes run past the end of its charstring', () => {
    expect(refusal(font({ glyphs: glyphsOf([-107, 'callsubr']), fonts: [{ localSubrs: [['return']] }] })).message).toContain(
      'return is not a CFF2 operator',
    );
    for (const raw of [[28, 0], [28], [247], [251], [255, 0, 0, 0]])
      expect(refusal(font({ glyphs: glyphsOf([{ raw }]) })).message, `bytes ${raw.join(',')}`).toContain(
        'runs past the end of its charstring',
      );
    expect(load(font({ glyphs: glyphsOf([{ raw: [28, 0, 5] }]) })).outline(1)).toEqual([]);
  });

  it('refuses a bad vsindex, a blend without its operands and a negative blend count', () => {
    expect(refusal(font({ glyphs: glyphsOf([9, 'vsindex', 0, 0, 'rmoveto', 1, 1, 0, 1, 'blend']) })).message).toContain('subtable 9');
    expect(refusal(font({ glyphs: glyphsOf([0, 0, 'rmoveto', 1, 2, 3, 'blend', 5, 'hlineto']) })).message).toContain('needs 9 operands');
    expect(refusal(font({ glyphs: glyphsOf([0, 0, 'rmoveto', -1, 'blend']) })).message).toContain('blend of -1');
    expect(refusal(font({ glyphs: glyphsOf([0.5, 'vsindex']) })).message).toContain('integer');
    const withoutStore = buildCff2Font({
      cff2: variableCff2({ store: null, glyphs: glyphsOf([3, 'vsindex', 0, 0, 'rmoveto', 1, 'blend']) }),
    });
    expect(refusal(withoutStore).message).toContain('vsindex 3');
    const blendOnly = buildCff2Font({
      cff2: variableCff2({ store: null, glyphs: glyphsOf([0, 0, 'rmoveto', 10, 20, 2, 'blend', 'hlineto']) }),
    });
    expect(load(blendOnly).outline(1)).toHaveLength(1);
  });

  it('bounds the stack at 513, stems at 256, a hint mask at its charstring, and the charstring operators', () => {
    const flood = Array.from({ length: 514 }, () => 1);
    expect(refusal(font({ glyphs: glyphsOf(flood) })).message).toContain('stack overflow');
    expect(load(font({ glyphs: glyphsOf([...Array.from({ length: 512 }, () => 1)]) })).outline(1)).toEqual([]);
    const stems = Array.from({ length: 200 }, (_, k) => k);
    expect(refusal(font({ glyphs: glyphsOf([...stems, 'hstemhm', ...stems, 'hstemhm', ...stems, 'hstemhm']) })).message).toContain(
      '256 stem hints',
    );
    expect(refusal(font({ glyphs: glyphsOf([1, 2, 'hstemhm', 'hintmask']) })).message).toContain('hint mask of 1 bytes');
    expect(refusal(font({ glyphs: glyphsOf([-107, 'callsubr']), fonts: [{ localSubrs: [[-107, 'callsubr']] }] })).message).toContain(
      'nest',
    );
    expect(refusal(font({ glyphs: glyphsOf([5, 'callsubr']) })).message).toContain('out of range');
    expect(refusal(font({ glyphs: glyphsOf([{ raw: [2] }]) })).message).toContain('operator 2');
  });

  it('reads every FDSelect format with two font dicts, each with its own local subroutines', () => {
    const call = [0, 0, 'rmoveto', -107, 'callsubr', 'hlineto'] as const;
    const fonts = [{ localSubrs: [[40]] }, { localSubrs: [[60]] }];
    for (const selectFormat of [0, 3, 4] as const) {
      const parsed = load(font({ glyphs: glyphsOf([...call], [...call]), fonts, select: [0, 0, 1], selectFormat }));
      expect(loopBox(parsed.outline(1)[0] as OutlineLoop)?.max[0], `format ${selectFormat}`).toBe(40);
      expect(loopBox(parsed.outline(2)[0] as OutlineLoop)?.max[0], `format ${selectFormat}`).toBe(60);
    }
  });

  it('refuses a damaged FDSelect, a missing FDArray, an empty FDArray, a store of another axis count and truncated tables', () => {
    expect(refusal(font({ glyphs: glyphsOf(), select: [0], selectBytes: [7] })).message).toContain('FDSelect format 7');
    expect(refusal(font({ glyphs: glyphsOf([0, 0, 'rmoveto', 1, 'hlineto']), select: [0, 3], fonts: [{}] })).message).toContain(
      'names font dict 3',
    );
    expect(refusal(font({ select: [], selectBytes: [3, 0, 1, 0, 0, 0, 0, 0, 1] })).message).toContain('no font for glyph');
    expect(refusal(font({ select: [], selectBytes: [4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] })).message).toContain(
      'no font for glyph',
    );
    expect(refusal(font({ select: [], selectBytes: [4, 0, 1, 0, 1] })).message).toContain('65536');
    expect(refusal(font({ noFdArray: true })).message).toContain('no FDArray');
    expect(refusal(font({ fonts: [] })).message).toContain('empty');
    const wrongAxes = buildCff2Font({ cff2: variableCff2({ store: { ...STORE, axisCount: 1 } }), axes: AXES });
    expect(refusal(wrongAxes).message).toContain('1 axes');
    expect(refusal(buildCff2Font({ cff2: variableCff2(), axes: [AXES[0] as (typeof AXES)[number]] })).message).toContain('2 axes');
    const table = buildCff2(variableCff2());
    for (const cut of [3, 9, 20, 60, 120, table.length - 5]) {
      const parsed = parseFont(buildCff2Font({ cff2: variableCff2(), cff2Bytes: table.slice(0, cut), axes: AXES }));
      expect(parsed.ok ? !validateGlyphs(parsed.font).ok : parsed.code === 'WRP_FONT_PARSE', `cut ${cut}`).toBe(true);
    }
    expect(refusal(buildCff2Font({ cff2: variableCff2(), cff2Bytes: [2, 0, 4, 0, 0] })).message).toContain('header size');
    expect(refusal(buildCff2Font({ cff2: variableCff2(), cff2Bytes: [3, 0, 5, 0, 0] })).message).toContain('major version 3');
    expect(refusal(buildCff2Font({ cff2: variableCff2({ rawTail: [] }) })).code).toBe('WRP_FONT_PARSE');
    expect(refusal(font({ extraTop: [255] })).message).toContain('DICT byte 255');
  });

  it('refuses damaged variation stores: an unknown format, too many data subtables or regions, a region index outside the list, more words than regions', () => {
    const store = (patch: (bytes: number[]) => void): Uint8Array =>
      buildCff2Font({ cff2: variableCff2(), cff2Bytes: patchStore(buildCff2(variableCff2()), patch), axes: AXES });
    expect(refusal(store((s) => (s[1] = 2))).message).toContain('format 2');
    expect(refusal(store((s) => (s[6] = 0x20))).message).toContain('data subtables exceed');
    expect(refusal(store((s) => (s[30] = 0x20))).message).toContain('regions exceed');
    expect(refusal(store((s) => (s[123] = 9))).message).toContain('names a region outside');
    expect(refusal(store((s) => (s[119] = 5))).message).toContain('5 word deltas for 2 regions');
  });
});

/** The ItemVariationStore bytes inside a CFF2 table are the 2-byte length and the store after the CharStrings; patch them through `patch(store)`. */
function patchStore(table: number[], patch: (store: number[]) => void): number[] {
  const top = new DataView(new Uint8Array(table).buffer);
  const topLength = top.getUint16(3);
  const topDict = table.slice(5, 5 + topLength);
  const at = topDict.findIndex((byte, k) => byte === 24 && topDict[k - 5] === 29);
  const storeAt = new DataView(new Uint8Array(topDict).buffer).getUint32(at - 4);
  const length = top.getUint16(storeAt);
  const store = table.slice(storeAt + 2, storeAt + 2 + length);
  patch(store);
  return [...table.slice(0, storeAt + 2), ...store, ...table.slice(storeAt + 2 + length)];
}
