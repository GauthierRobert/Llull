/**
 * Test fonts of the 03 WRP M4 CFF work whose outlines are known by construction: a CFF2 variable font (`variableSpec`: two axes, four regions, three variation data
 * subtables, `avar`, `HVAR`) and a name-keyed CFF font with accented glyphs (`seacSpec`). Every expected number in the tests follows from the charstring programs here.
 */

import type { CffSpec } from './cffBuilder';
import { buildCff2Font, buildAvar, buildHvar, type AxisSpec, type Cff2Spec, type StoreSpec } from './cff2Builder';
import { buildCffFont } from './cffBuilder';

export const AXES: readonly AxisSpec[] = [
  { tag: 'wght', min: 100, default: 400, max: 900 },
  { tag: 'wdth', min: 75, default: 100, max: 125 },
];

/** regions[r][axis] = [start, peak, end]: R0 wght+, R1 wght-, R2 wdth+, R3 wght+ x wdth+, R4 wght in [0, 0.5, 1] (a peak inside the range), R5 start > peak and R6 spanning 0 with a peak (both invalid: the axis is ignored, scalar 1). */
const REGIONS: StoreSpec['regions'] = [
  [
    [0, 1, 1],
    [0, 0, 0],
  ],
  [
    [-1, -1, 0],
    [0, 0, 0],
  ],
  [
    [0, 0, 0],
    [0, 1, 1],
  ],
  [
    [0, 1, 1],
    [0, 1, 1],
  ],
  [
    [0, 0.5, 1],
    [0, 0, 0],
  ],
  [
    [0.5, 0.25, 1],
    [0, 0, 0],
  ],
  [
    [-1, 0.5, 1],
    [0, 0, 0],
  ],
];

export const STORE: StoreSpec = {
  axisCount: 2,
  regions: REGIONS,
  data: [
    { regionIndexes: [0, 1] },
    { regionIndexes: [2] },
    { regionIndexes: [0, 2, 3] },
    { regionIndexes: [4] },
    { regionIndexes: [5, 6] },
  ],
};

/** Glyph 1 'A': a rectangle from x = 100, 700 high, whose width is 500 + 300 * wght+ - 100 * wght- (vsindex 0). */
const A = [100, 0, 'rmoveto', 500, 700, -500, 300, -100, 0, 0, -300, 100, 3, 'blend', 'hlineto'] as const;
/** Glyph 2 'B': a right triangle 300 wide and 600 + 200 * wdth+ high (vsindex 1, one region). */
const B = [1, 'vsindex', 0, 0, 'rmoveto', 600, 300, 200, 0, 2, 'blend', 'vlineto'] as const;
/** Glyph 3 'C': a right triangle 600 high and 400 + 100 * wght+ + 50 * wdth+ + 20 * wght+ * wdth+ wide (vsindex 2, three regions). */
const C = [2, 'vsindex', 0, 0, 'rmoveto', 400, 600, 100, 50, 20, 0, 0, 0, 2, 'blend', 'hlineto'] as const;
/** Glyph 4 'D': like 'A' but the blend sits in a local subroutine (the stack crosses the call). */
const D = [100, 0, 'rmoveto', -107, 'callsubr', 'hlineto'] as const;
/** Glyph 5 'E': hstemhm with two stems, hintmask with an implicit vstem (3 stems, a 1-byte mask), then a triangle 300 x 200. */
const E = [10, 20, 30, 40, 'hstemhm', 5, 15, 'hintmask', { raw: [0xe0] }, 0, 0, 'rmoveto', 300, 'hlineto', 200, 'vlineto'] as const;

/** Glyph 6 'F': a triangle 100 + 40 * (tent over wght 0 / 0.5 / 1) wide and 200 high (vsindex 3), the intermediate-region branch. */
const F = [3, 'vsindex', 0, 0, 'rmoveto', 100, 200, 40, 0, 2, 'blend', 'hlineto'] as const;
/** Glyph 7 'G': 100 + 10 + 20 wide at every instance: two invalid regions are ignored axes (scalar 1). */
const G = [4, 'vsindex', 0, 0, 'rmoveto', 100, 200, 10, 20, 0, 0, 2, 'blend', 'hlineto'] as const;

export const variableCff2 = (extra: Partial<Cff2Spec> = {}): Cff2Spec => ({
  glyphs: [
    { tokens: [] },
    { tokens: [...A] },
    { tokens: [...B] },
    { tokens: [...C] },
    { tokens: [...D] },
    { tokens: [...E] },
    { tokens: [...F] },
    { tokens: [...G] },
  ],
  fonts: [{ localSubrs: [[500, 700, 300, -100, 0, 0, 2, 'blend']] }],
  store: STORE,
  ...extra,
});

/** Advance deltas by glyph: A +100 (wght+) / -50 (wght-), B +40 (wdth+), the other glyphs none. */
const HVAR_STORE: StoreSpec = {
  axisCount: 2,
  regions: REGIONS,
  data: [
    {
      regionIndexes: [0, 1, 2],
      rows: [
        [0, 0, 0],
        [100, -50, 0],
        [0, 0, 40],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    },
  ],
};

/** wght: -1..-1, 0..0, 0.5 -> 0.25, 1..1 (a bent axis, so `avar` changes the instance); wdth: identity. */
const AVAR = buildAvar([
  [
    [-1, -1],
    [0, 0],
    [0.5, 0.25],
    [1, 1],
  ],
  [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
]);

export interface VariableOptions {
  readonly avar?: boolean;
  readonly hvar?: boolean | readonly number[];
  readonly cff2?: Partial<Cff2Spec>;
}

export function variableFont(options: VariableOptions = {}): Uint8Array {
  return buildCff2Font({
    cff2: variableCff2(options.cff2),
    axes: AXES,
    ...(options.avar === true ? { avar: AVAR } : {}),
    ...(options.hvar === undefined || options.hvar === false
      ? {}
      : { hvar: buildHvar(HVAR_STORE, options.hvar === true ? undefined : options.hvar) }),
  });
}

/** A name-keyed CFF font: 'A' (SID 34), 'acute' (SID 125), the accented 'Aacute' by seac (base 65, accent 194 shifted by 200, 750). */
export function seacSpec(extra: Partial<CffSpec> = {}, withCharset = true): CffSpec {
  return {
    glyphs: [
      { tokens: ['endchar'] },
      { tokens: [100, 0, 'rmoveto', 200, 'dup', 'add', 700, -400, 'hlineto', 'endchar'] },
      { tokens: [0, 0, 'rmoveto', 100, 100, 'hlineto', 'endchar'] },
      { tokens: [200, 750, 65, 194, 'endchar'] },
    ],
    ...(withCharset ? { charset: [34, 125, 391] } : {}),
    ...extra,
  };
}

export const seacFont = (extra: Partial<CffSpec> = {}): Uint8Array => buildCffFont(seacSpec(extra));
