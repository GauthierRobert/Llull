/** World-space triangle mesh. `positions`: flat xyz triples (length 3 × vertexCount); `indices`: flat triangle vertex indices. */
export interface MeshData {
  readonly positions: ReadonlyArray<number>;
  readonly indices: ReadonlyArray<number>;
  /** Texture coordinates, 2 per vertex (RV-M1); absent = box-projected by the renderer (`geometry/meshUvs.ts`). Ignored unless the length is 2 × vertexCount. */
  readonly uvs?: ReadonlyArray<number>;
  /** Unit vertex normals, 3 per vertex (RV-M1); absent = derived from the faces. Ignored unless the length equals `positions`. */
  readonly normals?: ReadonlyArray<number>;
}
