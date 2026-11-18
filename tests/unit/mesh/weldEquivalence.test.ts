import { describe, expect, it } from 'vitest';
import { lodMesh } from '@core/geometry/mesh/lod';
import { weldMesh } from '@core/geometry/mesh/weld';
import type { MeshData } from '@core/model/types';

/** The weld before the typed-array tables (Map of arrays, 27 probes per vertex), kept as the specification of the result. */
function weldReference(mesh: MeshData, tolerance: number): ReturnType<typeof weldMesh> {
  const { positions, indices } = mesh;
  const welded: number[] = [];
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const cell = tolerance > 0 ? tolerance : 0;
  const limit = cell * cell;
  const buckets = new Map<number, number[]>();
  const triangles: number[] = [];
  const origin: number[] = [];
  let referenced = 0;
  const hash = (a: number, b: number, c: number): number =>
    (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) | 0;
  const view = new DataView(new ArrayBuffer(8));
  const bits = (value: number): number => {
    view.setFloat64(0, value + 0);
    return view.getInt32(0) ^ view.getInt32(4);
  };
  const exactKey = (x: number, y: number, z: number): number => hash(bits(x), bits(y), bits(z));
  const cellKey = (i: number, j: number, k: number): number => hash(i | 0, j | 0, k | 0);
  const lookup = (x: number, y: number, z: number): number => {
    let best = -1;
    if (cell === 0) {
      for (const candidate of buckets.get(exactKey(x, y, z)) ?? []) {
        if (
          welded[candidate * 3] === x &&
          welded[candidate * 3 + 1] === y &&
          welded[candidate * 3 + 2] === z &&
          (best < 0 || candidate < best)
        )
          best = candidate;
      }
      return best;
    }
    const [ci, cj, ck] = [Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)];
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (let dk = -1; dk <= 1; dk++)
          for (const candidate of buckets.get(cellKey(ci + di, cj + dj, ck + dk)) ?? []) {
            const dx = (welded[candidate * 3] as number) - x;
            const dy = (welded[candidate * 3 + 1] as number) - y;
            const dz = (welded[candidate * 3 + 2] as number) - z;
            if (dx * dx + dy * dy + dz * dz <= limit && (best < 0 || candidate < best)) best = candidate;
          }
    return best;
  };
  const register = (x: number, y: number, z: number): number => {
    const index = welded.length / 3;
    welded.push(x, y, z);
    const key = cell === 0 ? exactKey(x, y, z) : cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [index]);
    else bucket.push(index);
    return index;
  };
  for (const corner of indices) {
    let mapped = remap[corner] ?? -1;
    if (mapped < 0) {
      referenced++;
      const [x, y, z] = [positions[corner * 3] as number, positions[corner * 3 + 1] as number, positions[corner * 3 + 2] as number];
      mapped = lookup(x, y, z);
      if (mapped < 0) {
        mapped = register(x, y, z);
        origin.push(corner);
      }
      remap[corner] = mapped;
    }
    triangles.push(mapped);
  }
  return { positions: welded, triangles, mergedVertices: referenced - welded.length / 3, remap, origin };
}

const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

/** Lattice points (so exact duplicates are common), copies nudged to just inside / outside `tolerance`, -0 / 0 pairs, unreferenced tails, degenerate faces. */
function randomMesh(seed: number, tolerance: number): MeshData {
  const next = random(seed);
  const positions: number[] = [];
  const count = 60 + Math.floor(next() * 140);
  for (let i = 0; i < count; i++) {
    const roll = next();
    const at = (): number => Math.floor(next() * 5) * (tolerance > 0 ? tolerance * 3 : 0.25);
    if (roll < 0.3 && positions.length > 0) {
      const from = Math.floor(next() * (positions.length / 3)) * 3;
      const nudge = tolerance > 0 ? tolerance * (next() < 0.5 ? 1 - 1e-9 : 1 + 1e-9) : 0;
      positions.push((positions[from] as number) + nudge, positions[from + 1] as number, (positions[from + 2] as number) - nudge * 0.5);
    } else if (roll < 0.4) positions.push(next() < 0.5 ? -0 : 0, 0, next() < 0.5 ? -0 : 0);
    else positions.push(at(), at(), at());
  }
  const used = Math.floor(count * (0.6 + next() * 0.4));
  const indices: number[] = [];
  for (let t = 0; t < 400; t++) indices.push(Math.floor(next() * used), Math.floor(next() * used), Math.floor(next() * used));
  return { positions, indices };
}

describe('weldMesh equals the reference algorithm', () => {
  it('on random meshes at tolerance 0, a boundary-sized tolerance and a loose one', () => {
    for (let seed = 1; seed <= 150; seed++) {
      for (const tolerance of [0, 1e-3, 0.37]) {
        const mesh = randomMesh(seed, tolerance);
        expect(weldMesh(mesh, tolerance), `seed ${seed} tolerance ${tolerance}`).toEqual(weldReference(mesh, tolerance));
      }
    }
  });

  it('on soups with repeated corners, -0 / 0, NaN and an empty mesh', () => {
    const soup: number[] = [];
    const next = random(7);
    for (let t = 0; t < 300; t++)
      for (let c = 0; c < 3; c++) soup.push(Math.floor(next() * 4), next() < 0.5 ? -0 : 0, Math.floor(next() * 3));
    soup.push(NaN, 0, 0, NaN, 0, 0, 1, 1, 1);
    const indices = Array.from({ length: soup.length / 3 }, (_, i) => i);
    for (const tolerance of [0, 1e-6, 0.5]) {
      expect(weldMesh({ positions: soup, indices }, tolerance)).toEqual(weldReference({ positions: soup, indices }, tolerance));
    }
    expect(weldMesh({ positions: [], indices: [] }, 1e-6)).toEqual(weldReference({ positions: [], indices: [] }, 1e-6));
  });

  it('welds a million-triangle soup (3M corners) to the grid vertices, in first-use order', () => {
    const n = 707;
    const grid = (i: number, j: number): number[] => [i * 0.1, j * 0.1, Math.sin(i * 0.05) * Math.cos(j * 0.07) * 3];
    const positions: number[] = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        positions.push(...grid(i, j), ...grid(i + 1, j), ...grid(i, j + 1), ...grid(i + 1, j), ...grid(i + 1, j + 1), ...grid(i, j + 1));
    const indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
    const started = performance.now();
    const welded = weldMesh({ positions, indices }, 1e-6);
    const elapsed = performance.now() - started;
    expect(welded.positions.length / 3).toBe((n + 1) * (n + 1));
    expect(welded.triangles.slice(0, 6)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(welded.mergedVertices).toBe(positions.length / 3 - (n + 1) * (n + 1));
    expect(elapsed).toBeLessThan(8000); // about 5 s before the typed-array tables
  }, 60_000);
});

/** The clustering before the typed-array tables. */
function lodReference(mesh: MeshData, target: number): MeshData {
  const cluster = (cell: number, origin: number[], cells: number[]): MeshData => {
    const vertexCount = mesh.positions.length / 3;
    const targetOf = new Int32Array(vertexCount).fill(-1);
    const byCell = new Map<number, number>();
    const sums: number[] = [];
    const counts: number[] = [];
    const referenced = new Uint8Array(vertexCount);
    for (const v of mesh.indices) referenced[v] = 1;
    for (let v = 0; v < vertexCount; v++) {
      if (referenced[v] !== 1) continue;
      const [ix, iy, iz] = [0, 1, 2].map((a) =>
        Math.min(cells[a] as number, Math.floor(((mesh.positions[v * 3 + a] as number) - (origin[a] as number)) / cell)),
      );
      const key = (ix as number) + ((cells[0] as number) + 1) * ((iy as number) + ((cells[1] as number) + 1) * (iz as number));
      let id = byCell.get(key);
      if (id === undefined) {
        id = counts.length;
        byCell.set(key, id);
        counts.push(0);
        sums.push(0, 0, 0);
      }
      targetOf[v] = id;
      counts[id] = (counts[id] as number) + 1;
      for (let a = 0; a < 3; a++) sums[id * 3 + a] = (sums[id * 3 + a] as number) + (mesh.positions[v * 3 + a] as number);
    }
    const positions = sums.map((value, i) => value / (counts[Math.floor(i / 3)] as number));
    const indices: number[] = [];
    const seen = new Set<string>();
    for (let f = 0; f + 2 < mesh.indices.length; f += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => targetOf[mesh.indices[f + k] as number] as number) as [number, number, number];
      if (a === b || b === c || a === c) continue;
      const key = [a, b, c].sort((x, y) => x - y).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      indices.push(a, b, c);
    }
    return { positions, indices };
  };
  if (mesh.indices.length / 3 <= target) return mesh;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] as number, mesh.positions[i + a] as number);
      max[a] = Math.max(max[a] as number, mesh.positions[i + a] as number);
    }
  const extent = [0, 1, 2].map((a) => (max[a] as number) - (min[a] as number));
  let cell = Math.max(...extent, 1e-300) / Math.sqrt(target);
  let accepted: { mesh: MeshData; gap: number } | null = null;
  let latest = mesh;
  for (let pass = 0; pass < 6; pass++) {
    latest = cluster(
      cell,
      min,
      extent.map((e) => Math.max(1, Math.ceil(e / cell))),
    );
    const count = latest.indices.length / 3;
    const gap = Math.abs(Math.log(Math.max(count, 1) / target));
    if (count <= target * 1.25 && (accepted === null || gap < accepted.gap)) accepted = { mesh: latest, gap };
    if (count > target * 0.7 && count <= target * 1.25) break;
    cell *= Math.sqrt(Math.max(count, 1) / target);
  }
  return accepted?.mesh ?? latest;
}

describe('lodMesh equals the reference clustering', () => {
  it('on a bumpy grid, a random triangle cloud with repeated and degenerate faces, and an under-target mesh', () => {
    const n = 120;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) positions.push(i, j, Math.sin(i * 0.3) * Math.cos(j * 0.2) * 4);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j;
        indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    const next = random(3);
    const cloud: number[] = [];
    for (let v = 0; v < 3000; v++) cloud.push(next() * 10, next() * 3, next());
    const cloudIndices: number[] = [];
    for (let t = 0; t < 6000; t++) cloudIndices.push(Math.floor(next() * 3000), Math.floor(next() * 3000), Math.floor(next() * 3000));
    for (const [mesh, target] of [
      [{ positions, indices }, 1500],
      [{ positions, indices }, 6000],
      [{ positions: cloud, indices: cloudIndices }, 500],
      [{ positions, indices }, 1_000_000],
    ] as const) {
      expect(lodMesh(mesh, target)).toEqual(lodReference(mesh, target));
    }
  });
});
