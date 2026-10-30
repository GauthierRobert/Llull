import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/types';
import type { StrutBeam, StrutSet } from '@core/geometry/field/program';
import { BVH_MIN_SEGMENTS, buildStrutBvh } from '@core/geometry/field/strutBvh';
import { prepareStrutSet } from '@core/geometry/field/strutSet';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSet(seed: number, beamCount: number, extent: number): StrutSet {
  const random = rng(seed);
  const nodes: Vec3[] = Array.from({ length: beamCount * 2 }, () => [random() * extent, random() * extent, random() * extent]);
  const beams: StrutBeam[] = Array.from({ length: beamCount }, (_, i) => ({
    a: 2 * i,
    b: i % 11 === 0 ? 2 * i : 2 * i + 1,
    ra: random() * 0.6,
    rb: i % 5 === 0 ? random() * 0.6 : 0.3,
    cap: i % 3 === 0 ? 'butt' : 'sphere',
  }));
  return { periodic: null, nodes, beams };
}

/** The brute reference: the `d < best` loop over one-beam evaluators (a set below BVH_MIN_SEGMENTS never builds a BVH). */
function bruteDistance(set: StrutSet, x: number, y: number, z: number, radius: number): number {
  let best = Infinity;
  for (const beam of set.beams) {
    const d = prepareStrutSet({ ...set, beams: [beam] }).distance(x, y, z, radius);
    if (d < best) best = d;
  }
  return best;
}

const sameBits = (a: number, b: number): boolean => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));

function probePoints(set: StrutSet, extent: number): Vec3[] {
  const random = rng(99);
  const points: Vec3[] = Array.from({ length: 1500 }, () => [random() * extent * 1.1, random() * extent * 1.1, random() * extent * 1.1]);
  for (const beam of set.beams.slice(0, 100)) {
    const [a, b] = [set.nodes[beam.a] as Vec3, set.nodes[beam.b] as Vec3];
    points.push(a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + 0.1]);
  }
  points.push([1e3, -1e3, 5e2], [-1e6, 0, 0]);
  return points;
}

describe('strut BVH (05 IMP §14.9)', () => {
  it('is bit-identical to the brute loop on random sets: inside beams, on caps, far away, with the radius override', () => {
    const set = randomSet(7, 300, 40);
    const evaluator = prepareStrutSet(set);
    for (const radius of [-1, 0, 0.25, 2]) {
      for (const [x, y, z] of probePoints(set, 40)) {
        const [fast, brute] = [evaluator.distance(x, y, z, radius), bruteDistance(set, x, y, z, radius)];
        expect(sameBits(fast, brute), `(${x}, ${y}, ${z}) radius ${radius}: ${fast} vs ${brute}`).toBe(true);
      }
    }
  });

  it('never builds a BVH for a small set and keeps NaN points and non-finite or tiny beams exact', () => {
    expect(BVH_MIN_SEGMENTS).toBeGreaterThan(8);
    const set = randomSet(11, 80, 10);
    const nodes = [...set.nodes];
    nodes[10] = [Number.NaN, 0, 0];
    nodes[18] = [0, 0, 0];
    nodes[19] = [1e-120, 0, 0];
    nodes[26] = [Infinity, 0, 0];
    const hostile = { ...set, nodes };
    const evaluator = prepareStrutSet(hostile);
    const random = rng(5);
    for (let i = 0; i < 300; i += 1) {
      const [x, y, z] = [random() * 12, random() * 12, random() * 12];
      expect(sameBits(evaluator.distance(x, y, z, -1), bruteDistance(hostile, x, y, z, -1))).toBe(true);
    }
    expect(sameBits(evaluator.distance(Number.NaN, 1, 1, -1), bruteDistance(hostile, Number.NaN, 1, 1, -1))).toBe(true);
  });

  it('keeps the brute choice between a 0 and a -0 whatever the beam order', () => {
    for (const swap of [false, true]) {
      const nodes: Vec3[] = [];
      const beams: StrutBeam[] = [];
      for (let i = 0; i < 60; i += 1) {
        nodes.push([100 + i, 50, 0], [100 + i, 60, 0]);
        beams.push({ a: 2 * i, b: 2 * i + 1, ra: 0.1, rb: 0.1, cap: 'sphere' });
      }
      nodes[20] = [19, 0, 0];
      nodes[21] = [29, 0, 0];
      nodes[100] = [20, 0, 0];
      nodes[101] = [30, 0, 0];
      const negative: StrutBeam = { a: 20, b: 21, ra: 1, rb: 1, cap: 'butt' };
      const positive: StrutBeam = { a: 100, b: 101, ra: 1, rb: 1, cap: 'sphere' };
      beams[10] = swap ? positive : negative;
      beams[50] = swap ? negative : positive;
      const set: StrutSet = { periodic: null, nodes, beams };
      const [fast, brute] = [prepareStrutSet(set).distance(19, 0, 0, -1), bruteDistance(set, 19, 0, 0, -1)];
      expect(Object.is(brute, swap ? 0 : -0)).toBe(true);
      expect(Object.is(fast, brute), `swap ${swap}: ${Object.is(fast, -0) ? '-0' : '0'} vs ${Object.is(brute, -0) ? '-0' : '0'}`).toBe(
        true,
      );
    }
  });

  it('bounds every beam from below: the root bound never exceeds the true distance (radius override and tapers included)', () => {
    const set = randomSet(3, 120, 30);
    const random = rng(21);
    for (const beam of set.beams) {
      const [a, b] = [set.nodes[beam.a] as Vec3, set.nodes[beam.b] as Vec3];
      const [dx, dy, dz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const bvh = buildStrutBvh([{ ax: a[0], ay: a[1], az: a[2], dx, dy, dz, length: Math.hypot(dx, dy, dz), ra: beam.ra, rb: beam.rb }]);
      const single = prepareStrutSet({ ...set, beams: [beam] });
      for (let i = 0; i < 60; i += 1) {
        const [x, y, z] = [(random() - 0.2) * 40, (random() - 0.2) * 40, (random() - 0.2) * 40];
        for (const radius of [-1, 0.4]) expect(bvh.rootBound(x, y, z, radius)).toBeLessThanOrEqual(single.distance(x, y, z, radius));
      }
    }
  });

  it('keeps the brute result when a fifth of 240 beams has a NaN node (the sort key stays a total order)', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const set = randomSet(200 + seed, 240, 20);
      const nodes = set.nodes.map((node, i): Vec3 => (i % 10 === 0 ? [Number.NaN, Number.NaN, Number.NaN] : node));
      const hostile = { ...set, nodes };
      const evaluator = prepareStrutSet(hostile);
      const random = rng(seed);
      for (let i = 0; i < 40; i += 1) {
        const [x, y, z] = [random() * 22, random() * 22, random() * 22];
        expect(sameBits(evaluator.distance(x, y, z, -1), bruteDistance(hostile, x, y, z, -1))).toBe(true);
      }
    }
  });

  it('bounds the corner octant past a beam end and wide radii: slack scales with the radius too', () => {
    for (const [reach, offset] of [
      [0.3, 0],
      [50, 0],
      [1e4, 3e3],
      [0.3, 1e5],
    ] as const) {
      for (const cap of ['sphere', 'butt'] as const) {
        const a: Vec3 = [offset, offset, offset];
        const b: Vec3 = [offset + 10, offset + 10, offset + 10];
        const beam: StrutBeam = { a: 0, b: 1, ra: reach, rb: reach, cap };
        const set: StrutSet = { periodic: null, nodes: [a, b], beams: [beam] };
        const bvh = buildStrutBvh([
          { ax: a[0], ay: a[1], az: a[2], dx: 10, dy: 10, dz: 10, length: Math.hypot(10, 10, 10), ra: reach, rb: reach },
        ]);
        const single = prepareStrutSet(set);
        for (let step = 0; step < 400; step += 1) {
          const t = (0.01 + step * 0.37) / Math.sqrt(3);
          const [x, y, z] = [b[0] + t, b[1] + t, b[2] + t];
          for (const radius of [-1, 0.5 * reach])
            expect(bvh.rootBound(x, y, z, radius)).toBeLessThanOrEqual(single.distance(x, y, z, radius));
        }
      }
    }
  });

  it('declines to bound a point that is not a number and an empty set', () => {
    const bvh = buildStrutBvh([{ ax: 0, ay: 0, az: 0, dx: 1, dy: 0, dz: 0, length: 1, ra: 0.1, rb: 0.1 }]);
    expect(Number.isNaN(bvh.rootBound(Number.NaN, 0, 0, -1)) || bvh.rootBound(Number.NaN, 0, 0, -1) === -Infinity).toBe(true);
    const empty = buildStrutBvh([]);
    expect(empty.nearest(0, 0, 0, -1, () => 0)).toBe(Infinity);
    expect(empty.rootBound(0, 0, 0, -1)).toBe(Infinity);
  });
});
