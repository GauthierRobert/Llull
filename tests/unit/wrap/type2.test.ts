/**
 * 03 WRP M4: the Type 2 operators of CFF 1.x that were refused before DES-3c: arithmetic / storage / stack operators (one oracle per operator), the deprecated
 * four-argument `endchar` (`seac`, accented glyphs through the Standard Encoding and the charset), hint operators with mask byte counts, and every bound of the interpreter.
 */

import { describe, expect, it } from 'vitest';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { loopArea, loopBox, type OutlineLoop } from '@lib/font/outline';
import { buildCffFont, dictInt, type CffSpec, type Token } from './cffBuilder';
import { seacSpec } from './variableFonts';

const load = (spec: CffSpec): ParsedFont => {
  const parsed = parseFont(buildCffFont(spec));
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
};

const refusal = (spec: CffSpec): string => {
  const parsed = parseFont(buildCffFont(spec));
  if (!parsed.ok) return parsed.message;
  const scan = validateGlyphs(parsed.font);
  if (scan.ok) throw new Error('expected a refusal');
  return scan.message;
};

const glyphs = (...programs: Token[][]): CffSpec['glyphs'] => [{ tokens: ['endchar'] }, ...programs.map((tokens) => ({ tokens }))];

/** The value a program leaves on the stack, read as the length of one horizontal line from the origin (`hlineto`). */
const valueOf = (...program: Token[]): number => {
  const loops = load({ glyphs: glyphs([...program, 'hlineto', 'endchar']) }).outline(1);
  const segment = (loops[0] as OutlineLoop)[0];
  if (segment === undefined || segment.kind !== 'line') throw new Error('no line');
  return segment.to[0];
};

describe('arithmetic, storage and stack operators (Type 2, 12 3 .. 12 30)', () => {
  const cases: Array<[string, Token[], number]> = [
    ['add', [7, 5, 'add'], 12],
    ['sub', [7, 5, 'sub'], 2],
    ['div', [6, 4, 'div'], 1.5],
    ['neg', [9, 'neg'], -9],
    ['abs', [-9, 'abs'], 9],
    ['mul', [3, 4, 'mul'], 12],
    ['sqrt', [16, 'sqrt'], 4],
    ['dup', [3, 'dup', 'mul'], 9],
    ['exch', [3, 7, 'exch', 'sub'], 4],
    ['drop', [9, 8, 'drop'], 9],
    ['index 1', [10, 20, 30, 1, 'index', 'add', 'add', 'add'], 80],
    ['index with a negative number copies the top', [5, 9, -1, 'index', 'add', 'add'], 23],
    ['roll up', [1, 2, 3, 3, 1, 'roll', 'sub', 'sub'], 4],
    ['roll down', [1, 2, 4, 3, -1, 'roll', 'sub', 'sub'], -1],
    ['roll of nothing', [5, 0, 1, 'roll'], 5],
    ['and (false)', [3, 0, 'and', 10, 'add'], 10],
    ['and (true)', [3, 2, 'and', 10, 'add'], 11],
    ['or (false)', [0, 0, 'or', 10, 'add'], 10],
    ['or (true)', [0, 5, 'or', 10, 'add'], 11],
    ['not of zero', [0, 'not', 10, 'add'], 11],
    ['not of a number', [4, 'not', 10, 'add'], 10],
    ['eq (equal)', [3, 3, 'eq', 10, 'add'], 11],
    ['eq (different)', [3, 4, 'eq', 10, 'add'], 10],
    ['ifelse takes s1 when v1 <= v2', [10, 20, 1, 2, 'ifelse'], 10],
    ['ifelse takes s2 when v1 > v2', [10, 20, 3, 2, 'ifelse'], 20],
    ['put then get', [42, 5, 'put', 5, 'get'], 42],
    ['an unset storage cell reads 0', [3, 'get', 7, 'add'], 7],
    ['dotsection is ignored and clears the stack', [10, 'dotsection', 5], 5],
    ['a fraction survives the 16.16 operand', [0.25, 0.5, 'add'], 0.75],
  ];
  for (const [name, program, expected] of cases)
    it(`${name}`, () => {
      expect(valueOf(...program)).toBeCloseTo(expected, 9);
    });

  it('random is a fixed pseudo-random sequence in (0, 1] per glyph: the same glyph always draws the same outline', () => {
    const first = valueOf('random');
    const x0 = (Math.imul(0x9e3779b9, 1664525) + 1013904223) >>> 0;
    expect(first).toBeCloseTo((x0 + 1) / 4294967296, 12);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(1);
    expect(valueOf('random')).toBe(first);
    expect(valueOf('random', 'random', 'sub')).not.toBe(0);
    const twoGlyphs = load({ glyphs: glyphs(['random', 'hlineto', 'endchar'], ['random', 'hlineto', 'endchar']) });
    expect(JSON.stringify(twoGlyphs.outline(1))).toBe(JSON.stringify(twoGlyphs.outline(2)));
  });

  it('leaves the rest of the stack in place (an operator before the path does not clear the operands of the path)', () => {
    const loops = load({ glyphs: glyphs([0, 0, 'rmoveto', 100, 0, 3, 4, 'add', 'drop', 'hlineto', 100, 'vlineto', 'endchar']) }).outline(1);
    expect(loopBox(loops[0] as OutlineLoop)).toEqual({ min: [0, 0], max: [100, 100] });
  });

  it('refuses division by zero, a negative square root, a storage cell outside 0..31, an index or roll past the stack, a fractional cell and an operand beyond 2^31', () => {
    const message = (...program: Token[]): string => refusal({ glyphs: glyphs([...program, 'endchar']) });
    expect(message(1, 0, 'div')).toContain('div by zero');
    expect(message(-4, 'sqrt')).toContain('sqrt of a negative');
    expect(message(1, 32, 'put')).toContain('put cell 32');
    expect(message(1, -1, 'put')).toContain('put cell -1');
    expect(message(32, 'get')).toContain('get cell 32');
    expect(message(1, 5, 'index')).toContain('index 5 reaches below the stack');
    expect(message(1, 2, 5, 1, 'roll')).toContain('roll of 5 values on a stack of 2');
    expect(message(1, -2, 1, 'roll')).toContain('roll of -2 values');
    expect(message(1, 0.5, 'put')).toContain('put needs an integer');
    expect(message(32000, 32000, 'mul', 32000, 'mul')).toContain('beyond ±2^31');
    expect(message('add')).toContain('underflow');
    expect(message(1, 'exch')).toContain('underflow');
  });

  it('refuses a stack overflow by dup, by random and by index', () => {
    const message = (...program: Token[]): string => refusal({ glyphs: glyphs([...program, 'endchar']) });
    expect(message(1, ...Array.from({ length: 96 }, () => 'dup' as Token))).toContain('stack overflow');
    expect(message(...Array.from({ length: 96 }, () => 1 as Token), 'random')).toContain('stack overflow');
  });
});

describe('seac: the accented endchar', () => {
  const box = (loop: OutlineLoop | undefined): ReturnType<typeof loopBox> => (loop === undefined ? null : loopBox(loop));

  it('draws the base glyph and the accent moved by (adx, ady): A (code 65) plus acute (code 194)', () => {
    const font = load(seacSpec());
    const loops = font.outline(3);
    expect(loops).toHaveLength(2);
    expect(box(loops[0])).toEqual({ min: [100, 0], max: [500, 700] });
    expect(box(loops[1])).toEqual({ min: [200, 750], max: [300, 850] });
    expect(loopArea(loops[0] as OutlineLoop)).toBeCloseTo(-280000, 6);
    expect(loopArea(loops[1] as OutlineLoop)).toBeCloseTo(-5000, 6);
    expect(font.outline(1)).toHaveLength(1);
  });

  it('accepts the width argument ahead of the four seac operands', () => {
    const spec = seacSpec();
    const withWidth = load({
      ...spec,
      glyphs: spec.glyphs.map((glyph, k) => (k === 3 ? { tokens: [540, 200, 750, 65, 194, 'endchar'] } : glyph)),
    });
    expect(withWidth.outline(3)).toHaveLength(2);
  });

  it('finds the components through charset formats 1 and 2 (ranges), and through the predefined ISOAdobe charset', () => {
    for (const charsetBytes of [
      [1, 0, 34, 0, 0, 125, 1],
      [2, 0, 34, 0, 0, 0, 125, 0, 1],
    ])
      expect(load(seacSpec({ charsetBytes }, false)).outline(3)).toHaveLength(2);
    const many: CffSpec['glyphs'] = Array.from({ length: 135 }, (_, k) =>
      k === 34
        ? { tokens: [100, 0, 'rmoveto', 400, 700, -400, 'hlineto', 'endchar'] }
        : k === 131
          ? { tokens: [0, 0, 'rmoveto', 100, 100, 'hlineto', 'endchar'] }
          : k === 1
            ? { tokens: [200, 750, 65, 200, 'endchar'] }
            : { tokens: ['endchar'] },
    );
    expect(load(seacSpec({ glyphs: many }, false)).outline(1)).toHaveLength(2);
  });

  it('refuses a code without a Standard Encoding name, a code outside 0..255, a component the charset lacks, a nested seac, a CID-keyed font and an Expert charset', () => {
    const spec = seacSpec();
    const withGlyph = (tokens: Token[], extra: Partial<CffSpec> = {}): CffSpec => ({
      ...spec,
      glyphs: [...spec.glyphs.slice(0, 3), { tokens }],
      ...extra,
    });
    expect(refusal(withGlyph([0, 0, 1, 194, 'endchar']))).toContain('character code 1 has no Standard Encoding name');
    expect(refusal(withGlyph([0, 0, 65, 300, 'endchar']))).toContain('seac character code 300');
    expect(refusal(withGlyph([0, 0, 65, 1.5, 'endchar']))).toContain('seac character code 1.5');
    expect(refusal(withGlyph([0, 0, 66, 194, 'endchar']))).toContain("seac component '66' (string id 35) is not in the charset");
    expect(refusal({ ...spec, glyphs: [...spec.glyphs, { tokens: [0, 0, 225, 65, 'endchar'] }], charset: [34, 125, 138, 391] })).toContain(
      'itself an accented glyph',
    );
    expect(refusal({ glyphs: glyphs([0, 0, 65, 194, 'endchar']), cid: { secondLocalSubrs: [], secondFontGlyphs: [] } })).toContain(
      'only defined for name-keyed',
    );
    expect(refusal(seacSpec({ extraTopDict: [...dictInt(1), 15] }, false))).toContain('Expert charset');
    expect(refusal(seacSpec({ charsetBytes: [5, 0, 0] }, false))).toContain('charset format 5');
  });
});

describe('hint operators and their mask bytes', () => {
  const triangle: Token[] = [0, 0, 'rmoveto', 50, 'hlineto', 50, 'vlineto', 'endchar'];
  const numbers = (count: number): Token[] => Array.from({ length: count }, (_, k) => k + 1);
  const boxOf = (spec: CffSpec): ReturnType<typeof loopBox> => {
    const loops = load(spec).outline(1);
    return loops[0] === undefined ? null : loopBox(loops[0]);
  };

  it('skips ceil(stems / 8) mask bytes: 9 stems take two bytes, with the implicit vstem of the first hintmask counted', () => {
    const stems = [...numbers(16), 'hstemhm', 3, 4, 'hintmask'] as Token[];
    expect(boxOf({ glyphs: glyphs([...stems, { raw: [0xff, 0x80] }, ...triangle]) })).toEqual({ min: [0, 0], max: [50, 50] });
    const eight = [...numbers(14), 'hstemhm', 3, 4, 'hintmask'] as Token[];
    expect(boxOf({ glyphs: glyphs([...eight, { raw: [0xff] }, ...triangle]) })).toEqual({ min: [0, 0], max: [50, 50] });
  });

  it('counts hstem, vstem, hstemhm and vstemhm alike, a width ahead of the stems, and cntrmask; a second hintmask adds no stems', () => {
    const program: Token[] = [
      540,
      1,
      2,
      'hstem',
      3,
      4,
      5,
      6,
      'vstem',
      7,
      8,
      'vstemhm',
      'hintmask',
      { raw: [0xe0] },
      'cntrmask',
      { raw: [0xe0] },
      ...triangle,
    ];
    expect(boxOf({ glyphs: glyphs(program) })).toEqual({ min: [0, 0], max: [50, 50] });
  });

  it('refuses a number cut off by the end of its charstring instead of reading the next charstring', () => {
    for (const raw of [[28, 0], [247], [255, 0, 0]])
      expect(refusal({ glyphs: glyphs([{ raw }]) })).toContain('runs past the end of its charstring');
  });

  it('counts the stems of a subroutine and refuses more than 96 stems and a mask that runs past the charstring', () => {
    const forty = [...numbers(80), 'hstemhm'] as Token[];
    expect(refusal({ glyphs: glyphs([...forty, ...forty, ...forty, ...triangle]) })).toContain('more than 96 stem hints');
    expect(refusal({ glyphs: glyphs([1, 2, 'hstemhm', 'hintmask']) })).toContain('hint mask of 1 bytes');
    const viaSubr = load({
      glyphs: glyphs([-107, 'callsubr', 'hintmask', { raw: [0xc0] }, ...triangle]),
      localSubrs: [[1, 2, 3, 4, 'hstemhm', 'return']],
    });
    expect(viaSubr.outline(1)).toHaveLength(1);
  });
});
