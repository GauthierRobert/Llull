/**
 * `ctx.spatialIndex` host transport (plant 09 VIS-M8e, RS1 RS-6): builds the instance BVH of very large box sets with `llull-compute bvh`
 * (job folder: `job.json` {version 1, op "build", count} + `boxes.f64`; outputs `order.u32`, `nodeBox.f64`, `nodeStart.u32`, `nodeEnd.u32`,
 * `nodeChild.i32`, contract in `solver/crates/llull-bvh/src/job.rs`). Commands are synchronous, so the job runs through `runComputeSync` like
 * `ctx.raster`: the caller blocks for the build (1.2 s at 10^6 boxes plus the file round trip). The Rust tree is bit-identical to
 * `buildInstanceBvh` (VC-VIS-60), so the answer never depends on which side built it.
 * Below `NATIVE_MIN_BOXES` the process start and the files cost more than the TypeScript build, so the TypeScript build answers. A failed job
 * (binary missing, crash, timeout, protocol, an output that does not validate) is logged and answered by the TypeScript build: the call never
 * fails and commits nothing partial (commands are pure; the port returns a tree or the TypeScript tree).
 * Installed by the CLI and the backend only when the binary exists. Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR, LLULL_NATIVE_KEEP=1.
 */

import { setSpatialIndex, type SpatialIndexPort } from '@core/geometry/spatialIndex';
import { type InstanceBvh, type PackedBoxes, buildInstanceBvh, importInstanceBvh } from '@core/geometry/instanceBvh';
import { errorMessage } from '@lib/errorMessage';
import { f64Bytes, f64Values, readOutputSync, runComputeSync, withJobFolderSync } from './computeJob';
import { nativeBinaryPath } from './nativeBinary';

/** Boxes from which the native build replaces the TypeScript one (measured at VIS-M8e, 09 spec §12.13). */
export const NATIVE_MIN_BOXES = 250_000;
/** Named guards: the build takes ~1.2 us per box; the wait is the process start allowance plus a generous 50 us per box (10^6 boxes: 80 s). */
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_BOX_MS = 0.05;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const timeoutFor = (count: number): number => TIMEOUT_BASE_MS + Math.ceil(count * TIMEOUT_PER_BOX_MS);

/** A copy of `bytes` as `Type` (aligned, owned); an Error unless the byte length is a whole number of items. */
function typed<T extends Uint32Array | Int32Array>(Type: { new (buffer: ArrayBuffer): T; BYTES_PER_ELEMENT: number }, bytes: Buffer): T {
  if (bytes.length % Type.BYTES_PER_ELEMENT !== 0) throw new Error(`an output of ${bytes.length} bytes is not whole ${Type.name} items`);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Type(copy.buffer);
}

/** The BVH `binary` builds for `boxes`; throws on any failure (the caller falls back). */
function nativeBuild(binary: string, env: NodeJS.ProcessEnv, boxes: PackedBoxes, timeoutMs: number): InstanceBvh {
  const count = boxes.length / 6;
  if (!Number.isInteger(count)) throw new Error(`${boxes.length} box values are not 6 per box`);
  const files = { 'job.json': JSON.stringify({ version: 1, op: 'build', count }), 'boxes.f64': f64Bytes(boxes) };
  return withJobFolderSync(
    files,
    (folder) => {
      const run = runComputeSync(binary, ['bvh', folder], folder, timeoutMs, env, MAX_OUTPUT_BYTES);
      if (!run.ok) throw new Error(`${run.code ?? 'NATIVE_PROTOCOL'}: ${run.message ?? 'llull-compute bvh failed'}`);
      const read = (name: string): Buffer => readOutputSync(folder, run, name);
      const nodeStart = typed(Uint32Array, read('nodeStart.u32'));
      // importInstanceBvh validates counts, permutation, ranges and links: a corrupt tree throws here, before any query reads it
      return importInstanceBvh({
        count,
        nodeCount: nodeStart.length,
        boxes,
        order: typed(Uint32Array, read('order.u32')),
        nodeBox: f64Values(read('nodeBox.f64')),
        nodeStart,
        nodeEnd: typed(Uint32Array, read('nodeEnd.u32')),
        nodeChild: typed(Int32Array, read('nodeChild.i32')),
        transfer: [],
      });
    },
    env,
  );
}

/** Tuning of a port: tests shrink both. */
export interface SpatialIndexOptions {
  /** Boxes from which the native build is used. Default `NATIVE_MIN_BOXES`. */
  readonly minBoxes?: number;
  /** Wait for one build, in ms. Default: 30 s + 50 us per box. */
  readonly timeoutMs?: number;
}

/** A port running `binary`. */
export function createNativeSpatialIndex(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  { minBoxes = NATIVE_MIN_BOXES, timeoutMs }: SpatialIndexOptions = {},
): SpatialIndexPort {
  return {
    build(boxes) {
      if (boxes.length / 6 < minBoxes) return buildInstanceBvh(boxes);
      try {
        return nativeBuild(binary, env, boxes, timeoutMs ?? timeoutFor(boxes.length / 6));
      } catch (error) {
        console.warn(`[llull] bvh build failed (${errorMessage(error)}); built by the TypeScript engine`);
        return buildInstanceBvh(boxes);
      }
    },
  };
}

/** Installs the native index as the process `ctx.spatialIndex` when `llull-compute` exists; returns whether it did. */
export function installSpatialIndex(env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = nativeBinaryPath('llull-compute', env);
  setSpatialIndex(binary === null ? null : createNativeSpatialIndex(binary, env));
  return binary !== null;
}
