/** 14 FLL-M2b: the convex envelope of a flight run (hull vertices of the specific force over all samples) on synthetic series. */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/vectors';
import { convexEnvelopeIndices } from '@cae/flightLoads/convexEnvelope';
import { chooseInstants, type FlightInstant } from '@cae/flightLoads/flightInstants';

/** Deterministic pseudo-random numbers in [0, 1) (an LCG: no Math.random in tests). */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** n directions spread over the sphere (Fibonacci lattice). */
const directions = (n: number): Vec3[] =>
  Array.from({ length: n }, (_, k) => {
    const z = 1 - (2 * (k + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    const phi = k * Math.PI * (3 - Math.sqrt(5));
    return [r * Math.cos(phi), r * Math.sin(phi), z];
  });

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const diagonal = (points: readonly Vec3[]): number =>
  Math.hypot(
    ...[0, 1, 2].map((k) => {
      const values = points.map((p) => p[k as 0 | 1 | 2]);
      return values.reduce((a, b) => Math.max(a, b), -Infinity) - values.reduce((a, b) => Math.min(a, b), Infinity);
    }),
  );

/** Largest shortfall of the support function of the chosen points against all points, over many directions. */
function supportGap(points: readonly Vec3[], chosen: readonly number[]): number {
  let gap = 0;
  for (const u of directions(400)) {
    const all = points.reduce((best, p) => Math.max(best, dot(u, p)), -Infinity);
    const kept = chosen.reduce((best, index) => Math.max(best, dot(u, points[index] ?? [0, 0, 0])), -Infinity);
    gap = Math.max(gap, all - kept);
  }
  return gap;
}

describe('convexEnvelopeIndices', () => {
  it('keeps exactly the 8 corners of a cube cloud with interior and face points', () => {
    const random = sequence(7);
    const corners: Vec3[] = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? 2 : -2, k & 2 ? 1 : -1, k & 4 ? 3 : -3]);
    const inside: Vec3[] = Array.from({ length: 300 }, () => [4 * random() - 2, 2 * random() - 1, 6 * random() - 3]);
    const onFaces: Vec3[] = Array.from({ length: 40 }, (_, k) => [k % 2 ? 2 : -2, 2 * random() - 1, 6 * random() - 3]);
    const points = [...inside.slice(0, 150), ...corners, ...onFaces, ...inside.slice(150)];
    const chosen = convexEnvelopeIndices(points, 1e-9);
    expect(chosen.map((index) => points[index])).toEqual(corners);
    expect(chosen).toEqual([...chosen].sort((a, b) => a - b));
  });

  it('a degenerate cloud gives its hull in its own dimension: one point, the two ends of a segment, a planar polygon', () => {
    expect(convexEnvelopeIndices([], 0.01)).toEqual([]);
    expect(
      convexEnvelopeIndices(
        [
          [1, 1, 1],
          [1, 1, 1],
        ],
        0.01,
      ),
    ).toHaveLength(1);
    // a vertical climb: the specific force moves along z only
    const line: Vec3[] = Array.from({ length: 50 }, (_, k) => [0, 0, 9.8 + Math.sin(k / 5)]);
    const ends = convexEnvelopeIndices(line, 0.01);
    const heights = line.map((p) => p[2]);
    expect(ends.map((index) => line[index]?.[2]).sort()).toEqual(
      [heights.reduce((a, c) => Math.min(a, c), Infinity), heights.reduce((a, c) => Math.max(a, c), -Infinity)].sort(),
    );
    expect(ends).toHaveLength(2);
    // a square in the x-z plane with interior points and edge mid points
    const square: Vec3[] = [
      [0.5, 0, 0.5],
      [0, 0, 0],
      [1, 0, 0],
      [0.5, 0, 0],
      [1, 0, 1],
      [0.2, 0, 0.7],
      [0, 0, 1],
      [0, 0, 0.5],
    ];
    expect(convexEnvelopeIndices(square, 1e-6)).toEqual([1, 2, 4, 6]);
  });

  it('every sample of a 3D trajectory lies within the tolerance of the hull of the kept instants, with far fewer cases than samples', () => {
    // specific force of a manoeuvring vehicle: 1 g up plus a lissajous of horizontal and vertical load
    const points: Vec3[] = Array.from({ length: 3001 }, (_, k) => {
      const t = k / 1000;
      return [4 * Math.sin(2.1 * t), 3 * Math.sin(3.3 * t + 0.4), 9.81 + 6 * Math.sin(1.7 * t) * Math.cos(0.9 * t)];
    });
    for (const tolerance of [0.05, 0.02, 0.005]) {
      const chosen = convexEnvelopeIndices(points, tolerance);
      expect(supportGap(points, chosen)).toBeLessThanOrEqual(tolerance * diagonal(points) * (1 + 1e-9));
      expect(chosen.length).toBeGreaterThan(4);
      expect(chosen.length).toBeLessThan(points.length / 10);
    }
    expect(convexEnvelopeIndices(points, 0.005).length).toBeGreaterThan(convexEnvelopeIndices(points, 0.05).length);
  });

  it('a point less than the tolerance outside the hull adds no vertex; one beyond it does', () => {
    const base: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const diagonalOf = (extra: Vec3): number => diagonal([...base, extra]);
    // just outside the face x + y + z = 1, at distance d along its normal from its centroid
    const outside = (d: number): Vec3 => [1 / 3 + d / Math.sqrt(3), 1 / 3 + d / Math.sqrt(3), 1 / 3 + d / Math.sqrt(3)];
    const tolerance = 0.05;
    const near = outside(0.5 * tolerance * diagonalOf(outside(0.05)));
    const far = outside(3 * tolerance * diagonalOf(outside(0.3)));
    expect(convexEnvelopeIndices([...base, near], tolerance)).toEqual([0, 1, 2, 3]);
    expect(convexEnvelopeIndices([...base, far], tolerance)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('chooseInstants convex_envelope', () => {
  const instant = (index: number, accel: Vec3): FlightInstant => ({
    index,
    timeS: index * 0.01,
    accelMps2: accel,
    gravityMps2: [0, 0, -9.81],
    angularVelocity: [0, 0, 0],
    angularAccel: [0, 0, 0],
    thrustN: {},
    rotorRpm: {},
    shaftPowerW: {},
  });

  it('picks the real instants at the hull vertices of a - g, labelled hull_1.. in time order', () => {
    // a - g traces a triangle in the x-z plane (a hover with one x surge and one climb pulse) plus samples inside it
    const accels: Vec3[] = [
      [0, 0, 0],
      [1, 0, 1],
      [4, 0, 0],
      [1, 0, 0.5],
      [0, 0, 5],
      [0.5, 0, 1],
    ];
    const picks = chooseInstants(
      accels.map((a, index) => instant(index, a)),
      'convex_envelope',
    );
    expect(picks.map((pick) => [pick.instant.index, pick.label])).toEqual([
      [0, 'hull_1'],
      [2, 'hull_2'],
      [4, 'hull_3'],
    ]);
    // a flat cloud is hulled with eps / sqrt 2 in its plane: at tolerance 0.5 (eps 3.2, in-plane 2.26) the third vertex, 3.12 off the
    // diameter, is still kept; at 0.7 (in-plane 3.17) it is merged
    expect(
      chooseInstants(
        accels.map((a, index) => instant(index, a)),
        'convex_envelope',
        0.5,
      ),
    ).toHaveLength(3);
    expect(
      chooseInstants(
        accels.map((a, index) => instant(index, a)),
        'convex_envelope',
        0.7,
      ),
    ).toHaveLength(2);
  });
});
