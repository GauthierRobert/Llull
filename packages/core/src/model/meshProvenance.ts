/** Provenance and grouping of mesh triangles (07 MSH): where an imported mesh came from, and named triangle ranges. */

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

/** A named range of triangles of a mesh entity. */
export interface FaceGroup {
  readonly id: string;
  /** `[start, end)` triangle ranges. */
  readonly faces: ReadonlyArray<readonly [number, number]>;
}
