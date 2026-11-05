/**
 * Through-thickness mesh adequacy of the solid tetrahedra (TR-INT-07): measured on the actual mesh by `meshAdequacy` (@cae). Gating always re-measures
 * from the mesh; the verdict recorded on the results by fea_solve is display only.
 */
export interface FeMeshAdequacy {
  /** Worst part verdict; `unmeasured` when the mesh artifact was not available to measure (gates like `inadequate`). */
  readonly verdict: 'adequate' | 'marginal' | 'inadequate' | 'unmeasured';
  /** One entry per part and element order: the area-weighted 5th percentile of the element layers (hit distance / local element size) of rays cast through the wall, and the budget. */
  readonly parts: readonly {
    readonly entityId: string;
    readonly order: 'linear' | 'quadratic';
    readonly elementsThrough: number;
    /** Fewest layers over all sampled faces (the thinnest spot). */
    readonly minimumLayers: number;
    /** Tetrahedra crossed by the ray that sets `elementsThrough` (secondary data: a hex-equivalent layer is about 3 tets). */
    readonly tetsCrossed: number;
    readonly required: number;
    readonly samples: number;
    readonly verdict: 'adequate' | 'marginal' | 'inadequate';
  }[];
  /** Parts with no solid tetrahedra (shell / plane-stress meshes): not measured, never counted as inadequate. */
  readonly unmeasuredParts: readonly string[];
}
