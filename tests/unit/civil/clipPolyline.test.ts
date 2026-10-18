import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/model/types';
import { clipPolylineOutside } from '@aec/civil/earthworks/tinTrim';

type Tri = readonly [Vec2, Vec2, Vec2];
// Unit square 10..20 as two CCW triangles.
const SQUARE: Tri[] = [
  [
    [10, 10],
    [20, 10],
    [20, 20],
  ],
  [
    [10, 10],
    [20, 20],
    [10, 20],
  ],
];

describe('clipPolylineOutside', () => {
  it('returns the line untouched with an empty footprint or no overlap', () => {
    const line: Vec2[] = [
      [0, 0],
      [5, 5],
    ];
    expect(clipPolylineOutside(line, [])).toEqual([line]);
    expect(clipPolylineOutside(line, SQUARE)).toEqual([line]);
  });
  it('cuts a line through the footprint into two parts at its boundary', () => {
    const parts = clipPolylineOutside(
      [
        [0, 15],
        [30, 15],
      ],
      SQUARE,
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual([
      [0, 15],
      [10, 15],
    ]);
    expect(parts[1]).toEqual([
      [20, 15],
      [30, 15],
    ]);
  });
  it('drops a line fully inside (even along the shared diagonal) and a stretch lying on the boundary', () => {
    expect(
      clipPolylineOutside(
        [
          [12, 12],
          [18, 18],
        ],
        SQUARE,
      ),
    ).toEqual([]);
    expect(
      clipPolylineOutside(
        [
          [10, 0],
          [10, 30],
        ],
        SQUARE,
      ),
    ).toHaveLength(2);
  });
  it('keeps a multi-segment part continuous and rejoins a closed loop cut open', () => {
    const open = clipPolylineOutside(
      [
        [0, 0],
        [0, 15],
        [10, 15],
        [20, 15],
        [30, 15],
        [30, 0],
      ],
      SQUARE,
    );
    expect(open).toHaveLength(2);
    expect(open[0]).toEqual([
      [0, 0],
      [0, 15],
      [10, 15],
    ]);
    const loop: Vec2[] = [
      [0, 15],
      [15, 30],
      [30, 15],
      [15, 0],
      [0, 15],
    ];
    const rejoined = clipPolylineOutside(loop, [
      [
        [14, 14],
        [16, 14],
        [15, 16],
      ],
    ]);
    expect(rejoined).toHaveLength(1);
    expect(rejoined[0]).toEqual(loop);
    const cut = clipPolylineOutside(
      [
        [15, 15],
        [0, 15],
        [0, 0],
        [15, 0],
        [15, 15],
      ],
      SQUARE,
    );
    expect(cut).toHaveLength(1);
    expect(cut[0]?.[0]).toEqual([10, 15]);
    expect(cut[0]?.at(-1)).toEqual([15, 10]);
  });
});
