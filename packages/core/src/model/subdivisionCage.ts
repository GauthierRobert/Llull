/** Plain data of a subdivision cage beyond vertices and faces: semi-sharp creases, mirror symmetry, persistent element ids (04 DIR). */

/** Semi-sharp cage edge a-b (0 < s < 10; 10 and above is infinitely sharp and lives in `creases`). */
export interface CageEdgeSharpness {
  readonly a: number;
  readonly b: number;
  readonly s: number;
}

/** Semi-sharp cage vertex (corner) v. */
export interface CageVertexSharpness {
  readonly v: number;
  readonly s: number;
}

/** Mirror symmetry of a cage through entity-local planes at the origin; `partners[k][v]` = mirror of vertex v through `planes[k]` (v itself on the plane). */
export interface CageSymmetry {
  readonly planes: ReadonlyArray<'x' | 'y' | 'z'>;
  readonly partners: ReadonlyArray<ReadonlyArray<number>>;
  readonly tolerance: number;
}

/** Persistent element ids, parallel to `vertices` and `faces` (`v-<step>.<k>`, `f-<step>.<k>`); an edge id is derived from its two vertex ids. */
export interface CageElementIds {
  readonly vertices: ReadonlyArray<string>;
  readonly faces: ReadonlyArray<string>;
}
