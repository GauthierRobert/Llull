/**
 * 03 WRP M4: CFF (OpenType / PostScript outlines). Charstrings built from tokens reach every Type 2 operator the interpreter supports; compact operators are compared with their
 * rrcurveto / rlineto expansion; subroutines, CID-keyed fonts, widths, hint masks and every refusal of a damaged table are covered; the outlines go through text_outline,
 * extrude_profile and the document round trip like a TrueType font.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { setGeometryKernel } from '@core/geometry/kernel';
import { uint8ArrayToBase64 } from '@lib/base64';
import { createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { fillRegions } from '@lib/font/fill';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { flattenLoop, loopArea, loopBox, loopLength, mapLoop, type OutlineLoop, type OutlineSegment } from '@lib/font/outline';
import { buildCffFont, type CffSpec, type Token } from './cffBuilder';
import { buildFont } from './fontBuilder';

const KAPPA = 0.5522847498307936;

afterEach(() => {
  setFontProvider(null);
  setGeometryKernel(null);
});

const load = (spec: CffSpec): ParsedFont => {
  const parsed = parseFont(buildCffFont(spec));
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
};

const failure = (spec: CffSpec | Uint8Array): { code: string; message: string } => {
  const parsed = parseFont(spec instanceof Uint8Array ? spec : buildCffFont(spec));
  if (parsed.ok) {
    const scan = validateGlyphs(parsed.font);
    if (scan.ok) throw new Error('expected a refusal');
    return scan;
  }
  return parsed;
};

/** A glyph from tokens after a leading empty .notdef. */
const glyphs = (...tokenLists: Token[][]): CffSpec['glyphs'] => [{ tokens: ['endchar'] }, ...tokenLists.map((tokens) => ({ tokens }))];
const outlineOf = (spec: CffSpec, glyph = 1): readonly OutlineLoop[] => load(spec).outline(glyph);

/** Outline points as plain numbers, rounded, for comparison of two spellings of the same path. */
const shape = (loops: readonly OutlineLoop[]): string =>
  JSON.stringify(loops, (_key, value: unknown) => (typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value));

const polygonArea = (loop: OutlineLoop): number => {
  const polygon = flattenLoop(loop, 4096);
  let twice = 0;
  polygon.forEach((p, k) => {
    const q = polygon[(k + 1) % polygon.length] as [number, number];
    twice += p[0] * q[1] - q[0] * p[1];
  });
  return twice / 2;
};

describe('Type 2 charstrings', () => {
  it('lines: rmoveto / rlineto draw a closed loop, the width argument is skipped, and the outer loop is clockwise (TrueType convention)', () => {
    for (const width of [[], [310]] as const) {
      const loops = outlineOf({
        glyphs: glyphs([...width, 100, 100, 'rmoveto', 500, 0, 'rlineto', 0, 500, 'rlineto', -500, 0, 'rlineto', 'endchar']),
      });
      expect(loops).toHaveLength(1);
      expect(loops[0]).toHaveLength(4);
      expect(loopArea(loops[0] as OutlineLoop)).toBeCloseTo(-250000, 6);
      expect(loopLength(loops[0] as OutlineLoop)).toBeCloseTo(2000, 6);
    }
  });

  it('hmoveto / vmoveto start contours, a second moveto closes the first, a path without endchar is closed', () => {
    const loops = outlineOf({
      glyphs: glyphs(
        [50, 'hmoveto', 100, 'hlineto', 100, 'vlineto', 'endchar'],
        [10, 'hmoveto', 40, 'hlineto', 40, 'vlineto', 90, 'vmoveto', 30, 'hlineto', 30, 'vlineto'],
      ),
    });
    expect(loops).toHaveLength(1);
    const two = outlineOf(
      {
        glyphs: glyphs(
          [50, 'hmoveto', 100, 'hlineto', 100, 'vlineto', 'endchar'],
          [10, 'hmoveto', 40, 'hlineto', 40, 'vlineto', 90, 'vmoveto', 30, 'hlineto', 30, 'vlineto'],
        ),
      },
      2,
    );
    expect(two).toHaveLength(2);
    expect(Math.abs(loopArea(two[0] as OutlineLoop))).toBeCloseTo(800, 6);
    expect(Math.abs(loopArea(two[1] as OutlineLoop))).toBeCloseTo(450, 6);
  });

  it('compact operators equal their rrcurveto / rlineto expansion', () => {
    const pairs: Array<[string, Token[], Token[]]> = [
      ['hlineto', [10, 20, 'rmoveto', 100, 50, 30, 'hlineto'], [10, 20, 'rmoveto', 100, 0, 0, 50, 30, 0, 'rlineto']],
      ['vlineto', [10, 20, 'rmoveto', 100, 50, 30, 'vlineto'], [10, 20, 'rmoveto', 0, 100, 50, 0, 0, 30, 'rlineto']],
      ['hvcurveto', [0, 0, 'rmoveto', 10, 20, 30, 40, 'hvcurveto'], [0, 0, 'rmoveto', 10, 0, 20, 30, 0, 40, 'rrcurveto']],
      [
        'hvcurveto x2 with the final extra',
        [0, 0, 'rmoveto', 10, 20, 30, 40, 50, 60, 70, 80, 90, 'hvcurveto'],
        [0, 0, 'rmoveto', 10, 0, 20, 30, 0, 40, 0, 50, 60, 70, 80, 90, 'rrcurveto'],
      ],
      ['vhcurveto', [0, 0, 'rmoveto', 10, 20, 30, 40, 'vhcurveto'], [0, 0, 'rmoveto', 0, 10, 20, 30, 40, 0, 'rrcurveto']],
      [
        'vhcurveto with the final extra',
        [0, 0, 'rmoveto', 10, 20, 30, 40, 50, 'vhcurveto'],
        [0, 0, 'rmoveto', 0, 10, 20, 30, 40, 50, 'rrcurveto'],
      ],
      ['hhcurveto', [0, 0, 'rmoveto', 10, 20, 30, 40, 'hhcurveto'], [0, 0, 'rmoveto', 10, 0, 20, 30, 40, 0, 'rrcurveto']],
      ['hhcurveto with dy1', [0, 0, 'rmoveto', 5, 10, 20, 30, 40, 'hhcurveto'], [0, 0, 'rmoveto', 10, 5, 20, 30, 40, 0, 'rrcurveto']],
      ['vvcurveto', [0, 0, 'rmoveto', 10, 20, 30, 40, 'vvcurveto'], [0, 0, 'rmoveto', 0, 10, 20, 30, 0, 40, 'rrcurveto']],
      ['vvcurveto with dx1', [0, 0, 'rmoveto', 5, 10, 20, 30, 40, 'vvcurveto'], [0, 0, 'rmoveto', 5, 10, 20, 30, 0, 40, 'rrcurveto']],
      [
        'rcurveline',
        [0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 70, 80, 'rcurveline'],
        [0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 'rrcurveto', 70, 80, 'rlineto'],
      ],
      [
        'rlinecurve',
        [0, 0, 'rmoveto', 70, 80, 1, 2, 3, 4, 5, 6, 'rlinecurve'],
        [0, 0, 'rmoveto', 70, 80, 'rlineto', 1, 2, 3, 4, 5, 6, 'rrcurveto'],
      ],
      [
        'hflex',
        [0, 0, 'rmoveto', 10, 20, 15, 30, 40, 50, 60, 'hflex'],
        [0, 0, 'rmoveto', 10, 0, 20, 15, 30, 0, 'rrcurveto', 40, 0, 50, -15, 60, 0, 'rrcurveto'],
      ],
      [
        'flex',
        [0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 50, 'flex'],
        [0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 'rrcurveto', 7, 8, 9, 10, 11, 12, 'rrcurveto'],
      ],
      [
        'hflex1',
        [0, 0, 'rmoveto', 10, 20, 30, 40, 50, 60, 70, 80, 90, 'hflex1'],
        [0, 0, 'rmoveto', 10, 20, 30, 40, 50, 0, 'rrcurveto', 60, 0, 70, 80, 90, -(20 + 40 + 80), 'rrcurveto'],
      ],
      [
        'flex1 (horizontal last)',
        [0, 0, 'rmoveto', 100, 5, 100, 5, 100, 5, 100, 5, 100, 5, 60, 'flex1'],
        [0, 0, 'rmoveto', 100, 5, 100, 5, 100, 5, 'rrcurveto', 100, 5, 100, 5, 60, -25, 'rrcurveto'],
      ],
      [
        'flex1 (vertical last)',
        [0, 0, 'rmoveto', 5, 100, 5, 100, 5, 100, 5, 100, 5, 100, 60, 'flex1'],
        [0, 0, 'rmoveto', 5, 100, 5, 100, 5, 100, 'rrcurveto', 5, 100, 5, 100, -25, 60, 'rrcurveto'],
      ],
    ];
    for (const [name, compact, expanded] of pairs) {
      const [a, b] = [outlineOf({ glyphs: glyphs([...compact, 'endchar']) }), outlineOf({ glyphs: glyphs([...expanded, 'endchar']) })];
      expect(shape(a), name).toBe(shape(b));
      expect(a[0]?.length, name).toBeGreaterThan(1);
    }
  });

  it('hint operators: stems add to the mask length, hintmask / cntrmask skip ceil(stems / 8) bytes, a width may precede the first stem', () => {
    const stems = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 5, 6, 7, 8, 9, 10, 11, 12];
    // 8 stems by hstemhm, a 9th implied by the hintmask: the masks need 2 bytes
    const tokens: Token[] = [
      300,
      ...stems.slice(0, 16),
      'hstemhm',
      ...stems.slice(16, 18),
      'hintmask',
      { raw: [0xff, 0x80] },
      100,
      100,
      'rmoveto',
      50,
      'hlineto',
      50,
      'vlineto',
      'cntrmask',
      { raw: [0xaa, 0xaa] },
      'endchar',
    ];
    const loops = outlineOf({ glyphs: glyphs(tokens) });
    expect(loops).toHaveLength(1);
    expect(Math.abs(loopArea(loops[0] as OutlineLoop))).toBeCloseTo(1250, 6);
    const plain = outlineOf({ glyphs: glyphs([100, 100, 'rmoveto', 50, 'hlineto', 50, 'vlineto', 'endchar']) });
    expect(shape(loops)).toBe(shape(plain));
  });

  it('local and global subroutines use the bias, can return early, and nest', () => {
    const spec: CffSpec = {
      glyphs: glyphs([-107, 'callsubr', -107, 'callgsubr', 'endchar'], [-106, 'callsubr', 'endchar']),
      localSubrs: [
        [100, 100, 'rmoveto', 50, 'hlineto', 'return', 7, 7, 'rlineto'],
        [-107, 'callsubr', 50, 'vlineto', 'return'],
      ],
      globalSubrs: [[60, 'vlineto', 'return']],
    };
    const first = outlineOf(spec, 1);
    expect(first).toHaveLength(1);
    expect(Math.abs(loopArea(first[0] as OutlineLoop))).toBeCloseTo(0.5 * 50 * 60, 6);
    expect(Math.abs(loopArea(outlineOf(spec, 2)[0] as OutlineLoop))).toBeCloseTo(0.5 * 50 * 50, 6);
  });

  it('CID-keyed fonts pick the local subroutines of the font dict FDSelect names (format 0 and 3)', () => {
    for (const selectFormat of [0, 3] as const) {
      const spec: CffSpec = {
        glyphs: glyphs([-107, 'callsubr', 'endchar'], [-107, 'callsubr', 'endchar']),
        localSubrs: [[0, 0, 'rmoveto', 100, 'hlineto', 100, 'vlineto', 'return']],
        cid: { secondLocalSubrs: [[0, 0, 'rmoveto', 200, 'hlineto', 200, 'vlineto', 'return']], secondFontGlyphs: [2], selectFormat },
      };
      expect(Math.abs(loopArea(outlineOf(spec, 1)[0] as OutlineLoop))).toBeCloseTo(5000, 6);
      expect(Math.abs(loopArea(outlineOf(spec, 2)[0] as OutlineLoop))).toBeCloseTo(20000, 6);
    }
  });

  it('a ring of cubic circles: exact Green area against a dense polygon, one region with one hole', () => {
    const r = 400;
    const k = Math.round(KAPPA * r);
    // the four quarter cubics of a circle about the origin from (radius, 0), counter-clockwise or clockwise, as rrcurveto deltas
    const circle = (radius: number, kappa: number, counterClockwise: boolean): Token[] => {
      const quarters: Array<[number, number][]> = [
        [
          [radius, kappa],
          [kappa, radius],
          [0, radius],
        ],
        [
          [-kappa, radius],
          [-radius, kappa],
          [-radius, 0],
        ],
        [
          [-radius, -kappa],
          [-kappa, -radius],
          [0, -radius],
        ],
        [
          [kappa, -radius],
          [radius, -kappa],
          [radius, 0],
        ],
      ];
      const tokens: Token[] = [];
      let at: [number, number] = [radius, 0];
      const walk = (controls: Array<[number, number]>): void => {
        const [c1, c2, end] = controls as [[number, number], [number, number], [number, number]];
        tokens.push(c1[0] - at[0], c1[1] - at[1], c2[0] - c1[0], c2[1] - c1[1], end[0] - c2[0], end[1] - c2[1], 'rrcurveto');
        at = end;
      };
      if (counterClockwise) for (const quarter of quarters) walk(quarter);
      else
        for (const quarter of [...quarters].reverse()) {
          // a clockwise quarter is the counter-clockwise one run backwards: the start of the reversed quarter is the end of the original
          const [c1, c2] = quarter as [[number, number], [number, number], [number, number]];
          const start = quarters[(quarters.indexOf(quarter) + 3) % 4]?.[2] ?? [radius, 0];
          walk([c2, c1, start as [number, number]]);
        }
      return tokens;
    };
    const loops = outlineOf({
      glyphs: glyphs([
        r,
        0,
        'rmoveto',
        ...circle(r, k, true),
        -r / 2,
        0,
        'rmoveto',
        ...circle(r / 2, Math.round(KAPPA * (r / 2)), false),
        'endchar',
      ]),
    });
    expect(loops).toHaveLength(2);
    for (const loop of loops) {
      expect(loop.some((segment) => segment.kind === 'cubic')).toBe(true);
      expect(Math.abs(loopArea(loop) / polygonArea(loop) - 1)).toBeLessThan(1e-7);
      expect(loopLength(loop)).toBeGreaterThan(0);
    }
    const filled = fillRegions(loops);
    expect('regions' in filled && filled.regions.length).toBe(1);
    expect('regions' in filled && filled.regions[0]?.holes.length).toBe(1);
  });

  it('refuses an unresolvable seac, stack underflow, bad subroutines, recursion, too many operators and unknown escapes', () => {
    expect(failure({ glyphs: glyphs([10, 20, 65, 66, 'endchar']) }).code).toBe('WRP_FONT_PARSE');
    expect(failure({ glyphs: glyphs([1, 'and', 'endchar']) }).message).toContain('underflow');
    expect(failure({ glyphs: glyphs(['callsubr', 'endchar']) }).message).toContain('underflow');
    expect(failure({ glyphs: glyphs([5, 'callsubr', 'endchar']), localSubrs: [['return']] }).message).toContain('out of range');
    expect(failure({ glyphs: glyphs([-107, 'callsubr', 'endchar']) }).message).toContain('without subroutines');
    expect(failure({ glyphs: glyphs([-107, 'callsubr', 'endchar']), localSubrs: [[-107, 'callsubr']] }).message).toContain('nest');
    expect(failure({ glyphs: glyphs([{ raw: [12, 60] }, 'endchar']) }).message).toContain('not supported');
    expect(failure({ glyphs: glyphs([{ raw: [2] }, 'endchar']) }).message).toContain('operator 2');
    // 4 ^ 9 calls of an empty body exceed 200 000 operators
    const fan = (next: number): Token[] => [next, 'callsubr', next, 'callsubr', next, 'callsubr', next, 'callsubr', 'return'];
    const subrs: Token[][] = Array.from({ length: 9 }, (_, k) => fan(k + 1 - 107));
    subrs.push(['return']);
    expect(failure({ glyphs: glyphs([-107, 'callsubr', 'endchar']), localSubrs: subrs }).message).toContain('operators');
    const flood: Token[] = Array.from({ length: 100 }, () => 1);
    expect(failure({ glyphs: glyphs([...flood, 'endchar']) }).message).toContain('stack overflow');
    const points: Token[] = [0, 0, 'rmoveto', ...Array.from({ length: 25 }, () => [1, 1, 'rlineto'] as Token[]).flat()];
    expect(load({ glyphs: glyphs([...points, 'endchar']) }).outline(1)).toHaveLength(1);
  });

  it('refuses an operator with fewer operands than it consumes (no NaN coordinates)', () => {
    const cases: Array<[Token[], string]> = [
      [['rmoveto'], 'rmoveto'],
      [[5, 'rmoveto'], 'rmoveto'],
      [['hmoveto'], 'hmoveto'],
      [['vmoveto'], 'vmoveto'],
      [[0, 0, 'rmoveto', 'rlineto'], 'rlineto'],
      [[0, 0, 'rmoveto', 'hlineto'], 'hlineto'],
      [[0, 0, 'rmoveto', 'vlineto'], 'vlineto'],
      [[0, 0, 'rmoveto', 1, 2, 3, 'rrcurveto'], 'rrcurveto'],
      [[0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 7, 'rcurveline'], 'rcurveline'],
      [[0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 7, 'rlinecurve'], 'rlinecurve'],
      [[0, 0, 'rmoveto', 1, 2, 3, 'vvcurveto'], 'vvcurveto'],
      [[0, 0, 'rmoveto', 1, 2, 3, 'hhcurveto'], 'hhcurveto'],
      [[0, 0, 'rmoveto', 1, 2, 3, 'vhcurveto'], 'vhcurveto'],
      [[0, 0, 'rmoveto', 1, 2, 3, 'hvcurveto'], 'hvcurveto'],
      [[0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 'hflex'], 'hflex'],
      [[0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 'flex'], 'flex'],
      [[0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 7, 8, 'hflex1'], 'hflex1'],
      [[0, 0, 'rmoveto', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'flex1'], 'flex1'],
    ];
    for (const [body, name] of cases) {
      const result = failure({ glyphs: glyphs([...body, 'endchar']) });
      expect(result.code, name).toBe('WRP_FONT_PARSE');
      expect(result.message, name).toContain('operands');
    }
  });

  it('reads every DICT operand form (shortint, long int, one- and two-byte integers, real numbers) and refuses a reserved DICT byte', () => {
    // FontMatrix-like reals "0.001", "-1.5E-3", "2E3", then 1000 as shortint, 100000 as long int, 108 and -108 as two-byte integers
    const extra = [
      30, 0x0a, 0x00, 0x1f, 30, 0xe1, 0xa5, 0xc3, 0xff, 30, 0x2b, 0x3f, 12, 7, 28, 0x03, 0xe8, 29, 0x00, 0x01, 0x86, 0xa0, 247, 0, 251, 0,
      13,
    ];
    const font = load({ glyphs: glyphs([0, 0, 'rmoveto', 10, 0, 'rlineto', 0, 10, 'rlineto', 'endchar']), extraTopDict: extra });
    expect(font.outline(1)).toHaveLength(1);
    expect(failure({ glyphs: glyphs(['endchar']), extraTopDict: [22] }).message).toContain('DICT byte 22');
  });

  it('reads long and fractional charstring operands, hints, and a path that starts without a moveto', () => {
    const outline = outlineOf({
      glyphs: glyphs([2000, 0.5, 'hstem', 1, 2, 'vstem', 0, 0, 'rmoveto', 2000, 0.5, 'rlineto', 0, 100, 'rlineto', 'endchar']),
    });
    expect(outline).toHaveLength(1);
    const noMove = outlineOf({ glyphs: glyphs([10, 0, 'rlineto', 0, 10, 'rlineto', 'endchar']) });
    expect(noMove).toHaveLength(1);
  });

  it('refuses a glyph with more than 20000 points and a font with no Top DICT, no CharStrings or a glyph past the CharStrings', () => {
    const lines: Token[] = Array.from({ length: 40 }, () => [1, 1, 'rlineto'] as Token[]).flat();
    const calls: Token[] = Array.from({ length: 600 }, () => [-107, 'callsubr'] as Token[]).flat();
    expect(failure({ glyphs: glyphs([0, 0, 'rmoveto', ...calls, 'endchar']), localSubrs: [[...lines, 'return']] }).message).toContain(
      'points',
    );
    const head = [0, 1, 1, 1, 5, 84, 101, 115, 116];
    expect(failure({ glyphs: glyphs(['endchar']), rawTail: [...head, 0, 0, 0, 0, 0, 0] }).message).toContain('Top DICT');
    expect(failure({ glyphs: glyphs(['endchar']), rawTail: [...head, 0, 1, 1, 1, 1, 0, 0, 0, 0] }).message).toContain('CharStrings');
    const spare = buildCffFont(
      { glyphs: glyphs(['endchar']) },
      { glyphs: [{ kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }], advances: [600, 600, 600], metrics: 3, codePoints: [[0x41, 1]] },
    );
    const parsed = parseFont(spare);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(validateGlyphs(parsed.font).ok).toBe(false);
  });

  it('reads a font without a Private DICT, and refuses a damaged FDSelect', () => {
    expect(outlineOf({ glyphs: glyphs([0, 0, 'rmoveto', 5, 0, 'rlineto', 0, 5, 'rlineto', 'endchar']), noPrivate: true })).toHaveLength(1);
    const cid = (selectBytes: number[]): CffSpec => ({
      glyphs: glyphs(['endchar']),
      cid: { secondLocalSubrs: [], secondFontGlyphs: [], selectBytes },
    });
    expect(failure(cid([7])).message).toContain('FDSelect format 7');
    expect(failure(cid([3, 0, 1, 0, 0, 0, 0, 0, 1])).message).toContain('no font for glyph');
  });

  it('refuses damaged CFF tables and CFF2 without crashing', () => {
    const good = buildCffFont({ glyphs: glyphs([0, 0, 'rmoveto', 10, 'hlineto', 10, 'vlineto', 'endchar']) });
    expect(parseFont(good).ok).toBe(true);
    expect(failure({ glyphs: glyphs(['endchar']), version: 2 }).message).toContain('CFF2');
    expect(failure({ glyphs: glyphs(['endchar']), rawTail: [0, 1, 1, 1, 0xff] }).code).toBe('WRP_FONT_PARSE');
    expect(failure({ glyphs: glyphs(['endchar']), rawTail: [] }).code).toBe('WRP_FONT_PARSE');
    const noCff = buildFont({ glyphs: [{ kind: 'empty' }], otto: true, omit: ['glyf', 'loca'] });
    expect(failure(noCff).code).toBe('WRP_FONT_FORMAT_UNSUPPORTED');
    for (let cut = 1; cut < 40; cut += 3) {
      const parsed = parseFont(
        buildCffFont({ glyphs: glyphs(['endchar']), rawTail: [1, 0, 4, 4, ...Array.from({ length: cut }, (_, k) => k * 37 + 1)] }),
      );
      expect(parsed.ok || parsed.code === 'WRP_FONT_PARSE').toBe(true);
    }
  });
});

describe('cubic outline math', () => {
  const cubic: OutlineSegment = { kind: 'cubic', from: [0, 0], control1: [0, 100], control2: [100, 100], to: [100, 0] };
  const loop: OutlineLoop = [cubic, { kind: 'line', from: [100, 0], to: [0, 0] }];

  it('area, length, box, flattening and mapping of a cubic', () => {
    expect(Math.abs(loopArea(loop) - polygonArea(loop))).toBeLessThan(1e-3);
    expect(loopArea(loop)).toBeCloseTo(-6000, 6); // the arch x(t) = 100 t^2 (3 - 2t), y(t) = 300 t (1 - t) encloses the integral of y dx = 6000
    const box = loopBox(loop);
    expect(box?.max[1]).toBeCloseTo(75, 9);
    expect(box?.min[0]).toBeCloseTo(0, 9);
    expect(loopLength([cubic])).toBeGreaterThan(100);
    expect(flattenLoop(loop, 8)).toHaveLength(9);
    const moved = mapLoop(loop, ([x, y]) => [2 * x + 1, 3 * y]);
    expect(loopArea(moved)).toBeCloseTo(6 * loopArea(loop), 9);
    const flat: OutlineSegment = { kind: 'cubic', from: [0, 0], control1: [1, 0], control2: [2, 0], to: [3, 0] };
    expect(loopBox([flat])?.max[0]).toBeCloseTo(3, 9);
    const wiggle: OutlineSegment = { kind: 'cubic', from: [0, 0], control1: [10, 0], control2: [-10, 5], to: [0, 5] };
    expect(loopBox([wiggle])?.min[0]).toBeLessThan(0);
  });
});

describe('a CFF font through the commands', () => {
  const square = (size: number): Token[] => [0, 0, 'rmoveto', size, 'hlineto', size, 'vlineto', -size, 'hlineto'];
  const spec: CffSpec = { glyphs: glyphs(square(500), square(500)) };
  const bytes = (): Uint8Array => buildCffFont(spec);

  it('parses as format cff with metrics, cmap and cap height; import_font keeps a font/otf blob and list_fonts says cff', () => {
    const parsed = parseFont(bytes());
    expect(parsed.ok && parsed.font.format).toBe('cff');
    const imported = execute({ ...createEmptyDocument(), units: 'mm' }, 'import_font', { base64: uint8ArrayToBase64(bytes()) });
    expect(imported.rejected, imported.summary).toBeUndefined();
    const record = imported.document.fonts?.[imported.affected[0] as string];
    expect(record).toMatchObject({ format: 'cff', unitsPerEm: 1000, capHeight: 700 });
    expect(imported.document.blobs?.[record?.blob as string]?.mediaType).toBe('font/otf');
    const listed = execute(imported.document, 'list_fonts', {});
    expect((listed.data as { fonts: Array<{ format: string }> }).fonts[0]?.format).toBe('cff');
  });

  it('text_outline of CFF text has the exact area, and the document with the font/otf blob survives a save and a load', () => {
    const imported = execute({ ...createEmptyDocument(), units: 'mm' }, 'import_font', { base64: uint8ArrayToBase64(bytes()) });
    const fontId = imported.affected[0] as string;
    const label = execute(imported.document, 'add_text', { content: 'AB', position: [0, 0, 0], height: 7, font: fontId });
    expect(label.rejected, label.summary).toBeUndefined();
    const outline = execute(label.document, 'text_outline', { id: label.affected[0] });
    // two 500 x 500 squares at scale 7 / 700 = 0.01 are 5 x 5 mm each
    expect((outline.data as { area: number }).area).toBeCloseTo(2 * 25, 9);
    const reloaded = deserializeDocument(serializeDocument(label.document));
    const again = execute(reloaded, 'text_outline', { id: label.affected[0] });
    expect((again.data as { area: number }).area).toBeCloseTo(50, 9);
  });

  it('extrude_profile of CFF text with curves gives the area times the depth', async () => {
    setGeometryKernel(await createManifoldKernel());
    const k = Math.round(KAPPA * 300);
    const round: Token[] = [300, 0, 'rmoveto', 0, k, k - 300, 300 - k, -300, 0, 'rrcurveto', 0, -k, 300 - k, k - 300, 300, 0, 'rrcurveto'];
    const imported = execute({ ...createEmptyDocument(), units: 'mm' }, 'import_font', {
      base64: uint8ArrayToBase64(buildCffFont({ glyphs: glyphs(round, round) })),
    });
    const label = execute(imported.document, 'add_text', { content: 'A', position: [0, 0, 0], height: 7, font: imported.affected[0] });
    const area = (execute(label.document, 'text_outline', { id: label.affected[0] }).data as { area: number }).area;
    const solid = execute(label.document, 'extrude_profile', { id: label.affected[0], depth: 2 });
    expect(solid.rejected, solid.summary).toBeUndefined();
    const volume = (execute(solid.document, 'mass_properties', { entityId: solid.affected[0] }).data as { volume: number }).volume;
    // the manifold kernel extrudes a polygon of the circle: its area is below the exact one by a few 1e-3
    expect(Math.abs(volume / (2 * area) - 1)).toBeLessThan(6e-3);
  });
});
