import { describe, it, expect } from 'vitest';
import type { MeshData } from '@core/model/types';
import { isClosedMesh, openEdgeCount } from '@kernel-occt/meshClosure';

/** A closed tetrahedron, each face with its own three vertices (as OCC emits faces). */
function tetrahedron(shift = 0): MeshData {
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const faces = [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ];
  const positions = faces.flatMap((face) =>
    face.flatMap((corner) => corners[corner]!.map((value) => value + shift)),
  );
  return { positions, indices: faces.flatMap((_, f) => [f * 3, f * 3 + 1, f * 3 + 2]) };
}

describe('meshClosure', () => {
  it('a closed tetrahedron has no open edge', () => {
    expect(openEdgeCount(tetrahedron(), 0)).toBe(0);
    expect(isClosedMesh(tetrahedron())).toBe(true);
  });

  it('a tetrahedron missing one face has three open edges', () => {
    const mesh = tetrahedron();
    const holed = { positions: mesh.positions, indices: mesh.indices.slice(3) };
    expect(openEdgeCount(holed, 0)).toBe(3);
    expect(isClosedMesh(holed)).toBe(false);
  });

  it('welds copies of a vertex that straddle a grid cell boundary', () => {
    const mesh = tetrahedron(0.000005); // every coordinate sits on a half-cell of the 1e-5 grid
    const jittered = {
      ...mesh,
      positions: mesh.positions.map((value, i) => value + (i % 2 === 0 ? 1e-12 : -1e-12)),
    };
    expect(openEdgeCount(jittered, 0)).toBeGreaterThan(0);
    expect(isClosedMesh(jittered)).toBe(true);
  });

  it('welds -0 and +0 (no sign split in the keys)', () => {
    const mesh = tetrahedron();
    const signed = {
      ...mesh,
      positions: mesh.positions.map((v, i) => (v === 0 && i % 2 ? -1e-12 : v)),
    };
    expect(openEdgeCount(signed, 0)).toBe(0);
  });

  it('null (nothing to show) counts as closed', () => {
    expect(isClosedMesh(null)).toBe(true);
  });
});
