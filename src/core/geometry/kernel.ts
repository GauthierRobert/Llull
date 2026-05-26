/**
 * Geometry kernel — injected interface for boolean solid operations.
 *
 * @layer core/geometry
 *
 * This file defines the INTERFACE only. No WASM, no three.js, no async.
 * The concrete kernel (Manifold, OpenCascade, etc.) is injected by the app
 * at startup via `setGeometryKernel`. Commands call `getGeometryKernel()` and
 * gracefully no-op when it returns null (headless / kernel not yet loaded).
 *
 * Dependency inversion: `core/commands` depends on this interface, never on a
 * concrete kernel implementation (architecture L9, SOLID S5).
 */

import type { Entity } from '../model/types';

/**
 * A world-space triangle mesh.
 * - `positions`: flat array of xyz triples, i.e. [x0,y0,z0, x1,y1,z1, …]. Length = 3 × vertexCount.
 * - `indices`: flat array of triangle vertex indices, i.e. [i0,i1,i2, …]. Length = 3 × triangleCount.
 */
export interface MeshData {
  readonly positions: ReadonlyArray<number>;
  readonly indices: ReadonlyArray<number>;
}

/** The three CSG (Constructive Solid Geometry) operations. */
export type BooleanOp = 'union' | 'subtract' | 'intersect';

/**
 * Injected geometry kernel.
 *
 * @pure — implementors must not mutate the entity arguments.
 * @layer core/geometry
 *
 * `booleanOp` evaluates a CSG operation on two solid entities and returns a
 * world-space triangle mesh. The kernel is responsible for interpreting each
 * entity's `kind`, `position`, `rotation`, and geometry fields.
 *
 * Returns `null` when the operation cannot be performed (unsupported entity
 * kind, degenerate geometry, kernel error). Commands treat null as a no-op.
 *
 * Extended in Batch 14 / KI4-productionize with three B-rep ops:
 *   - `filletEdges`  — OCC implements; Manifold graceful no-op.
 *   - `chamferEdges` — OCC stub (needs separate spike); Manifold graceful no-op.
 *   - `shellSolid`   — OCC stub (needs separate spike); Manifold graceful no-op.
 * Commands K1/K2/K3 (future Lane-1 batch) will call these via this interface.
 */
export interface GeometryKernel {
  /**
   * Evaluate a boolean of two solid entities into a world-space triangle mesh.
   * Returns null on failure or unsupported input.
   *
   * @param op   - 'union' | 'subtract' | 'intersect'
   * @param a    - first operand (must be a 3D solid entity)
   * @param b    - second operand (must be a 3D solid entity); for 'subtract', result = a − b
   */
  booleanOp(op: BooleanOp, a: Entity, b: Entity): MeshData | null;

  /**
   * Fillet (round) the specified edges of a solid entity.
   * Returns the tessellated result mesh, or null when the kernel cannot perform
   * the operation (unsupported entity kind, degenerate geometry, kernel limitation).
   *
   * @param shape        - world-space input mesh (e.g. from a prior booleanOp result or direct entity tessellation)
   * @param edgeIndices  - 0-based indices of the edges to fillet; empty array = all edges
   * @param radius       - fillet radius in document units; must be > 0
   */
  filletEdges(shape: MeshData, edgeIndices: number[], radius: number): MeshData | null;

  /**
   * Chamfer (bevel) the specified edges of a solid entity.
   * Returns the tessellated result mesh, or null when the kernel cannot perform
   * the operation. Manifold returns null (graceful no-op). OCC spike pending.
   *
   * @param shape        - world-space input mesh
   * @param edgeIndices  - 0-based indices of the edges to chamfer; empty = all edges
   * @param distance     - chamfer distance in document units; must be > 0
   */
  chamferEdges(shape: MeshData, edgeIndices: number[], distance: number): MeshData | null;

  /**
   * Shell (hollow) a closed solid entity by removing one face and offsetting walls inward.
   * Returns the tessellated shell mesh, or null when the kernel cannot perform
   * the operation. Manifold returns null (graceful no-op). OCC spike pending.
   *
   * @param shape     - world-space input mesh representing a closed solid
   * @param thickness - wall thickness in document units; must be > 0
   */
  shellSolid(shape: MeshData, thickness: number): MeshData | null;
}

// ---------------------------------------------------------------------------
// Injection point — module-level singleton; set once at app startup (A4-ui).
// Commands read via getGeometryKernel(); they must handle null gracefully.
// ---------------------------------------------------------------------------

let _kernel: GeometryKernel | null = null;

/**
 * Inject the concrete geometry kernel. Called once at app startup by the UI layer
 * (or the MCP server) after WASM has been loaded. Pass null to reset (tests).
 */
export function setGeometryKernel(k: GeometryKernel | null): void {
  _kernel = k;
}

/**
 * Read the currently injected kernel.
 * Returns null when no kernel has been injected yet (headless mode, tests without a fake kernel).
 * Commands must check for null and return a graceful no-op summary.
 */
export function getGeometryKernel(): GeometryKernel | null {
  return _kernel;
}
