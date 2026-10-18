/**
 * render_view — pure SVG renderer for the "AI vision loop".
 *
 * Renders the document to a self-contained SVG string using pure math and string building. No three.js, no DOM, no React. The document
 * coordinate convention is Z-up throughout: +X right, +Y forward, +Z up. This matches the model/types.ts entity contracts (box, cone,
 * pyramid, wedge, extrusion are all Z-up).
 */

import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { escapeXml } from '../../lib/escapeXml';
import type { ViewName } from './camera';
import { renderDocument } from './scene';
import { composeOverlays } from './overlays';
import { appendBeforeClose } from './svg';
import { renderNotes, resolveRenderOptions } from './options';
import { buildTurntableSvg, buildIsolateSvg, buildSectionSvg } from './multiPass';
import { report } from '../noop';
import { is2D } from '../../model/types';
import type { CadDocument } from '../../model/types';
import { clamp } from '../../lib/clamp';

/** `doc` without its 2D entities (read-only view for rendering; the input is untouched). */
function withoutEntities2D(doc: CadDocument): CadDocument {
  const entities = Object.fromEntries(Object.entries(doc.entities).filter(([, e]) => !is2D(e)));
  return { ...doc, entities, order: doc.order.filter((id) => id in entities) };
}

const clampPixels = (value: number | undefined, fallback: number): number => clamp(Math.round(value ?? fallback), 64, 2000);

/**
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
    'Solids are flat-Lambert shaded and depth-buffered per pixel (mode "raster", default: a PNG inside the SVG, outlines at creases and part boundaries) or drawn as sorted SVG polygons (mode "vector"); 2D shapes are stroked paths. ' +
    'Camera: `zoom` (>1 magnifies), `direction` ([x,y,z] vector from the scene toward the camera, overrides `view`), ' +
    '`target` (point to look at). `title` draws text top-left, `background` sets the image color. ' +
    'Cutaway: `cut` clips solids (triangles are split, not dropped) and draws the section as a hatched cap, ' +
    'e.g. remove the quadrant x>0,y<0 with planes [{normal:[1,0,0],offset:0},{normal:[0,-1,0],offset:0}] and mode "intersection". ' +
    'Large scenes are never silently truncated: the polygon budget (`maxPolygons`) is shared fairly between entities, ' +
    'and `data.simplifiedEntityIds` / `data.skippedEntityIds` / `data.polygonCount` report what was reduced. ' +
    'Enrichments: turntable (multi-frame strip), isolate (highlight entities), section (cut-plane view), ' +
    'showDimensions (bbox labels), showAxes (world triad, default on), showGrid (ground grid, default on), ' +
    'showLabels (entity id/name labels + key-point markers, default off). Does NOT modify the document; `affected` is always [].',
  params: z.object({
    view: z
      .enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'])
      .optional()
      .describe(
        'Camera direction. One of: "iso" (isometric — default, good for orienting in 3D), ' +
          '"top" (looking down the +Z axis), "bottom" (looking up the -Z axis), ' +
          '"front" (looking along the +Y axis), "back" (looking along the -Y axis), ' +
          '"left" (looking along the +X axis), "right" (looking along the -X axis). Omit for the default "iso" view.',
      ),
    width: z.number().optional().describe('Output image width in pixels. Clamped to [64, 2000]. Default: 800.'),
    height: z.number().optional().describe('Output image height in pixels. Clamped to [64, 2000]. Default: 600.'),
    turntable: z
      .object({
        frames: z.number().int().describe('Number of frames (1..12). Each frame is a separate rotated view stitched into one wide strip.'),
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
    zoom: z
      .number()
      .optional()
      .describe('Magnification of the framed scene, clamped to [0.1, 50]. 1 (default) fits the whole scene; 3 shows a third of it.'),
    direction: vec3(
      'Custom viewing direction: a non-zero [x, y, z] vector pointing from the scene center toward the camera (Z-up). ' +
        'Overrides `view`; e.g. [1,-1,0.5] looks from +X/-Y above. Result `view` is "custom".',
    ).optional(),
    target: vec3(
      'World point the camera looks at (default: center of the scene bounds). Combine with `zoom` to inspect a detail.',
    ).optional(),
    title: z.string().optional().describe('Text drawn top-left of the image (max 120 characters, longer is truncated).'),
    background: z
      .string()
      .optional()
      .describe('Background CSS color: "#rrggbb", "#rgb", a color name ("white") or rgb()/hsl(). Default "#1a1a2e" (dark navy).'),
    mode: z
      .enum(['raster', 'vector'])
      .optional()
      .describe(
        '"raster" (default): solids are depth-buffered per pixel (always correct occlusion, crisp outlines) and embedded as a PNG in the SVG; ' +
          '"vector": every face is an SVG polygon sorted back to front (editable, but faces can draw through each other in dense scenes).',
      ),
    maxPolygons: z
      .number()
      .optional()
      .describe(
        'Polygon budget of vector mode, clamped to [500, 100000], default 20000 (raster mode allows at least 400000). Entities over their fair share are decimated (see data.simplifiedEntityIds); raise it for finer detail at the cost of a larger SVG.',
      ),
    cut: z
      .object({
        planes: z
          .array(
            z.object({
              normal: vec3('Plane normal [x, y, z] (any non-zero length). It points to the REMOVED side.'),
              offset: z.number().describe('Plane position: points p with dot(unitNormal, p) = offset lie on the plane.'),
            }),
          )
          .describe('1 to 6 cut planes. Each removes the half-space dot(unitNormal, p) > offset.'),
        mode: z
          .enum(['intersection', 'union'])
          .optional()
          .describe(
            '"intersection" (default): remove only the region on the cut side of ALL planes (e.g. a quadrant or octant notch). "union": remove everything on the cut side of ANY plane.',
          ),
        entityIds: z.array(z.string()).optional().describe('Entity ids to cut. Omit to cut every solid; other entities stay whole.'),
      })
      .optional()
      .describe(
        'Cutaway: clips the selected 3D solids against the planes (triangles are split exactly) and draws the exposed section as a light, hatched, outlined cap so solids do not look hollow. Rendered together with isolate/section/turntable.',
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
          'X=red, Y=green, Z=blue. A scale label (e.g. "1 mm = 42 px") is also shown. Set to false to suppress.',
      ),
    showGrid: z
      .boolean()
      .optional()
      .describe(
        'When true (default), overlay a faint ground grid on the Z=0 plane so you can judge ' +
          'object placement relative to the world origin. Set to false to suppress.',
      ),
    hide2D: z
      .boolean()
      .optional()
      .describe(
        'When true, 2D sketch entities (lines, arcs, circles, polylines, rectangles, text, dimensions...) are neither drawn nor counted in the framing/bounds, ' +
          'so leftover construction sketches used for extrusions do not shrink the 3D part in the frame. Default: false (2D shapes are drawn and framed).',
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
    const scene = params.hide2D === true ? withoutEntities2D(doc) : doc;
    const resolved = resolveRenderOptions(scene, params);
    if ('error' in resolved) return { document: doc, summary: `render_view rejected: ${resolved.error}.`, affected: [] };
    const { options } = resolved;
    const view: ViewName = options.direction ? 'custom' : (params.view ?? 'iso');
    const width = clampPixels(params.width, 800);
    const height = clampPixels(params.height, 600);
    const base = renderDocument(scene, view, width, height, options);
    const notes = renderNotes(base, options.cut);
    const withNotes = (text: string): string => (notes === '' ? text : `${text} ${notes}`);
    const decorate = (svg: string): string => {
      const captions = [
        params.title === undefined
          ? ''
          : `  <text x="8" y="44" font-family="sans-serif" font-size="16" font-weight="bold" fill="#e8e8f4" stroke="#1a1a2e" stroke-width="3" paint-order="stroke">${escapeXml(params.title.slice(0, 120))}</text>`,
        options.cut
          ? `  <text x="${width - 8}" y="${height - 10}" text-anchor="end" font-family="monospace" font-size="11" fill="#ffb060">CUTAWAY (${options.cut.mode}, ${options.cut.planes.length} plane(s))</text>`
          : '',
      ].filter((c) => c !== '');
      return captions.length === 0 ? svg : appendBeforeClose(svg, captions.join('\n'));
    };
    if (params.turntable) {
      const frames = clamp(params.turntable.frames, 1, 12);
      const strip = buildTurntableSvg(scene, frames, view, width, height, options);
      return report(doc, withNotes(`Rendered turntable strip: ${frames} frame(s), ${strip.width}×${height}.`), {
        ...base,
        width: strip.width,
        svg: decorate(strip.svg),
      });
    }
    let svg = base.svg;
    const plural = base.entityCount === 1 ? 'y' : 'ies';
    let summary = `Rendered ${view} view: ${base.entityCount} entit${plural}, ${width}×${height}.`;
    if (params.isolate !== undefined) {
      const ids = typeof params.isolate === 'string' ? [params.isolate] : params.isolate;
      svg = buildIsolateSvg(scene, ids, view, width, height, options);
      summary = `Rendered isolated view: ${ids.length} entity/entities highlighted, ${width}×${height}.`;
    } else if (params.section) {
      const { axis, offset } = params.section;
      svg = buildSectionSvg(scene, axis, offset, view, width, height, options);
      summary = `Rendered section view: cut at ${axis}=${offset}, ${width}×${height}.`;
    }
    svg = composeOverlays(svg, base, scene, {
      showDimensions: params.showDimensions === true,
      showAxes: params.showAxes !== false,
      showGrid: params.showGrid !== false,
      showLabels: params.showLabels === true,
    });
    return report(doc, withNotes(summary), { ...base, svg: decorate(svg) });
  },
});
