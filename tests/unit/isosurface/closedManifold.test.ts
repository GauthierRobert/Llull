/** isClosedManifold: every directed edge once and its reverse once, checked against a direct count on random index soups. */
import { describe, expect, it } from 'vitest';
import { isClosedManifold } from '@lib/isosurface/measures';
import { seeded } from '../cae/gridMesh';

function reference(vertices: number, indices: readonly number[]): boolean {
  if (indices.length % 3 !== 0) return false;
  const count = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3)
    for (let e = 0; e < 3; e += 1) {
      const key = `${indices[t + e]}>${indices[t + ((e + 1) % 3)]}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  for (const [key, times] of count) {
    const [from, to] = key.split('>');
    if (times !== 1 || count.get(`${to}>${from}`) !== 1) return false;
  }
  return vertices >= 0;
}

const TETRAHEDRON = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
const positionsOf = (vertices: number): number[] => Array.from({ length: 3 * vertices }, (_, index) => index);

describe('isClosedManifold', () => {
  it('accepts a tetrahedron and refuses it with a face missing, doubled or flipped', () => {
    const positions = positionsOf(4);
    expect(isClosedManifold({ positions, indices: TETRAHEDRON })).toBe(true);
    expect(isClosedManifold({ positions, indices: TETRAHEDRON.slice(3) })).toBe(false);
    expect(isClosedManifold({ positions, indices: [...TETRAHEDRON, 0, 2, 1] })).toBe(false);
    expect(isClosedManifold({ positions, indices: [0, 1, 2, ...TETRAHEDRON.slice(3)] })).toBe(false);
    expect(isClosedManifold({ positions, indices: TETRAHEDRON.slice(1) })).toBe(false);
    expect(isClosedManifold({ positions: new Float32Array(positions), indices: new Uint32Array(TETRAHEDRON) })).toBe(true);
  });

  it('agrees with a direct edge count on 3000 random triangle soups', () => {
    const next = seeded(99);
    let closed = 0;
    for (let round = 0; round < 3000; round += 1) {
      const vertices = 3 + Math.floor(next() * 4);
      const base = next() < 0.5 ? TETRAHEDRON.slice(0, 3 * (2 + Math.floor(next() * 3))) : [];
      const extra = Array.from({ length: 3 * Math.floor(next() * 3) }, () => Math.floor(next() * vertices));
      const indices = [...base, ...extra];
      const expected = reference(vertices, indices);
      closed += expected ? 1 : 0;
      expect(isClosedManifold({ positions: positionsOf(Math.max(vertices, 4)), indices })).toBe(expected);
    }
    expect(closed).toBeGreaterThan(10);
  });
});
