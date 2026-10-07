import { describe, it, expect } from 'vitest';
import { buildMeshSolidGeometry } from '@ui/viewport/3d/entities/meshSolidGeometry';

/** Unit cube with 8 SHARED vertices, 12 outward-facing triangles. */
const CUBE = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  indices: [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0,
    4, 3, 4, 7,
  ],
};

describe('buildMeshSolidGeometry', () => {
  it('keeps hard edges flat: every cube normal is axis-aligned', () => {
    const normals = buildMeshSolidGeometry(CUBE).getAttribute('normal');
    expect(normals.count).toBe(36);
    for (let i = 0; i < normals.count; i++) {
      const components = [normals.getX(i), normals.getY(i), normals.getZ(i)].map(Math.abs);
      expect(Math.max(...components)).toBeCloseTo(1);
    }
  });

  it('keeps the triangle positions', () => {
    const geometry = buildMeshSolidGeometry(CUBE);
    expect(geometry.getAttribute('position').count).toBe(36);
  });
});
