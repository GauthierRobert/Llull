/**
 * Regenerates `solver/crates/llull-meshops/tests/data/ts_pins.json`, the results of the TypeScript mesh engine that the cargo test `ts_pins` pins
 * (DES-7c step 7). Skipped unless `LLULL_PIN_DIR` names the folders `cargo test -p llull-meshops --test ts_pins -- --ignored write_pin_inputs` wrote;
 * `LLULL_PIN_WRITE` is the file to write. The instructions are in `ts_pins.rs`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isEngineFailure, type MeshOp } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import type { MeshData } from '@core/model/types';

const dir = process.env['LLULL_PIN_DIR'];
const target = process.env['LLULL_PIN_WRITE'];

/** The mesh of a job folder (little-endian `positions.f64` and `indices.u32`; `suffix` "_b" reads the second mesh of a two-mesh op). */
function readMesh(folder: string, suffix = ''): MeshData {
  const positions = readFileSync(path.join(folder, `positions${suffix}.f64`));
  const indices = readFileSync(path.join(folder, `indices${suffix}.u32`));
  return {
    positions: Array.from({ length: positions.length / 8 }, (_, i) => positions.readDoubleLE(i * 8)),
    indices: Array.from({ length: indices.length / 4 }, (_, i) => indices.readUInt32LE(i * 4)),
  };
}

/** SHA-256 of the positions as little-endian f64 followed by the indices as little-endian u32: the stream the cargo test hashes. */
function digestOf(mesh: MeshData): string {
  const positions = Buffer.allocUnsafe(mesh.positions.length * 8);
  mesh.positions.forEach((value, i) => positions.writeDoubleLE(value, i * 8));
  const indices = Buffer.allocUnsafe(mesh.indices.length * 4);
  mesh.indices.forEach((value, i) => indices.writeUInt32LE(value, i * 4));
  return createHash('sha256').update(positions).update(indices).digest('hex');
}

describe('TypeScript engine pins for the native twins', () => {
  const regen = dir !== undefined && target !== undefined ? it : it.skip;
  regen('writes the digest and the report of every pinned case', () => {
    const pins: Record<string, unknown> = {};
    for (const name of readdirSync(dir as string).sort()) {
      const folder = path.join(dir as string, name);
      const job = JSON.parse(readFileSync(path.join(folder, 'job.json'), 'utf8')) as { op: string; params: Record<string, unknown> };
      const result = tsMeshEngine.run({ mesh: readMesh(folder) }, {
        op: job.op,
        ...job.params,
        ...(existsSync(path.join(folder, 'positions_b.f64')) ? { target: { mesh: readMesh(folder, '_b') } } : {}),
      } as MeshOp);
      expect(isEngineFailure(result), name).toBe(false);
      if (isEngineFailure(result)) continue;
      pins[name] = {
        digest: result.mesh === undefined ? null : digestOf(result.mesh),
        report: result.report,
        ...(result.analysis !== undefined ? { analysis: result.analysis } : {}),
      };
    }
    writeFileSync(target as string, `${JSON.stringify(pins, null, 2)}\n`);
  });
});
