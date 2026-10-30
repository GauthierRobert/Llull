/** Overlay kinds of render_view `overlay` and what an overlay drew (leaf module: types.ts and overlayCage.ts both use it, neither imports the other). */

export const OVERLAY_KINDS = ['cage', 'net'] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

/** What an overlay drew, for `data.overlays` (counts of the elements in the SVG, entity ids in document order). */
export interface OverlayStats {
  readonly entities: string[];
  /** Cage: unique cage edges drawn. Net: control-net segments (rows and columns of surfaces, the polygon of curves). */
  readonly lines: number;
  /** Cage vertices, or net poles, drawn as dots. */
  readonly points: number;
}
