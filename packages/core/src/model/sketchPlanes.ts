/** Sketch planes and linked sketch geometry (SC-S3). */

import type { Vec3 } from './vectors';

/** An orthonormal plane frame: `origin` on the plane, unit `normal`, unit in-plane `xDir` (yDir = normal × xDir). */
export interface PlaneFrame {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly xDir: Vec3;
}

export type SketchPlaneBase =
  | { readonly kind: 'world'; readonly plane: 'xy' | 'xz' | 'yz' }
  /** A planar face of a solid, followed by its persistent name on regeneration (a step re-resolves it; a lost face fails the step). */
  | { readonly kind: 'face'; readonly entityId: string; readonly faceName?: string };

/**
 * A named sketch plane: a world plane or a solid's planar face, moved `offset` along its normal and spun `spin` radians about it.
 * @invariant frame is the resolved plane (normal unit, xDir unit and orthogonal to it)
 */
export interface SketchPlane {
  readonly id: string;
  readonly name: string;
  readonly base: SketchPlaneBase;
  readonly offset: number;
  readonly spin: number;
  readonly frame: PlaneFrame;
}

/** Sketch geometry projected from (or cut by the plane through) edges of a solid, kept linked to them by persistent edge names. */
export interface SketchLink {
  /** The linked 2D entity. */
  readonly id: string;
  readonly planeId: string;
  readonly source: { readonly entityId: string; readonly edgeNames: readonly string[] };
  readonly mode: 'project' | 'intersect';
}

/** The `CadDocument` fields of sketch planes and linked sketch geometry (SC-S3). */
export interface SketchPlaneFields {
  /** Absent until the first `create_sketch_plane` (SC-S3). */
  sketchPlanes?: Record<string, SketchPlane>;
  /** 2D entities linked to solid edges by `project_edges_to_sketch`, keyed by entity id; absent until the first. */
  sketchLinks?: Record<string, SketchLink>;
}
