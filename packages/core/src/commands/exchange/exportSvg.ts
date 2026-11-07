import type { CommandResult } from '../types';
import { defineCommand, z, confirmExportControlled } from '../schema';
import { exportRefusal, report } from '../noop';
import { MM_PER_UNIT } from '../../model/units';
import { renderDraftSvg } from './draftSvg';
import { isRefusal, planDraftExport, skippedNote } from './draftExport';

/** Default stroke width (mm) and blank border (mm). */
const DEFAULT_LINE_WEIGHT_MM = 0.25;
const DEFAULT_MARGIN_MM = 5;

/**
 * @affects none; data = { filename, svg, widthMm, heightMm, viewBox, unit, elementCount, layers, exported, dimensions, skipped }
 * @invariant user unit = 1 mm, y flipped (paper is y-down); arcs, ellipses and Béziers are exact path commands; viewBox = drawing extents + margin
 * @failure empty ids / unknown id / non-2D id / id on a tilted plane, an image or with a dangling dimension / no 2D entity -> EXPORT2D_* refusal
 */
export const exportSvg = defineCommand({
  name: 'export_svg',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export 2D drafting entities (all of them, or `ids`) to a self-contained SVG in millimetres (1 user unit = 1 mm, document units converted, ' +
    'viewBox fitted to the drawing plus a margin, y flipped so the drawing is not mirrored). One <g data-layer="name"> per layer whose stroke is ' +
    'the layer colour (black without one; an entity with another colour overrides it). Exact curves: arcs and circles are A path commands, ' +
    'ellipses two half-ellipse A commands, splines cubic Béziers (the exact Catmull-Rom curve), text is <text> (font-size = cap height / 0.72), ' +
    'a hatched region is an even-odd path filled with a <pattern> of parallel (or crossed) lines at its angle and spacing, or solid; dimensions ' +
    'are their extension / dimension lines plus the value text. Entities on a tilted plane and image underlays are skipped with a named warning ' +
    'when `ids` is omitted, and refused when named in `ids`. Returns `data`: { filename, svg (the file text; --save writes it, a .png target ' +
    'rasterizes it), widthMm, heightMm, viewBox [minX, minY, width, height] in mm, unit "mm", elementCount, layers, exported (entity ids), ' +
    'dimensions, skipped: [{ id, kind, reason }] }.',
  params: z.object({
    confirmExportControlled,
    ids: z
      .array(z.string())
      .optional()
      .describe(
        '2D entity ids to export (line, polyline, arc, circle, rectangle, ellipse, spline, point, text, dimension, region). Default: every 2D entity.',
      ),
    marginMm: z.number().min(0).optional().describe('Blank border around the drawing, in mm. Default 5.'),
    lineWeightMm: z.number().positive().optional().describe('Stroke width of every line, in mm. Default 0.25.'),
  }),
  run: (doc, { confirmExportControlled, ids, marginMm = DEFAULT_MARGIN_MM, lineWeightMm = DEFAULT_LINE_WEIGHT_MM }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_svg', 'data', confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const plan = planDraftExport(doc, 'export_svg', ids);
    if (isRefusal(plan)) return plan;
    const drawing = renderDraftSvg(plan.items, { unitMm: MM_PER_UNIT[doc.units], marginMm, lineWeightMm });
    const layers = [...new Set(plan.items.map((item) => item.layerName))];
    const count = plan.entityIds.length;
    return report(
      doc,
      `SVG drawing.svg: ${count} 2D entit${count === 1 ? 'y' : 'ies'} as ${drawing.elementCount} element(s) on ${layers.length} layer(s) (${layers.join(', ')}), ` +
        `${drawing.widthMm.toFixed(3)} x ${drawing.heightMm.toFixed(3)} mm.` +
        (plan.dimensions > 0 ? ` ${plan.dimensions} dimension(s) drawn as lines + text.` : '') +
        skippedNote(plan.skipped),
      {
        filename: 'drawing.svg',
        svg: drawing.svg,
        widthMm: drawing.widthMm,
        heightMm: drawing.heightMm,
        viewBox: drawing.viewBox,
        unit: 'mm',
        elementCount: drawing.elementCount,
        layers,
        exported: plan.entityIds,
        dimensions: plan.dimensions,
        skipped: plan.skipped,
      },
    );
  },
});
