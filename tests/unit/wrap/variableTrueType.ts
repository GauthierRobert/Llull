/** The variable TrueType test font of the `gvar` / `avar` 2 / `MVAR` tests (03 WRP, TECHNICAL_SPEC §14.14): glyph outlines and tuple variations whose results are known by construction. */

import { buildFvar, buildHvar, type AxisSpec, type StoreSpec } from './cff2Builder';
import { buildFont, type GlyphPointSpec } from './fontBuilder';
import { buildAvar2, buildGvar, buildMvar, type GvarSpec, type TupleSpec } from './gvarBuilder';

const AXES: readonly AxisSpec[] = [
  { tag: 'wght', min: 100, default: 400, max: 900 },
  { tag: 'wdth', min: 75, default: 100, max: 125 },
];
/** Shared tuples: wght+, wght-, wdth+. */
export const SHARED = [
  [1, 0],
  [-1, 0],
  [0, 1],
];

const point = (x: number, y: number): GlyphPointSpec => ({ x, y, on: true });
/** Glyph 1: a square of 100 with a point in the middle of each side (P0 corner, P1 mid-bottom, P2 corner ...). */
export const SQUARE = [
  point(0, 0),
  point(50, 0),
  point(100, 0),
  point(100, 50),
  point(100, 100),
  point(50, 100),
  point(0, 100),
  point(0, 50),
];
export const BASE_SQUARE: ReadonlyArray<readonly [number, number]> = SQUARE.map((p) => [p.x, p.y] as const);
export const TRIANGLE = [point(0, 0), point(100, 0), point(50, 100)];
/** Glyph 4: 600 points on a staircase, to need two-byte point counts, word steps and word deltas. */
const POLYGON = Array.from({ length: 600 }, (_, k) => point(k, (k * 7) % 50));

export const NAMED = [...Array.from({ length: 150 }, (_, k) => 2 * k + 1), 599];

export const t = (tuple: TupleSpec): TupleSpec => tuple;
export const TUPLES: GvarSpec['glyphs'] = [
  null,
  {
    tuples: [
      // wght+ : the right corners and the advance (phantom point 2 = index 9) move by 40; the rest is inferred
      t({ shared: 0, points: [0, 2, 4, 6, 9], dx: [0, 40, 40, 0, 40], dy: [0, 0, 0, 0, 0] }),
      // wdth+ : the top three points rise by 10 (every point listed)
      t({ shared: 2, points: 'all', dx: new Array<number>(12).fill(0), dy: [0, 0, 0, 0, 10, 10, 10, 0, 0, 0, 0, 0] }),
      // an intermediate region on wght: 0.25 / 0.5 / 1, one touched point, so the whole contour moves by 8
      t({ peak: [0.5, 0], region: { start: [0.25, 0], end: [1, 0] }, points: [2], dx: [8], dy: [0] }),
      // wght- : one touched point, the whole contour moves by -10
      t({ shared: 1, points: [0], dx: [-10], dy: [0] }),
    ],
  },
  { sharedPoints: [0, 1], tuples: [t({ shared: 0, dx: [10, 20], dy: [0, 5] }), t({ shared: 2, points: [2], dx: [0], dy: [-20] })] },
  { tuples: [t({ shared: 0, points: 'all', dx: [0, 30, 0, 0, 0, 0], dy: [0, 0, 0, 0, 0, 0] })] },
  {
    tuples: [
      t({
        shared: 0,
        points: NAMED,
        dx: NAMED.map((_, k) => (k % 3 === 0 ? 0 : k === 150 ? 300 : 2 * k)),
        dy: NAMED.map((_, k) => (k % 2 === 0 ? 0 : -k)),
      }),
    ],
  },
];

export interface Options {
  readonly gvar?: Partial<GvarSpec>;
  readonly tables?: Record<string, readonly number[]>;
  readonly omit?: readonly string[];
}

export function variable(options: Options = {}): Uint8Array {
  return buildFont({
    unitsPerEm: 1000,
    glyphs: [
      { kind: 'empty' },
      { kind: 'simple', contours: [SQUARE] },
      { kind: 'simple', contours: [TRIANGLE] },
      {
        kind: 'composite',
        components: [
          { glyph: 1, dx: 0, dy: 0 },
          { glyph: 1, dx: 200, dy: 0, words: true },
        ],
      },
      { kind: 'simple', contours: [POLYGON] },
    ],
    advances: [500, 600, 700, 800, 900],
    codePoints: [
      [0x41, 1],
      [0x42, 2],
      [0x43, 3],
      [0x44, 4],
    ],
    cmap: 'f4',
    os2: { version: 2, fsType: 0, capHeight: 700 },
    tables: {
      fvar: buildFvar(AXES),
      gvar: buildGvar({ axisCount: 2, shared: SHARED, glyphs: TUPLES, ...options.gvar }),
      ...options.tables,
    },
    ...(options.omit === undefined ? {} : { omit: options.omit }),
  });
}

/** The font with an `avar` 2 delta store, an `MVAR` and an `HVAR` (every table the hostile harness mutates). */
export function variableTrueTypeWithMetrics(): Uint8Array {
  const store: StoreSpec = {
    axisCount: 2,
    regions: [
      [
        [0, 1, 1],
        [0, 0, 0],
      ],
    ],
    data: [{ regionIndexes: [0], rows: [[0], [8192], [50], [-20], [10]] }],
  };
  return variable({
    tables: {
      avar: buildAvar2(
        [
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
        ],
        { store, map: [0, 1] },
      ),
      MVAR: buildMvar(
        [
          ['hasc', 0, 2],
          ['hdsc', 0, 3],
          ['hlgp', 0, 4],
        ],
        store,
      ),
      HVAR: buildHvar(store),
    },
  });
}
