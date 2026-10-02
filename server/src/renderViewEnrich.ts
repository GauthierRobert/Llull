/**
 * @layer server
 *
 * Server-side enrichments for the `render_view` MCP tool.
 *
 * These features are implemented at the server transport layer because they
 * require multi-pass rendering or SVG post-processing — capabilities that
 * belong in the server (L6) rather than the pure core command layer (L2).
 *
 * The core `render_view` command is called one or more times per enrichment;
 * enrichments never mutate the live document.
 *
 * Enrichments:
 *   turntable     — horizontal strip of N frames evenly spaced around the Z axis
 *   isolate       — dim everything except the specified entity ids
 *   showDimensions — overlay W × D × H bounding-box text on the SVG
 *   section       — overlay a section-plane indicator; negative side dimmed
 *   showLabels    — per-entity id/name labels + key-point markers + legend
 */

export type {
  TurntableParams,
  SectionParams,
  RenderViewEnrichParams,
} from './renderViewEnrich/types';
export {
  buildTurntableFrames,
  buildIsolateSvg,
  buildSectionSvg,
} from './renderViewEnrich/multiPassViews';
export { appendDimensionLabels, appendAxesAndGrid } from './renderViewEnrich/overlays';
export { appendEntityLabels } from './renderViewEnrich/entityLabels';
