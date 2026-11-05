/** Through-thickness mesh adequacy of the solid tetrahedra (TR-INT-07): measured on the actual mesh by `meshAdequacy` (@cae), recorded by fea_solve. */
export interface FeMeshAdequacy {
  readonly verdict: 'adequate' | 'marginal' | 'inadequate';
  /** One entry per part and element order: the 5th percentile of the element layers (hit distance / local element size) of rays cast through the wall, and the budget. */
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
