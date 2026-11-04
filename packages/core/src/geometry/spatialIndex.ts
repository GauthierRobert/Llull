/**
 * Injected spatial-index port (plant 09 VIS-M8e, RS1 RS-6): builds the `InstanceBvh` of a set of boxes. The default is the TypeScript build
 * (`buildInstanceBvh`, always available); a host may install a faster one (native `llull-compute bvh`) with `setSpatialIndex`. Commands read it
 * from `ctx.spatialIndex` and fall back to `resolveSpatialIndex(...)` when it is null/absent. Synchronous, no native imports.
 * @invariant `build(boxes)` returns a tree whose every query equals the one of `buildInstanceBvh(boxes)` (same indices, ascending); a port
 *   that cannot answer (missing binary, failed job) answers with the TypeScript build itself and never throws for finite boxes
 */

import { type InstanceBvh, type PackedBoxes, buildInstanceBvh } from './instanceBvh';

export interface SpatialIndexPort {
  /** The BVH of `boxes` (6 numbers per box, finite). The port may keep `boxes` (it is not copied). */
  build(boxes: PackedBoxes): InstanceBvh;
}

/** The always-available TypeScript index. */
export const tsSpatialIndex: SpatialIndexPort = { build: buildInstanceBvh };

let installed: SpatialIndexPort | null = null;

/** Install (or with null, remove) the process spatial index read by `defaultContext()`. Composition roots / hosts only. */
export function setSpatialIndex(port: SpatialIndexPort | null): void {
  installed = port;
}

/** The installed port, or null (the TypeScript build then applies through `resolveSpatialIndex`). */
export function getSpatialIndex(): SpatialIndexPort | null {
  return installed;
}

/** The index a command should use: the context's, else the TypeScript build. */
export function resolveSpatialIndex(port: SpatialIndexPort | null | undefined): SpatialIndexPort {
  return port ?? tsSpatialIndex;
}
