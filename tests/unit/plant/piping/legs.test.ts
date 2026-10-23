/** Compass legs -> points of intersection (02 RTE §5.1; VC-RTE-01, VC-RTE-09). */

import { describe, expect, it } from 'vitest';
import { angleBetweenDeg, buildPath, directionLabel, epsilonFor, unitVector, type PathFailure, type PathOk } from '@aec/plant/piping/legs';

const start = { point: [0, 0, 1000] as [number, number, number], direction: [0, 0, 1] as [number, number, number] };
const target = { point: [6000, 3000, 4000] as [number, number, number], direction: [-1, 0, 0] as [number, number, number] };
const SC01 = [
  { direction: '+Z', length: 1500 },
  { direction: '+Y', length: 3000 },
  { direction: '+X', length: 3000 },
  { direction: '+Z', length: 1500 },
] as const;

const good = (result: PathOk | PathFailure): PathOk => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result as PathOk;
};
const bad = (result: PathOk | PathFailure): PathFailure => {
  expect(result.ok).toBe(false);
  return result as PathFailure;
};

describe('buildPath (SC-RTE-01)', () => {
  it('adds the closing leg +X 3000 to the nozzle: 5 legs, PIs as in TECHNICAL_SPEC D1', () => {
    const path = good(buildPath(start, target, SC01, [], 1));
    expect(path.points).toEqual([
      [0, 0, 1000],
      [0, 0, 2500],
      [0, 3000, 2500],
      [3000, 3000, 2500],
      [3000, 3000, 4000],
      [6000, 3000, 4000],
    ]);
    expect(path.closingLeg).toEqual({ direction: '+X', length: 3000 });
    expect(path.legs.map((leg) => [leg.direction, leg.length])).toEqual([
      ['+Z', 1500],
      ['+Y', 3000],
      ['+X', 3000],
      ['+Z', 1500],
      ['+X', 3000],
    ]);
    expect(path.startDeviationDeg).toBe(0);
    expect(path.endDeviationDeg).toBe(0);
    expect(path.merged).toBe(0);
  });

  it('lets the last leg omit its length when it runs straight to the target', () => {
    const path = good(buildPath(start, target, [...SC01.slice(0, 3), { direction: '+Z', length: 1500 }, { direction: '+X' }], [], 1));
    expect(path.closingLeg).toBeNull();
    expect(path.points.at(-1)).toEqual([6000, 3000, 4000]);
    expect(path.legs).toHaveLength(5);
  });

  it('routes straight between two facing ports with no legs, and from via points', () => {
    const straight = good(buildPath({ point: [0, 0, 0], direction: [1, 0, 0] }, { point: [2000, 0, 0], direction: [-1, 0, 0] }, [], [], 1));
    expect(straight.points).toEqual([
      [0, 0, 0],
      [2000, 0, 0],
    ]);
    expect(straight.closingLeg).toEqual({ direction: '+X', length: 2000 });
    const viaOnly = good(buildPath({ point: [0, 0, 0] }, { point: [2000, 1000, 0] }, [], [[2000, 0, 0]], 1));
    expect(viaOnly.points).toEqual([
      [0, 0, 0],
      [2000, 0, 0],
      [2000, 1000, 0],
    ]);
  });

  it('merges consecutive collinear legs and reports the merge', () => {
    const path = good(
      buildPath(
        { point: [0, 0, 0] },
        undefined,
        [
          { direction: '+X', length: 500 },
          { direction: [2, 0, 0], length: 500 },
          { direction: '+Y', length: 300 },
        ],
        [],
        1,
      ),
    );
    expect(path.points).toEqual([
      [0, 0, 0],
      [1000, 0, 0],
      [1000, 300, 0],
    ]);
    expect(path.merged).toBe(1);
  });

  it('accepts a first leg off the port direction within the tolerance and reports the deviation (SC-RTE-04 style)', () => {
    const tilted = good(
      buildPath({ point: [0, 0, 0], direction: [1, 0, 0] }, undefined, [{ direction: [1, 0, -0.01], length: 8000 }], [], 1),
    );
    expect(tilted.startDeviationDeg).toBeCloseTo(0.572939, 5);
    const refused = bad(
      buildPath({ point: [0, 0, 0], direction: [1, 0, 0] }, undefined, [{ direction: [1, 0, -0.01], length: 8000 }], [], 0.5),
    );
    expect(refused.code).toBe('RTE_PORT_DIRECTION');
    expect(refused.paths).toEqual(['legs.0.direction']);
    expect(refused.detail['deviationDeg']).toBeCloseTo(0.572939, 5);
  });
});

describe('buildPath refusals', () => {
  it('refuses a first leg that leaves the port sideways, and an arrival off the target axis', () => {
    const sideways = bad(buildPath(start, target, [{ direction: '+Y', length: 1500 }], [], 1));
    expect(sideways.code).toBe('RTE_PORT_DIRECTION');
    const arrival = bad(
      buildPath({ point: [0, 0, 0] }, { point: [0, 1000, 0], direction: [-1, 0, 0] }, [{ direction: '+Y', length: 1000 }], [], 1),
    );
    expect(arrival.code).toBe('RTE_PORT_DIRECTION');
    expect(arrival.paths).toEqual(['to']);
  });

  it('refuses a target that is not on its port axis with the remaining offset (RTE_CLOSING_LEG_IMPOSSIBLE)', () => {
    const off = bad(buildPath(start, target, SC01.slice(0, 3), [], 1));
    expect(off.code).toBe('RTE_CLOSING_LEG_IMPOSSIBLE');
    expect(off.detail['offset']).toEqual([3000, 0, 1500]);
    const behind = bad(buildPath({ point: [7000, 3000, 4000] }, target, [], [], 1));
    expect(behind.code).toBe('RTE_CLOSING_LEG_IMPOSSIBLE');
    const unreachable = bad(buildPath({ point: [0, 0, 0] }, { point: [3000, 500, 0] }, [{ direction: '+X' }], [], 1));
    expect(unreachable.code).toBe('RTE_CLOSING_LEG_IMPOSSIBLE');
    expect(unreachable.paths).toEqual(['legs.0.direction']);
  });

  it('refuses zero legs, a missing length, a zero direction, a repeated via point and an empty path', () => {
    const zero = bad(buildPath({ point: [0, 0, 0] }, undefined, [{ direction: '+X', length: 0 }], [], 1));
    expect(zero.code).toBe('RTE_ZERO_LEG');
    expect(zero.paths).toEqual(['legs.0.length']);
    expect(bad(buildPath({ point: [0, 0, 0] }, undefined, [{ direction: '+X' }, { direction: '+Y', length: 5 }], [], 1)).paths).toEqual([
      'legs.0.length',
    ]);
    expect(bad(buildPath({ point: [0, 0, 0] }, undefined, [{ direction: '+X' }], [], 1)).code).toBe('RTE_ZERO_LEG');
    expect(bad(buildPath({ point: [0, 0, 0] }, undefined, [{ direction: [0, 0, 0], length: 5 }], [], 1)).paths).toEqual([
      'legs.0.direction',
    ]);
    expect(bad(buildPath({ point: [0, 0, 0] }, undefined, [], [[0, 0, 0]], 1)).paths).toEqual(['via.0']);
    expect(bad(buildPath({ point: [0, 0, 0] }, undefined, [], [], 1)).paths).toEqual(['legs']);
    expect(bad(buildPath({ point: [0, 0, 0] }, { point: [0, 0, 0] }, [], [], 1)).paths).toEqual(['to']);
  });
});

describe('vector helpers', () => {
  it('labels axis directions, keeps other vectors, and measures angles', () => {
    expect(directionLabel([0, 0, -1])).toBe('-Z');
    expect(directionLabel([0.6, 0.8, 0])).toEqual([0.6, 0.8, 0]);
    expect(unitVector([0, 3, 4])[2]).toBeCloseTo(0.8, 12);
    expect(unitVector([0, 0, 0])).toEqual([0, 0, 0]);
    expect(angleBetweenDeg([1, 0, 0], [0, 1, 0])).toBeCloseTo(90, 12);
    expect(epsilonFor([10, 20, 5000])).toBeCloseTo(0.005, 12);
  });
});
