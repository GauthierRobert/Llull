/**
 * render_fea_results plot request (moved out of the command so a host can raster the same plot natively, 05 TR-FEA-92): the params schema,
 * the verified result set, the faces, levels, markers and the `FieldPlotInput`, and the report built from the finished SVG.
 */

import { z } from '@core/commands/schema';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { ProbeQuantity } from '@core/model/analysis';
import { VIEW_DIRECTIONS } from '@core/model/sheet';
import { nodeCoordinates } from './fields';
import { fieldFaces } from './fieldFaces';
import type { FieldPlotInput } from './fieldPlotSvg';
import {
  axisOf,
  cutOf,
  deformationOf,
  extremes,
  fieldSource,
  partSelection,
  plottedNodes,
  PLOT_COMMAND,
  verifiedInputs,
} from './plotRequestInputs';
import { plotRequestOf } from './plotRequestReport';
import { quantityScale } from './probes';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { PROBE_QUANTITIES } from '../commands/probes';

export const NAME = PLOT_COMMAND;
const FIELDS = [...PROBE_QUANTITIES, 'mode'] as const;

/** Params of render_fea_results (and of the host's native fea_render transport). */
export const renderParams = z.object({
  analysisId: analysisIdSchema,
  field: z
    .enum(FIELDS)
    .describe('Field to colour by. Default: temperature for heat_steady / heat_transient, mode for modal / buckling, else von_mises.')
    .optional(),
  mode: z
    .number()
    .int()
    .min(1)
    .describe('modal / buckling only: mode number to plot (1 = lowest frequency / smallest buckling factor). Default 1.')
    .optional(),
  loadCase: z.string().describe('Load case name of a static / thermo-mechanical case. Default: the first load case.').optional(),
  time: z.number().describe('heat_transient: plot the result set nearest this time (s). Default: the last result set.').optional(),
  view: z.enum(VIEW_DIRECTIONS).describe('Viewing direction (orthographic). Default "iso" (from +X, -Y, +Z).').optional(),
  direction: z
    .array(z.number())
    .describe('Custom viewing direction [x, y, z] from the part toward the viewer (overrides view), e.g. [0, -1, 0.3].')
    .optional(),
  deformationScale: z
    .number()
    .min(0)
    .describe('Displacement magnification of the drawn shape; 0 draws the undeformed shape. Default: automatic (structural fields).')
    .optional(),
  range: z
    .tuple([z.number(), z.number()])
    .describe(
      'Fixed colour range [min, max] (e.g. [0, 250] MPa) to compare plots; values outside fall in the end bands. Default: data range.',
    )
    .optional(),
  bands: z.number().int().min(2).max(24).describe('Number of colour bands (2-24). Default 12.').optional(),
  showMesh: z.boolean().describe('Draw the element edges of the skin. Default false.').optional(),
  zoom: z
    .number()
    .min(1)
    .max(50)
    .describe('Magnification (1-50) about `target` to inspect a detail such as a hole edge. Default 1.')
    .optional(),
  target: z
    .tuple([z.number(), z.number(), z.number()])
    .describe('Point [x, y, z] (analysis length unit, as data.max.at) kept at the centre when zoomed. Default: the part centre.')
    .optional(),
  entityIds: z
    .array(z.string())
    .min(1)
    .describe('Plot only these parts (entity ids of the analysis; the other parts are hidden). Default: every meshed part.')
    .optional(),
  cut: z
    .object({
      normal: z
        .tuple([z.number(), z.number(), z.number()])
        .describe('Plane normal [x, y, z] (any non-zero length); the side it points to is removed.'),
      offset: z
        .number()
        .describe('Plane position: points with dot(unit normal, p) > offset are removed. Analysis length unit, undeformed mesh.'),
    })
    .describe('One section plane, e.g. { normal: [0, 1, 0], offset: 0 } keeps y <= 0 and shows the field on the cut face.')
    .optional(),
  axisPoint: z
    .tuple([z.number(), z.number(), z.number()])
    .describe(
      's_hoop / s_radial / s_axial / u_radial: a point [x, y, z] (analysis length unit) on the axis. Default: centre of the plotted bounding box.',
    )
    .optional(),
  axisDirection: z
    .tuple([z.number(), z.number(), z.number()])
    .describe('s_hoop / s_radial / s_axial / u_radial: axis direction [x, y, z] (any non-zero length). Default [0, 0, 1].')
    .optional(),
  surface: z
    .boolean()
    .describe(
      'Also return data.surface { positions, values, triangles, truncated }: the plotted triangles as flat xyz per corner (deformed, in DOCUMENT units) with one field value per corner, so a viewer can paint the contour on the model. Capped at 150000 corners. Default false.',
    )
    .optional(),
  width: z.number().int().min(320).max(2000).describe('Image width in pixels (320-2000). Default 960.').optional(),
  height: z.number().int().min(240).max(2000).describe('Image height in pixels (240-2000). Default 640.').optional(),
});

export type RenderParams = z.output<typeof renderParams>;

export interface PlotRequest {
  readonly plot: FieldPlotInput;
  /** The command result for the finished plot SVG. */
  readonly finish: (svg: string, facesDrawn: number) => CommandResult;
}

/**
 * The plot of `params`, or the refusal.
 * @failure the FEA_* codes of render_fea_results (unchanged doc)
 */
export function fieldPlotRequest(doc: CadDocument, params: RenderParams, ctx: ExecutionContext | undefined): PlotRequest | CommandResult {
  const found = caseOf(doc, params.analysisId);
  if (found === undefined) return refuseFe(doc, NAME, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${params.analysisId}'`, [params.analysisId]);
  const verified = verifiedInputs(doc, params, found, trustedRecord(doc, found, ctx?.feaArtifacts));
  if (!verified.ok) return verified.result;
  const { analysis, mesh, selected, quantity } = verified.value;
  const source = fieldSource(doc, params.analysisId, quantity, selected);
  if (!source.ok) return source.result;
  const { cylindrical, values, scalar } = source.value;
  const coordinates = nodeCoordinates(mesh);
  const parts = partSelection(doc, params, mesh, coordinates);
  if (!parts.ok) return parts.result;
  const axisPhase = axisOf(doc, params, parts.value);
  if (!axisPhase.ok) return axisPhase.result;
  const axis = axisPhase.value;
  const cutPhase = cutOf(doc, params);
  if (!cutPhase.ok) return cutPhase.result;
  const cut = cutPhase.value;
  const plotted = plottedNodes(parts.value.partNodes, coordinates, cut);
  const factor = cylindrical || quantity === 'mode' ? 1 : quantityScale(analysis, quantity as ProbeQuantity);
  const value = (node: number): number | undefined => {
    const entry = values[String(node)];
    const at = coordinates.get(node);
    const v = entry === undefined || at === undefined ? Number.NaN : scalar(entry, at, axis) * factor;
    return Number.isFinite(v) ? v : undefined;
  };
  const { scale, maxDisplacement, deformed } = deformationOf(analysis, selected, parts.value, coordinates, params.deformationScale);
  const { min, max } = extremes(plotted, value);
  const faces =
    min === null || max === null ? [] : fieldFaces({ mesh, coordinates, entityIds: parts.value.entityIds, cut, position: deformed, value });
  if (min === null || max === null || faces.length === 0)
    return refuseFe(doc, NAME, 'FEA_FIELD_MISSING', `no plottable ${quantity} values on the solid skin`, [params.analysisId]);
  return plotRequestOf({
    doc,
    params,
    analysis,
    mesh,
    selected,
    quantity,
    cylindrical,
    coordinates,
    axis,
    cut,
    plotted,
    faces,
    min,
    max,
    deformed,
    scale,
    maxDisplacement,
  });
}
