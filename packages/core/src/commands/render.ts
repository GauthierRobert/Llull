/**
 * render_view — pure SVG renderer for the "AI vision loop".
 *
 * Renders the document to a self-contained SVG string using pure math and string
 * building. No three.js, no DOM, no React. The document coordinate convention is
 * Z-up throughout: +X right, +Y forward, +Z up. This matches the model/types.ts
 * entity contracts (box, cone, pyramid, wedge, extrusion are all Z-up).
 */

import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import type { ViewName } from './renderCamera';
import { renderDocument } from './renderScene';
import { composeOverlays } from './renderOverlays';
import { buildTurntableSvg, buildIsolateSvg, buildSectionSvg } from './renderMultiPass';

const clampPixels = (value: number | undefined, fallback: number): number =>
  Math.max(64, Math.min(2000, Math.round(value ?? fallback)));

/**
 * @command render_view
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.svg is a self-contained <svg> string; document === input doc (referential equality)
 * @invariant turntable wins over isolate over section; turntable output carries no overlays
 * @failure width/height clamped to [64, 2000]; turntable.frames clamped to [1, 12]
 */
export const renderView = defineCommand({
  name: 'render_view',
  annotations: { readOnly: true },
  description:
    'Render the document to a self-contained SVG image string so an AI agent can SEE the scene and self-correct. ' +
    'Returns the unchanged document plus a `data` object containing: `svg` (complete SVG string), ' +
    '`view` (resolved view name), `width`, `height`, `entityCount`, `bounds` (world AABB or null), ' +
    'and `camera` ({position, target, up}). ' +
    'Choose `view` to orient the render: "iso" (default isometric), "top", "bottom", "front", "back", ' +
    '"left", or "right" (all orthographic). ' +
    'Adjust `width`/`height` (pixels, clamped to [64, 2000], default 800×600) for resolution. ' +
    'The SVG uses flat Lambertian shading on 3D solids and stroked paths for 2D shapes. ' +
    'Enrichments: turntable (multi-frame strip), isolate (highlight entities), section (cut-plane view), ' +
    'showDimensions (bbox labels), showAxes (world triad, default on), showGrid (ground grid, default on), ' +
    'showLabels (entity id/name labels + key-point markers, default off). ' +
    'Does NOT modify the document; `affected` is always [].',
  params: z.object({
    view: z
      .enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'])
      .optional()
      .describe(
        'Camera direction. One of: "iso" (isometric — default, good for orienting in 3D), ' +
          '"top" (looking down the +Z axis), "bottom" (looking up the -Z axis), ' +
          '"front" (looking along the +Y axis), "back" (looking along the -Y axis), ' +
          '"left" (looking along the +X axis), "right" (looking along the -X axis). ' +
          'Omit for the default "iso" view.',
      ),
    width: z
      .number()
      .optional()
      .describe('Output image width in pixels. Clamped to [64, 2000]. Default: 800.'),
    height: z
      .number()
      .optional()
      .describe('Output image height in pixels. Clamped to [64, 2000]. Default: 600.'),
    turntable: z
      .object({
        frames: z
          .number()
          .describe(
            'Number of frames (1..12). Each frame is a separate rotated view stitched into one wide strip.',
          ),
      })
      .optional()
      .describe(
        'Produce a horizontal strip of N evenly-spaced rotation frames around the Z (up) axis. ' +
          'frames: integer 1..12. When omitted, behavior is unchanged (single frame).',
      ),
    isolate: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Entity id (or array of ids) to highlight. All other entities are rendered ' +
          'dimmed/desaturated; the specified id(s) are shown at full color.',
      ),
    section: z
      .object({
        axis: z.enum(['x', 'y', 'z']).describe('Axis normal to the cut plane: "x", "y", or "z".'),
        offset: z.number().describe('World-space position of the cut plane along the axis.'),
      })
      .optional()
      .describe(
        'Render a section-plane view: entities on the negative side of the cut plane are dimmed; ' +
          'a colored dashed line marks the cut. axis: "x"|"y"|"z"; offset: world-space position of the plane.',
      ),
    showDimensions: z
      .boolean()
      .optional()
      .describe(
        'When true, overlay the bounding-box dimensions (W × D × H) as text labels on the image. ' +
          'Labels are placed near the bounding box edges in screen space.',
      ),
    showAxes: z
      .boolean()
      .optional()
      .describe(
        'When true (default), overlay a world-frame X/Y/Z axis triad anchored at the world origin. ' +
          'X=red, Y=green, Z=blue. A scale label (e.g. "1 mm = 42 px") is also shown. ' +
          'Set to false to suppress.',
      ),
    showGrid: z
      .boolean()
      .optional()
      .describe(
        'When true (default), overlay a faint ground grid on the Z=0 plane so you can judge ' +
          'object placement relative to the world origin. Set to false to suppress.',
      ),
    showLabels: z
      .boolean()
      .optional()
      .describe(
        'When true, overlay per-entity id/name labels and key-point markers on the image. ' +
          'Each entity shows its name (or id) at the centroid of its key points (endpoints, center, ' +
          'corners, AABB corners for solids). Markers are color-coded by category: ' +
          'orange=point, cyan=2D curve, purple=3D solid, yellow=annotation. ' +
          'A legend appears in the top-right corner. Default: false (opt in to avoid clutter).',
      ),
  }),
  run: (doc, params): CommandResult => {
    const view: ViewName = params.view ?? 'iso';
    const width = clampPixels(params.width, 800);
    const height = clampPixels(params.height, 600);
    const base = renderDocument(doc, view, width, height);
    const plural = base.entityCount === 1 ? 'y' : 'ies';
    let summary = `Rendered ${view} view: ${base.entityCount} entit${plural}, ${width}×${height}.`;

    if (params.turntable) {
      const frames = Math.max(1, Math.min(12, Math.round(params.turntable.frames)));
      const strip = buildTurntableSvg(doc, frames, view, width, height);
      return {
        document: doc,
        summary: `Rendered turntable strip: ${frames} frame(s), ${strip.width}×${height}.`,
        affected: [],
        data: { ...base, width: strip.width, svg: strip.svg },
      };
    }

    let svg = base.svg;
    if (params.isolate !== undefined) {
      const ids = typeof params.isolate === 'string' ? [params.isolate] : params.isolate;
      svg = buildIsolateSvg(doc, ids, view, width, height);
      summary = `Rendered isolated view: ${ids.length} entity/entities highlighted, ${width}×${height}.`;
    } else if (params.section) {
      const { axis, offset } = params.section;
      svg = buildSectionSvg(doc, axis, offset, view, width, height);
      summary = `Rendered section view: cut at ${axis}=${offset}, ${width}×${height}.`;
    }
    svg = composeOverlays(svg, base, doc, {
      showDimensions: params.showDimensions === true,
      showAxes: params.showAxes !== false,
      showGrid: params.showGrid !== false,
      showLabels: params.showLabels === true,
    });

    return { document: doc, summary, affected: [], data: { ...base, svg } };
  },
});
