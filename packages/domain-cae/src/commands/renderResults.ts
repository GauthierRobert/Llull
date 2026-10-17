/** render_fea_results: read-only contour plot of a solved analysis (stress, displacement, temperature, heat flux) as an SVG image. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { ProbeQuantity } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { VIEW_DIRECTIONS } from '@core/model/sheet';
import { bandLevels } from '@lib/isoBands';
import { significantNumber } from '@lib/compactNumber';
import { lengthUnitName } from '../decks/units';
import { axisFrame, CYLINDRICAL_FIELDS, CYLINDRICAL_QUANTITIES, type CylindricalQuantity } from '../results/cylindrical';
import { magnitude, nodeCoordinates } from '../results/fields';
import { fieldFaces, type CutPlane } from '../results/fieldFaces';
import { fieldPlotSvg, type PlotExtreme } from '../results/fieldPlotSvg';
import { frameOf, isHeat, markersOf, selectStep } from '../results/plotSetup';
import { QUANTITY_FIELDS, quantityScale, quantityUnit } from '../results/probes';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { refuse } from '../shared/refuse';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { QUANTITIES } from './probes';

const NAME = 'render_fea_results';
/** Auto deformation: the largest displacement is drawn at this fraction of the model size. */
const AUTO_DEFORMATION = 0.08;
const FIELDS = [...QUANTITIES, ...CYLINDRICAL_QUANTITIES] as const;

const isSteady = (type: string): boolean => type === 'heat_steady';

function invalid(doc: Parameters<typeof refuse>[0], message: string, path: string): CommandResult {
  return refuse(doc, NAME, 'FEA_PLOT_INVALID', message, 'fix the parameter named in the message and render again', [], [path]);
}

function nearestNode(coordinates: ReadonlyMap<number, Vec3>, point: Vec3): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [node, at] of coordinates) {
    const distance = Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]);
    if (distance < bestDistance) [best, bestDistance] = [node, distance];
  }
  return best;
}

interface NodeExtreme {
  readonly value: number;
  readonly node: number;
}

function extremes(
  nodes: Iterable<number>,
  value: (node: number) => number | undefined,
): { min: NodeExtreme | null; max: NodeExtreme | null } {
  let min: NodeExtreme | null = null;
  let max: NodeExtreme | null = null;
  for (const node of nodes) {
    const v = value(node);
    if (v === undefined) continue;
    if (min === null || v < min.value) min = { value: v, node };
    if (max === null || v > max.value) max = { value: v, node };
  }
  return { min, max };
}

const placedAt = (extreme: NodeExtreme, at: (node: number) => Vec3 | undefined): PlotExtreme | null => {
  const point = at(extreme.node);
  return point === undefined ? null : { value: extreme.value, at: point };
};

/**
 * @invariant read-only; values come from the verified results artifact (trustedRecord), never from the recorded summary; the plot is a
 *   z-buffered raster (nearest face per pixel, value interpolated per pixel) of the outer skin of the plotted parts, deformed by
 *   DISP × deformationScale (auto: the largest displacement drawn at 8 % of the model size); `cut` removes the half-space on the normal's
 *   side of the undeformed mesh and paints the section of every crossed tet; min / max are over the plotted (kept) nodes
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not solved / artifacts unavailable -> FEA_RESULTS_MISSING; field absent -> FEA_FIELD_MISSING;
 *   unknown entityId, zero cut normal / axis direction -> FEA_PLOT_INVALID
 */
export const renderFeaResults = defineCommand({
  name: NAME,
  description:
    'Render the solved results of an analysis as a contour plot an engineer (or you) can LOOK at: an SVG image (embedded z-buffered raster, ' +
    'parts hide each other correctly) of the outer skin of the meshed parts coloured by a field in 12 crisp bands (blue = low, red = high) ' +
    'with a colour legend in the analysis units, the MAX / MIN locations, supports (cyan dots), loads (magenta dots + arrow) and thermal ' +
    'BCs (orange dots; dots are drawn only where visible), on the deformed shape (structural fields; the scale is printed in the ' +
    'subtitle) over a faint silhouette of the undeformed part. field: von_mises (default for static / thermo-mechanical), u_mag, u_x, ' +
    'u_y, u_z, s_xx, s_yy, s_zz, temperature (default for heat_*), heat_flux, and cylindrical components about an axis (axisPoint + ' +
    'axisDirection, default: the z axis through the centre of the plotted parts bounding box; a quarter / half model needs the real axis ' +
    'point): s_hoop, s_radial, s_axial, u_radial. To see an interior peak (e.g. under a PCB): cut = { normal, offset } removes the ' +
    'half-space dot(normal, p) > offset of the undeformed model and colours the section face by the field; entityIds plots only those ' +
    'parts (min / max and the colour range then refer to the plotted parts). Returns data { svg, field, unit, resultSet, min { value, ' +
    'at }, max { value, at }, deformationScale, levels, trianglesDrawn, entityIds, cut, axis }; save it as PNG with the CLI (--save ' +
    'plot.png). Requires a solved analysis on this machine (fea_mesh then fea_solve). Positions are in the analysis length unit.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    field: z.enum(FIELDS).describe('Field to colour by. Default: temperature for heat_steady / heat_transient, else von_mises.').optional(),
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
    width: z.number().int().min(320).max(2000).describe('Image width in pixels (320-2000). Default 960.').optional(),
    height: z.number().int().min(240).max(2000).describe('Image height in pixels (240-2000). Default 640.').optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId } = params;
    const analysis = caseOf(doc, analysisId);
    if (analysis === undefined) return refuseFe(doc, NAME, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    const { meshArtifact: mesh, resultsArtifact: results } = trust;
    if (mesh === null || results === null)
      return refuseFe(
        doc,
        NAME,
        'FEA_RESULTS_MISSING',
        `analysis '${analysisId}' has no verified results (state ${trust.state}${trust.problem === null ? '' : `: ${trust.problem.message}`})`,
        [analysisId],
      );
    const selected = selectStep(analysis, results, params.loadCase, params.time);
    if (typeof selected === 'string') return refuseFe(doc, NAME, 'FEA_RESULTS_MISSING', selected, [analysisId]);
    const quantity: (typeof FIELDS)[number] = params.field ?? (isHeat(analysis) ? 'temperature' : 'von_mises');
    const cylindrical = (CYLINDRICAL_QUANTITIES as readonly string[]).includes(quantity);
    const { field, scalar } = cylindrical
      ? CYLINDRICAL_FIELDS[quantity as CylindricalQuantity]
      : QUANTITY_FIELDS[quantity as ProbeQuantity];
    const values = selected.step.fields[field]?.values;
    if (values === undefined)
      return refuseFe(doc, NAME, 'FEA_FIELD_MISSING', `the ${selected.label} result set has no ${field} field for ${quantity}`, [
        analysisId,
      ]);
    const coordinates = nodeCoordinates(mesh);
    const meshEntities = [...new Set(mesh.blocks.map((block) => block.entityId))];
    const unknown = (params.entityIds ?? []).filter((id) => !meshEntities.includes(id));
    if (unknown.length > 0)
      return refuseFe(doc, NAME, 'FEA_PART_INVALID', `no meshed part ${unknown.join(', ')} (meshed parts: ${meshEntities.join(', ')})`, [
        analysisId,
      ]);
    const entityIds = params.entityIds === undefined ? null : new Set(params.entityIds);
    const partNodes = new Set<number>();
    for (const block of mesh.blocks)
      if (entityIds === null || entityIds.has(block.entityId))
        for (const element of block.elements) for (const node of element.slice(1)) partNodes.add(node);
    const boxMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const boxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const node of partNodes) {
      const at = coordinates.get(node);
      if (at !== undefined)
        for (const axis of [0, 1, 2] as const)
          [boxMin[axis], boxMax[axis]] = [Math.min(boxMin[axis], at[axis]), Math.max(boxMax[axis], at[axis])];
    }
    const size = Math.hypot(boxMax[0] - boxMin[0], boxMax[1] - boxMin[1], boxMax[2] - boxMin[2]);
    const axis = axisFrame(
      params.axisPoint ?? [(boxMin[0] + boxMax[0]) / 2, (boxMin[1] + boxMax[1]) / 2, (boxMin[2] + boxMax[2]) / 2],
      params.axisDirection ?? [0, 0, 1],
    );
    if (axis === null) return invalid(doc, 'axisDirection must be a non-zero vector', 'axisDirection');
    let cut: CutPlane | null = null;
    if (params.cut !== undefined) {
      const [nx, ny, nz] = params.cut.normal;
      const length = Math.hypot(nx, ny, nz);
      if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(params.cut.offset))
        return invalid(doc, 'cut.normal must be a finite non-zero vector and cut.offset a finite number', 'cut');
      cut = { normal: [nx / length, ny / length, nz / length], offset: params.cut.offset };
    }
    const kept = (node: number): boolean => {
      const at = coordinates.get(node);
      return at !== undefined && (cut === null || cut.normal[0] * at[0] + cut.normal[1] * at[1] + cut.normal[2] * at[2] <= cut.offset);
    };
    const plotted = new Set([...partNodes].filter(kept));
    const factor = cylindrical ? 1 : quantityScale(analysis, quantity as ProbeQuantity);
    const value = (node: number): number | undefined => {
      const entry = values[String(node)];
      const at = coordinates.get(node);
      const v = entry === undefined || at === undefined ? Number.NaN : scalar(entry, at, axis) * factor;
      return Number.isFinite(v) ? v : undefined;
    };
    const displacement = isHeat(analysis) ? undefined : selected.step.fields['DISP']?.values;
    let maxDisplacement = 0;
    for (const node of partNodes) maxDisplacement = Math.max(maxDisplacement, magnitude(displacement?.[String(node)] ?? []));
    const scale =
      params.deformationScale ?? (maxDisplacement > 0 ? Number(significantNumber((AUTO_DEFORMATION * size) / maxDisplacement, 2)) : 0);
    const deformed = (node: number): Vec3 | undefined => {
      const at = coordinates.get(node);
      if (at === undefined) return undefined;
      const [ux = 0, uy = 0, uz = 0] = displacement?.[String(node)] ?? [];
      return [at[0] + scale * ux, at[1] + scale * uy, at[2] + scale * uz];
    };
    const { min, max } = extremes(plotted, value);
    const faces = min === null || max === null ? [] : fieldFaces({ mesh, coordinates, entityIds, cut, position: deformed, value });
    if (min === null || max === null || faces.length === 0)
      return refuseFe(doc, NAME, 'FEA_FIELD_MISSING', `no plottable ${quantity} values on the solid skin`, [analysisId]);
    const [low, high] = params.range ?? [min.value, max.value];
    const levels = bandLevels(Math.min(low, high), Math.max(low, high), params.bands ?? 12);
    const unit = quantityUnit(analysis, quantity === 'u_radial' ? 'u_x' : cylindrical ? 's_xx' : (quantity as ProbeQuantity));
    const lengthUnit = lengthUnitName(analysis.unitSystem);
    const round = (p: readonly number[]): Vec3 => [
      Number(significantNumber(p[0] ?? 0, 6)),
      Number(significantNumber(p[1] ?? 0, 6)),
      Number(significantNumber(p[2] ?? 0, 6)),
    ];
    const deformationText =
      scale > 0
        ? `deformation ×${significantNumber(scale, 3)} (max |u| ${significantNumber(maxDisplacement, 4)} ${lengthUnit})`
        : 'undeformed';
    const axisText = cylindrical ? `axis [${round(axis.direction).join(', ')}] through [${round(axis.point).join(', ')}]` : '';
    const sectionText = cut === null ? '' : `cut ${round(cut.normal).join(', ')} · p <= ${significantNumber(cut.offset, 6)}`;
    const partsText = params.entityIds === undefined ? '' : `parts ${params.entityIds.join(', ')}`;
    const notes = [deformationText, axisText, sectionText, partsText].filter((text) => text !== '').join('; ');
    const visibleNode = (node: number): Vec3 | undefined => (plotted.has(node) ? deformed(node) : undefined);
    const { svg, facesDrawn } = fieldPlotSvg({
      title: `${analysis.name} — ${quantity} [${unit}]`,
      subtitle: `${analysis.type}, ${selected.label}, ${notes}; min ${significantNumber(min.value, 4)}, max ${significantNumber(max.value, 4)} ${unit}`,
      frame: frameOf(params.view ?? 'iso', params.direction),
      width: params.width ?? 960,
      height: params.height ?? 640,
      faces,
      levels,
      unit,
      ghost: scale > 0,
      showMesh: params.showMesh ?? false,
      zoom: params.zoom ?? 1,
      focus: params.target === undefined ? null : (deformed(nearestNode(coordinates, params.target)) ?? params.target),
      markers: markersOf(analysis, mesh, visibleNode),
      min: placedAt(min, deformed),
      max: placedAt(max, deformed),
    });
    const origin = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
    return report(
      doc,
      `${NAME}: '${analysisId}' ${quantity} (${selected.label}) — min ${significantNumber(min.value, 4)} ${unit}, max ${significantNumber(max.value, 4)} ${unit} at [${round(origin(max.node)).join(', ')}] ${lengthUnit}; ${notes}; ${facesDrawn} faces drawn.`,
      {
        svg,
        field: quantity,
        unit,
        lengthUnit,
        resultSet: { step: selected.step.step, time: isSteady(analysis.type) ? 0 : selected.step.time, label: selected.label },
        min: { value: min.value, at: round(origin(min.node)), nodeId: min.node },
        max: { value: max.value, at: round(origin(max.node)), nodeId: max.node },
        deformationScale: scale,
        maxDisplacement,
        levels,
        trianglesDrawn: facesDrawn,
        entityIds: params.entityIds ?? null,
        cut: cut === null ? null : { normal: round(cut.normal), offset: cut.offset },
        axis: cylindrical ? { point: round(axis.point), direction: round(axis.direction) } : null,
      },
    );
  },
});
