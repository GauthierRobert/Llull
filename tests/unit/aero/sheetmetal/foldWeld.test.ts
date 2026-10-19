import { describe, expect, it } from 'vitest';
import { removeInternalFaces } from '@aero/sheetmetal/foldWeld';
import { bracket, folded } from './helpers';

/** Directed edges of a position-welded mesh that are not matched by exactly one opposite edge (0 = closed, consistently wound). */
function openEdges(positions: readonly number[], indices: readonly number[]): number {
  const key = (i: number): string => [0, 1, 2].map((k) => (positions[i * 3 + k] ?? 0).toFixed(4)).join(',');
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const id = `${key(indices[t + k] ?? 0)}>${key(indices[t + ((k + 1) % 3)] ?? 0)}`;
      edges.set(id, (edges.get(id) ?? 0) + 1);
    }
  let open = 0;
  for (const [edge, count] of edges) {
    const [a, b] = edge.split('>');
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) open++;
  }
  return open;
}

function surfaceArea(positions: readonly number[], indices: readonly number[]): number {
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const at = (k: number, c: number): number => positions[(indices[t + k] ?? 0) * 3 + c] ?? 0;
    const u = [0, 1, 2].map((c) => at(1, c) - at(0, c));
    const v = [0, 1, 2].map((c) => at(2, c) - at(0, c));
    const [u0, u1, u2, v0, v1, v2] = [u[0] ?? 0, u[1] ?? 0, u[2] ?? 0, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
    area += Math.hypot(u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0) / 2;
  }
  return area;
}

describe('folded sheet-metal mesh has no internal faces', () => {
  it('the bracket is one closed shell with the true surface area', () => {
    const { doc, part } = bracket();
    const { mesh } = folded(doc, part);
    expect(openEdges(mesh.positions, mesh.indices)).toBe(0);
    expect(surfaceArea(mesh.positions, mesh.indices)).toBeCloseTo(6970.83, 0);
  });

  it('keeps a soup without coincident opposite faces unchanged', () => {
    const soup = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    expect(removeInternalFaces(soup)).toBe(soup);
  });

  it('drops two coincident opposite triangles', () => {
    const soup = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 1] };
    expect(removeInternalFaces(soup).indices).toEqual([]);
  });
});
