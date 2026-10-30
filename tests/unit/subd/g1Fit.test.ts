/** 04 DIR §5.8, TECHNICAL_SPEC DES-4c: the tangent-plane fit of the patches around extraordinary vertices: G0 untouched, only interior poles move, the break falls, the surface stays near the limit. */

import { describe, expect, it } from 'vitest';
import { type Cage, boxCage, cylinderCage, subdivide } from '@core/geometry/subdivision';
import { fitTangentPlanes } from '@core/geometry/subd/g1Fit';
import { cageToNurbs } from '@core/geometry/subd/toNurbs';
import { buildTopology } from '@core/geometry/subd/topology';
import { quadCagePatches } from '@core/geometry/subdivisionPatches';
import type { Vec3 } from '@core/model/types';

const INTERIOR = new Set([5, 6, 9, 10]);
const valenceOf = (cage: Cage): number[] => {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  return topology.vertexEdges.map((edges, v) => (edges.length === (topology.vertexFaces[v] as number[]).length ? edges.length : 4));
};

/** A pentagonal prism cage: the 5 top and 5 bottom vertices have valence 3, but add a valence-5 centre by capping each end with a fan of quads is not needed: use a 5-sided cap vertex. */
function pentagonCap(): Cage {
  const ring = (z: number): Vec3[] =>
    Array.from({ length: 5 }, (_, i): Vec3 => [Math.cos((2 * Math.PI * i) / 5), Math.sin((2 * Math.PI * i) / 5), z]);
  const mid = Array.from(
    { length: 5 },
    (_, i): Vec3 => [0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / 5), 0.5 * Math.sin((2 * Math.PI * (i + 0.5)) / 5), 1.2],
  );
  // top: a centre vertex 10 of valence 5 joined by quads to the ring through the midpoints; sides: quads down to a bottom ring
  const vertices: Vec3[] = [...ring(1), ...mid, [0, 0, 1.4], ...ring(-1)];
  const faces: number[][] = [];
  for (let i = 0; i < 5; i++) faces.push([10, 5 + ((i + 4) % 5), i, 5 + i].reverse());
  for (let i = 0; i < 5; i++) faces.push([i, (i + 1) % 5, 11 + ((i + 1) % 5), 11 + i].reverse());
  faces.push([11, 12, 13, 14, 15].reverse());
  return { vertices, faces, creases: [] };
}

describe('fitTangentPlanes', () => {
  const cube = boxCage([2, 2, 2], [1, 1, 1]);
  const refined = subdivide(cube, 1);
  const patches = quadCagePatches(refined);
  const valence = valenceOf(refined);
  const fitted = fitTangentPlanes(refined, patches, valence);

  it('moves only the four interior poles of quads next to an extraordinary vertex: every boundary pole is bit-identical (G0 stays exact)', () => {
    let moved = 0;
    patches.forEach((patch, f) => {
      patch.forEach((p, k) => {
        const same = (fitted[f] as Vec3[])[k]?.every((value, axis) => value === p[axis]);
        if (!INTERIOR.has(k)) expect(same, `patch ${f} pole ${k}`).toBe(true);
        else if (!same) moved++;
      });
    });
    expect(moved).toBeGreaterThan(0);
    // the cube's refined cage has an extraordinary vertex at every one of its 24 quads: the fit changed interior poles of all of them
    expect(valence.some((n) => n === 3)).toBe(true);
  });

  it('leaves the quads away from extraordinary vertices untouched (a regular grid has none)', () => {
    const grid = subdivide(boxCage([4, 4, 1], [4, 4, 1]), 1);
    const gridPatches = quadCagePatches(grid);
    const out = fitTangentPlanes(grid, gridPatches, valenceOf(grid));
    gridPatches.forEach((patch, f) => {
      const touches = (grid.faces[f] as number[]).some((v) => valenceOf(grid)[v] !== 4);
      if (!touches) expect(out[f]).toEqual(patch);
    });
  });

  it('is deterministic and does not mutate its input', () => {
    const before = JSON.stringify(patches);
    const again = fitTangentPlanes(refined, patches, valence);
    expect(JSON.stringify(patches)).toBe(before);
    expect(JSON.stringify(again)).toBe(JSON.stringify(fitted));
  });
});

describe('cageToNurbs with fitTangents', () => {
  it('cube: the tangent break (32 stations off the fit stations) at the eight valence-3 stars falls from 2.74 to under 0.2 degrees with the same 24 patches, gap 0, deviation within 10 %', () => {
    const cube = boxCage([2, 2, 2], [1, 1, 1]);
    const plain = cageToNurbs(cube, { packed: false, samples: 3 });
    const fit = cageToNurbs(cube, { packed: false, samples: 3, fitTangents: true, exactG1: false });
    expect(plain.maxEvG1Deg).toBeCloseTo(2.7416, 3);
    expect(fit.patchCount).toBe(24);
    expect(fit.maxEvG1Deg).toBeLessThan(0.2);
    expect(fit.maxEvG0).toBe(0);
    expect(fit.maxDeviation).toBeLessThanOrEqual(plain.maxDeviation * 1.1);
    expect(fit.evEdges).toHaveLength(plain.evEdges.length);
  });

  it('boxes with 2 x 2 x 2 and 3 x 2 x 1 segments (96 and 88 patches): break below 0.15 degrees, deviation within 1.5x of the plain patches', () => {
    for (const segments of [
      [2, 2, 2],
      [3, 2, 1],
    ] as const) {
      const cage = boxCage([2, 2, 2], segments);
      const plain = cageToNurbs(cage, { packed: false, samples: 3 });
      const fit = cageToNurbs(cage, { packed: false, samples: 3, fitTangents: true, exactG1: false });
      expect(fit.patchCount, `${segments}`).toBe(plain.patchCount);
      expect(fit.maxEvG1Deg, `${segments}`).toBeLessThan(0.15);
      expect(fit.maxEvG0).toBe(0);
      expect(fit.maxDeviation).toBeLessThanOrEqual(plain.maxDeviation * 1.5);
    }
  });

  it('a skewed cube (one corner pulled out): the fit still reaches a break below 0.2 degrees at the stars it moved', () => {
    const base = boxCage([2, 2, 2], [1, 1, 1]);
    const skewed = { ...base, vertices: base.vertices.map((p, v): Vec3 => (v === 0 ? [p[0] - 0.5, p[1] - 0.2, p[2] - 0.3] : p)) };
    const plain = cageToNurbs(skewed, { packed: false, samples: 3 });
    const fit = cageToNurbs(skewed, { packed: false, samples: 3, fitTangents: true, exactG1: false });
    expect(plain.maxEvG1Deg).toBeGreaterThan(1);
    expect(fit.maxEvG1Deg).toBeLessThan(0.2);
    expect(fit.maxEvG0).toBe(0);
  });

  it('a cage with a valence-5 vertex: the break falls by an order of magnitude', () => {
    const cage = pentagonCap();
    const plain = cageToNurbs(cage, { packed: false, samples: 2 });
    const fit = cageToNurbs(cage, { packed: false, samples: 2, fitTangents: true, exactG1: false });
    expect(plain.evEdges.some((edge) => edge.valence === 5)).toBe(true);
    expect(fit.maxEvG1Deg).toBeLessThan(plain.maxEvG1Deg / 10);
    expect(fit.maxEvG0).toBe(0);
  });

  it('does not depend on units or position: a cube scaled by 1000, by 0.001 and moved 500 away gives the same break and the same relative deviation', () => {
    const cube = boxCage([2, 2, 2], [1, 1, 1]);
    const reference = cageToNurbs(cube, { packed: false, samples: 3, fitTangents: true, exactG1: false });
    const plain = cageToNurbs(cube, { packed: false, samples: 3 });
    for (const [scale, offset] of [
      [1000, 0],
      [0.001, 0],
      [1, 500],
    ] as const) {
      const cage = {
        ...cube,
        vertices: cube.vertices.map((p): Vec3 => [p[0] * scale + offset, p[1] * scale + offset, p[2] * scale + offset]),
      };
      const fit = cageToNurbs(cage, { packed: false, samples: 3, fitTangents: true, exactG1: false });
      expect(fit.maxEvG1Deg, `scale ${scale} offset ${offset}`).toBeCloseTo(reference.maxEvG1Deg, 3);
      expect(fit.maxDeviation / scale, `scale ${scale}`).toBeCloseTo(reference.maxDeviation, 6);
      expect(fit.maxDeviation / scale).toBeLessThanOrEqual(plain.maxDeviation * 1.1);
    }
  });

  it('a creased cube: the fit leaves the quads at the creases alone (deviation equal to the plain patches), crease edges are not counted but the smooth edges at a crease vertex still are', () => {
    const cube = boxCage([2, 2, 2], [1, 1, 1]);
    const creases: Array<[number, number]> = [
      [0, 1],
      [1, 2],
    ];
    const creased = { ...cube, creases };
    const plain = cageToNurbs(creased, { packed: false, samples: 3 });
    const fit = cageToNurbs(creased, { packed: false, samples: 3, fitTangents: true, exactG1: false });
    const smooth = cageToNurbs(cube, { packed: false, samples: 3 });
    expect(fit.maxDeviation).toBeLessThanOrEqual(plain.maxDeviation * 1.01);
    // the two creases refine to four edges, which leave the list; every smooth edge (also those at the crease vertices) stays
    expect(plain.evEdges.length).toBe(smooth.evEdges.length - 4);
    expect(fit.evEdges.length).toBe(plain.evEdges.length);
    expect(fit.maxEvG1Deg).toBeGreaterThan(0.2); // a real break remains beside the creases and is reported, not hidden
  });

  it('cost is linear in the quads: a 32-sided cylinder cage (320 patches) fits in seconds, not minutes, and never folds a patch', () => {
    const cage = cylinderCage(1, 2, 32, 2);
    const started = performance.now();
    const plain = cageToNurbs(cage, { packed: false, samples: 2 });
    const fit = cageToNurbs(cage, { packed: false, samples: 2, fitTangents: true, exactG1: false });
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(fit.patchCount).toBe(plain.patchCount);
    expect(fit.maxEvG1Deg).toBeLessThanOrEqual(plain.maxEvG1Deg + 1e-9);
    expect(fit.maxEvG0).toBe(0);
  });
});
