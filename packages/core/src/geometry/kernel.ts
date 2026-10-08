/**
 * Injected geometry kernel interface (architecture L9). Interface only: no WASM, no three.js, no async.
 * Commands read it from `ctx.kernel` and no-op when it is null; the composition root installs it.
 *
 * @layer core/geometry
 */

import type { Entity } from '../model/types';

/**
 * World-space triangle mesh.
 * `positions`: flat xyz triples (length 3 × vertexCount); `indices`: flat triangle vertex indices.
 */
export interface MeshData {
  readonly positions: ReadonlyArray<number>;
  readonly indices: ReadonlyArray<number>;
}

export type BooleanOp = 'union' | 'subtract' | 'intersect';

/**
 * Every operation returns null when it cannot be performed (unsupported kind, degenerate geometry,
 * kernel limitation); commands treat null as a no-op. Implementors must not mutate arguments.
 * Support today: `filletEdges`, `chamferEdges` and `shellSolid` are OCC only (Manifold returns null).
 *
 * @pure
 */
export interface GeometryKernel {
  /** `a` and `b` are 3D solids; 'subtract' yields a − b. */
  booleanOp(op: BooleanOp, a: Entity, b: Entity): MeshData | null;

  /** `edgeIndices` are 0-based (empty = all edges); `radius` > 0 in document units. */
  filletEdges(shape: MeshData, edgeIndices: number[], radius: number): MeshData | null;

  /** `edgeIndices` are 0-based (empty = all edges); `distance` > 0 in document units. */
  chamferEdges(shape: MeshData, edgeIndices: number[], distance: number): MeshData | null;

  /** Hollow a closed solid inward; `thickness` > 0 in document units. */
  shellSolid(shape: MeshData, thickness: number): MeshData | null;

  /** Mesh of a 3D solid entity; null for 2D entities. */
  tessellate(entity: Entity): MeshData | null;
}

let _kernel: GeometryKernel | null = null;

/** Inject the process-default kernel (read by `defaultContext()`); null resets (tests). */
export function setGeometryKernel(k: GeometryKernel | null): void {
  _kernel = k;
}

/** The injected kernel, or null when none is installed (headless, tests). */
export function getGeometryKernel(): GeometryKernel | null {
  return _kernel;
}
