/**
 * Injected geometry kernel interface (architecture L9). Interface only: no WASM, no three.js, no async.
 * Commands read it from `ctx.kernel` and no-op when it is null; the composition root installs it.
 *
 * The kernel boundary is a SHAPE, not a mesh: a command hands the kernel a `ShapeRecipe` (the
 * construction tree) and gets back an opaque, kernel-owned `ShapeHandle` (an exact B-rep under OCC).
 * Meshes only come OUT of the kernel (`tessellate`), for display and mesh exports.
 *
 * @layer core/geometry
 */

import type { Vec3 } from '../model/types';
import type { ShapeRecipe } from './shapeRecipe';

export type { BooleanOp, ShapeRecipe } from './shapeRecipe';

/**
 * World-space triangle mesh.
 * `positions`: flat xyz triples (length 3 × vertexCount); `indices`: flat triangle vertex indices.
 */
export interface MeshData {
  readonly positions: ReadonlyArray<number>;
  readonly indices: ReadonlyArray<number>;
}

declare const shapeHandleBrand: unique symbol;

/**
 * Opaque reference to a kernel-owned shape. Core never inspects it: it only passes it back to the
 * kernel that minted it. It stays valid after the kernel evicts or restarts (it re-evaluates).
 */
export interface ShapeHandle {
  readonly [shapeHandleBrand]: true;
}

export type EdgeCurve = 'line' | 'circle' | 'ellipse' | 'bspline' | 'other';
export type FaceSurface =
  | 'plane'
  | 'cylinder'
  | 'cone'
  | 'sphere'
  | 'torus'
  | 'bspline'
  | 'revolution'
  | 'extrusion'
  | 'other';

/** One unique edge; `index` is what `fillet_edge` / `chamfer_edge` `edgeIndices` select. */
export interface ShapeEdge {
  readonly index: number;
  readonly curve: EdgeCurve;
  readonly length: number;
  readonly start: Vec3;
  readonly end: Vec3;
  /** Point at the parameter midpoint (on the curve, not the chord). */
  readonly mid: Vec3;
  /** Bounds a single face (a cylinder's seam): no corner to fillet or chamfer. */
  readonly seam: boolean;
  /** Zero-length (a sphere or cone pole): no corner to fillet or chamfer. */
  readonly degenerate: boolean;
}

export interface ShapeFace {
  readonly index: number;
  readonly surface: FaceSurface;
  readonly area: number;
}

/** Exact topology of a kernel shape (B-rep faces and edges, deduplicated, kernel order). */
export interface ShapeTopology {
  readonly solids: number;
  readonly faces: readonly ShapeFace[];
  readonly edges: readonly ShapeEdge[];
  readonly vertices: number;
  readonly volume: number;
}

/**
 * Every operation returns null when it cannot be performed (unsupported op, degenerate geometry,
 * kernel limitation); commands treat null as a no-op. Implementors must not mutate arguments.
 * Exact topology and STEP: OCC only (Manifold is a mesh kernel: `topology` / `exportStep` -> null,
 * and fillet / chamfer / shell recipes evaluate to null).
 *
 * @pure
 */
export interface GeometryKernel {
  /** Whether this kernel can perform recipe nodes of `op` at all (Manifold: no fillet/chamfer/shell). */
  supports(op: ShapeRecipe['op']): boolean;

  /** Build (or reuse, by `recipeKey`) the kernel shape of a recipe. */
  evaluate(recipe: ShapeRecipe): ShapeHandle | null;

  /** Display mesh of a shape (output only: never fed back into the kernel). */
  tessellate(shape: ShapeHandle): MeshData | null;

  /** Exact faces/edges of a shape; null for kernels without a B-rep. */
  topology(shape: ShapeHandle): ShapeTopology | null;

  /** ISO 10303-21 (STEP AP214) text of the shapes as exact B-rep solids; null when unsupported. */
  exportStep(shapes: readonly ShapeHandle[]): string | null;
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
