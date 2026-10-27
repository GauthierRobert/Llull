/** A `llull-compute meshops` job folder that takes seconds: decimation of an n x n grid (2 n^2 triangles) down to 100 triangles. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function longMeshJobFolder(n = 300): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-long-job-'));
  mkdirSync(dir, { recursive: true });
  const positions = new Float64Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const at = (j * (n + 1) + i) * 3;
      positions[at] = i * 0.02;
      positions[at + 1] = j * 0.02;
      positions[at + 2] = Math.sin(i * j * 0.0001) * 0.01;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let k = 0;
  const id = (i: number, j: number): number => j * (n + 1) + i;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      for (const v of [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1)]) indices[k++] = v;
    }
  }
  writeFileSync(path.join(dir, 'positions.f64'), Buffer.from(positions.buffer));
  writeFileSync(path.join(dir, 'indices.u32'), Buffer.from(indices.buffer));
  writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ op: 'decimate', params: { targetTriangles: 100, preserveBoundary: true } }));
  return dir;
}
