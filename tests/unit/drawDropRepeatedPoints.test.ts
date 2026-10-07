import { describe, it, expect } from 'vitest';
import { dropRepeatedPoints } from '@ui/viewport/2d/drawHelpers';

describe('dropRepeatedPoints', () => {
  it('removes the duplicate vertex a double-click leaves at the end of a chain', () => {
    expect(
      dropRepeatedPoints([
        [0, 0],
        [10, 0],
        [10, 10],
        [10, 10],
      ]),
    ).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('keeps distinct vertices, including a closing return to the start', () => {
    const loop: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 0],
    ];
    expect(dropRepeatedPoints(loop)).toEqual(loop);
  });

  it('collapses a chain of identical points to one', () => {
    expect(
      dropRepeatedPoints([
        [3, 3],
        [3, 3],
        [3, 3],
      ]),
    ).toEqual([[3, 3]]);
  });
});
