/**
 * @layer mcp
 *
 * Server-only render_view enrichment param types (never passed to core).
 */

interface TurntableParams {
  /** Number of evenly-spaced frames (1..12). */
  frames: number;
}

export interface SectionParams {
  /** Axis to cut along ('x' | 'y' | 'z'). */
  axis: 'x' | 'y' | 'z';
  /** World-space offset of the cut plane along the axis. */
  offset: number;
}

/** All optional enrichment params that the server handles. */
export interface RenderViewEnrichParams {
  /** Base render_view params forwarded to core. */
  view?: string;
  width?: number;
  height?: number;
  /** Turntable strip — frames evenly spaced around the Z (up) axis. */
  turntable?: TurntableParams;
  /** Entity id(s) to highlight; all others are dimmed/desaturated. */
  isolate?: string | string[];
  /** Overlay bounding-box W × D × H dimensions as text on the image. */
  showDimensions?: boolean;
  /** Section plane overlay: cut at axis=offset; negative side dimmed. */
  section?: SectionParams;
  /**
   * Overlay a world-frame X/Y/Z axis triad at the origin.
   * X=red, Y=green, Z=blue. Default: true.
   */
  showAxes?: boolean;
  /**
   * Overlay a faint ground grid on the Z=0 plane.
   * Default: true.
   */
  showGrid?: boolean;
  /**
   * Overlay per-entity id/name labels and key-point markers on the SVG.
   * Renders a small marker at each entity's structural key points (endpoints,
   * center, corners, …) and a text label showing the entity name (or id).
   * A legend in the top-right corner maps colors to entity categories.
   * Default: false — opt in so plain render_view stays uncluttered.
   */
  showLabels?: boolean;
}
