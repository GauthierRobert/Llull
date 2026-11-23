/** Provenance and grouping of mesh triangles (07 MSH): where an imported mesh came from, and named triangle ranges. */
import type { Vec3 } from './vectors';

/** Provenance of imported or generated mesh triangles (07 MSH TECHNICAL §3). */
export interface MeshSource {
  readonly format: 'stl-ascii' | 'stl-binary' | 'obj' | 'ply' | '3mf' | 'generated';
  readonly fileName?: string;
  /** sha256 (hex) of the file bytes as read. */
  readonly sourceSha256?: string;
  /** File unit -> document unit factor applied once on import. */
  readonly unitScale: number;
  /** True only when the caller asserted a pin that matched `sourceSha256` (or the mesh is generated). */
  readonly verified: boolean;
}

type P3 = readonly [number, number, number];

/** A primitive fitted to a group of triangles (07 MSH segment_mesh / mesh_to_brep); residuals are vertex distances in document units. */
export type PrimitiveFit =
  | { readonly type: 'plane'; readonly point: P3; readonly normal: P3; readonly rms: number; readonly max: number }
  | {
      readonly type: 'cylinder';
      readonly axisPoint: P3;
      readonly axis: P3;
      readonly radius: number;
      readonly rms: number;
      readonly max: number;
    }
  | {
      readonly type: 'cone';
      readonly apex: P3;
      readonly axis: P3;
      readonly halfAngleRad: number;
      readonly rms: number;
      readonly max: number;
    }
  | { readonly type: 'sphere'; readonly center: P3; readonly radius: number; readonly rms: number; readonly max: number }
  | { readonly type: 'freeform'; readonly rms: number; readonly max: number };

/** A named set of triangles of a mesh entity (OBJ group, 3MF object, segmentation region). */
export interface FaceGroup {
  readonly id: string;
  /** `[start, end)` triangle ranges. */
  readonly faces: ReadonlyArray<readonly [number, number]>;
  /** The primitive fitted to the group, when it comes from a segmentation. */
  readonly fit?: PrimitiveFit;
}

/** A full-resolution mesh in the host's content-addressed asset store (07 MSH FR-MSH-02); the entity's `mesh` is then a display level of detail. */
export interface MeshAssetRef {
  /** sha256 (64 hex) of the canonical asset bytes: the key. */
  readonly key: string;
  readonly triangles: number;
  readonly vertices: number;
  /** Bounds of the asset positions (document units, entity-local frame). */
  readonly bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
}

/** Per-vertex display colours of a mesh solid (terrain tint): sRGB bytes, r, g, b for each vertex of `mesh.positions`, drawn over `color`; ignored unless 3 per vertex. */
export interface VertexTint {
  vertexColors?: ReadonlyArray<number>;
}

/**
 * What names a face of a parametric solid independently of its size: the area-weighted mean normal of its patch, the patch centre as fractions
 * of the body's bounding box (0..1 per axis) and the sign of normal . (centre - body middle) (outer or inner wall). A resize keeps all three
 * within the tolerances of `faceColors.ts`; two faces of one body never do (their normals or centres differ by 0.5 or more).
 */
export interface FaceSignature {
  readonly normal: Vec3;
  readonly centre: Vec3;
  readonly outward: 1 | -1;
}

/** Colour of one face: the smooth patch around `near` (entity-local, before `position` / `rotation`) on a mesh solid; on a parametric solid the patch matching `sig`, else the one around `near`. */
export interface FaceColor {
  readonly near: Vec3;
  /** Hex `#rrggbb`. */
  readonly color: string;
  /** Parametric solids only: signature of the picked patch; resolved on the current triangles, so a resize or profile edit keeps the face. */
  readonly sig?: FaceSignature;
}

/** Per-face display colours (`set_face_color`), drawn over `color`; resolved on the current triangles (a mesh solid's `mesh`, a primitive's tessellation) by `faceColorTriangles`. */
export interface FaceColored {
  faceColors?: ReadonlyArray<FaceColor>;
}
