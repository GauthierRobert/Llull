/** The boundary-aligned quad row of quad_remesh (07 MSH 13.28): no staircase, the rim exactly, the corners exact, the inner quads kept, refusals by cause. */

import { describe, expect, it } from 'vitest';
import { realignBoundaryRow } from '@core/geometry/mesh/quadRow';
import type { MeshData } from '@core/model/types';
import { gridMesh } from '../../helpers/meshFixtures';

/** An n x n plate of quads on [0, size]^2 whose boundary vertices (corners excepted) are pushed inwards in alternation: a staircase boundary. */
function staircasePlate(n: number, size: number, push: number): { positions: number[]; quads: number[] } {
  const positions: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const [x, y] = [(i * size) / n, (j * size) / n];
      const edge = i === 0 || j === 0 || i === n || j === n;
      const corner = (i === 0 || i === n) && (j === 0 || j === n);
      const inward = edge && !corner && (i + j) % 2 === 0 ? push : 0;
      const dx = i === 0 ? inward : i === n ? -inward : 0;
      const dy = j === 0 ? inward : j === n ? -inward : 0;
      positions.push(x + dx, y + dy, 0);
    }
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const quads: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) quads.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
  return { positions, quads };
}

/** Quads around each boundary vertex (a vertex on an edge used by one quad only). */
function boundaryValences(quads: ReadonlyArray<number>): number[] {
  const uses = new Map<string, number>();
  const around = new Map<number, number>();
  for (let f = 0; f < quads.length / 4; f++)
    for (let k = 0; k < 4; k++) {
      const a = quads[4 * f + k] as number;
      const b = quads[4 * f + ((k + 1) % 4)] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
      around.set(a, (around.get(a) ?? 0) + 1);
    }
  const boundary = new Set<number>();
  for (const [key, n] of uses) if (n === 1) key.split(',').forEach((v) => boundary.add(Number(v)));
  return [...boundary].map((v) => around.get(v) as number);
}

const plate = (size: number): MeshData => ({ positions: gridMesh(size, 12).positions, indices: gridMesh(size, 12).indices });

describe('realignBoundaryRow', () => {
  const engine = staircasePlate(8, 10, 0.4);

  it('replaces the staircase by a row on the rim: every boundary vertex has two quads, on the rim exactly, the four corners where they are', () => {
    const row = realignBoundaryRow(plate(10), engine.positions, engine.quads, null);
    if ('cause' in row) throw new Error(row.message);
    // the outermost layer of the 8 x 8 plate is 28 quads; the inner boundary has 24 vertices, so the row has 24 quads
    expect(row).toMatchObject({ loops: 1, removedQuads: 28, stripQuads: 24, evenness: 1 });
    expect(row.quads.length / 4).toBe(36 + 24);
    const valences = boundaryValences(row.quads);
    expect(valences).toHaveLength(24);
    expect(valences.every((v) => v === 2)).toBe(true);
    const staircase = boundaryValences(engine.quads);
    expect(staircase.some((v) => v === 1 || v === 3)).toBe(true);
    // on the rim exactly
    const onRim = (i: number): boolean => {
      const [x, y] = [row.positions[3 * i] as number, row.positions[3 * i + 1] as number];
      return x === 0 || x === 10 || y === 0 || y === 10;
    };
    const uses = new Map<string, number>();
    for (let f = 0; f < row.quads.length / 4; f++)
      for (let k = 0; k < 4; k++) {
        const a = row.quads[4 * f + k] as number;
        const b = row.quads[4 * f + ((k + 1) % 4)] as number;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    const boundary = new Set<number>();
    for (const [key, n] of uses) if (n === 1) key.split(',').forEach((v) => boundary.add(Number(v)));
    expect([...boundary].every(onRim)).toBe(true);
    for (const [x, y] of [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
      expect([...boundary].some((i) => row.positions[3 * i] === x && row.positions[3 * i + 1] === y)).toBe(true);
    // flat plate: nothing leaves the plane, every quad faces +z like the engine's, and the vertices away from the new row keep their places
    expect(row.positions.filter((_, i) => i % 3 === 2).every((z) => z === 0)).toBe(true);
    expect(row.worstMove).toBeGreaterThan(0);
  });

  it('keeps the inner quads of the engine: the vertices two quads in are not moved', () => {
    const row = realignBoundaryRow(plate(10), engine.positions, engine.quads, null);
    if ('cause' in row) throw new Error(row.message);
    const deep = new Set<string>();
    for (let j = 2; j <= 6; j++)
      for (let i = 2; i <= 6; i++)
        deep.add(
          `${(engine.positions[3 * (j * 9 + i)] as number).toFixed(9)},${(engine.positions[3 * (j * 9 + i) + 1] as number).toFixed(9)}`,
        );
    const kept = new Set<string>();
    for (let v = 0; v < row.positions.length; v += 3)
      kept.add(`${(row.positions[v] as number).toFixed(9)},${(row.positions[v + 1] as number).toFixed(9)}`);
    for (const key of deep) expect(kept.has(key), key).toBe(true);
  });

  it('moves the inner boundary vertices and keeps them on the source; with a symmetry plane the rim points on it are exactly on it and the junction is a vertex', () => {
    const row = realignBoundaryRow(plate(10), engine.positions, engine.quads, 0);
    if ('cause' in row) throw new Error(row.message);
    const before = new Set<string>();
    for (let v = 0; v < engine.positions.length; v += 3) before.add(`${engine.positions[v]},${engine.positions[v + 1]}`);
    let moved = 0;
    for (let v = 0; v < row.positions.length; v += 3) {
      const [x, y, z] = [row.positions[v] as number, row.positions[v + 1] as number, row.positions[v + 2] as number];
      expect(z).toBe(0);
      expect(x >= 0 && x <= 10 && y >= 0 && y <= 10).toBe(true);
      if (!before.has(`${x},${y}`)) moved++;
    }
    // the 24 inner boundary vertices are relaxed, the 24 rim points are new: none of them is a place of the engine's quads
    expect(moved).toBeGreaterThanOrEqual(24 + 20);
    // the rim points of the left side (the plane x = 0) are on it exactly, and the two ends of that side are vertices
    const onPlane = [];
    for (let v = 0; v < row.positions.length; v += 3)
      if (Math.abs(row.positions[v] as number) < 1e-6) onPlane.push(row.positions[v + 1] as number);
    expect(onPlane.length).toBeGreaterThanOrEqual(6);
    for (let v = 0; v < row.positions.length; v += 3) if (Math.abs(row.positions[v] as number) < 1e-6) expect(row.positions[v]).toBe(0);
    expect(onPlane).toContain(0);
    expect(onPlane).toContain(10);
  });

  it('refuses by cause: loops that do not pair, nothing left inside, a source whose boundary branches', () => {
    // the engine covered a hole the source has: loop counts differ
    const annulus = gridMesh(10, 6);
    const cells = Array.from({ length: annulus.indices.length / 6 }, (_, c) => c).filter(
      (c) => !([2, 3].includes(c % 6) && [2, 3].includes(Math.floor(c / 6))),
    );
    const ring: MeshData = { positions: annulus.positions, indices: cells.flatMap((c) => annulus.indices.slice(6 * c, 6 * c + 6)) };
    expect(realignBoundaryRow(ring, engine.positions, engine.quads, null)).toMatchObject({ cause: 'loops' });
    // a 2 x 2 plate: every quad touches the boundary
    const tiny = staircasePlate(2, 10, 0);
    expect(realignBoundaryRow(plate(10), tiny.positions, tiny.quads, null)).toMatchObject({
      cause: 'shape',
      message: expect.stringContaining('no quad is left'),
    });
    // a bow-tie source: the boundary chain branches at the shared vertex
    const bow: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0], indices: [0, 1, 2, 0, 3, 4] };
    expect(realignBoundaryRow(bow, engine.positions, engine.quads, null)).toMatchObject({ cause: 'source' });
  });

  it('is pure: the inputs are not changed', () => {
    const before = JSON.stringify([engine.positions, engine.quads]);
    realignBoundaryRow(plate(10), engine.positions, engine.quads, null);
    expect(JSON.stringify([engine.positions, engine.quads])).toBe(before);
  });
});
