/** render_fea_results: read-only contour plot of a solved analysis (stress, displacement, temperature, heat flux) as an SVG image. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ProbeQuantity } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { VIEW_DIRECTIONS } from '@core/model/sheet';
import { directionFrame } from '@core/geometry/viewDirections';
import type { ViewFrame } from '@core/geometry/viewProjection';
import { bandLevels } from '@lib/isoBands';
import { significantNumber } from '@lib/compactNumber';
import { loadCasesOf } from '../decks/context';
import { lengthUnitName } from '../decks/units';
import { magnitude, nodeCoordinates, stepOfLoadCase, type ResultStep } from '../results/fields';
import { fieldPlotSvg, type PlotExtreme, type PlotMarker } from '../results/fieldPlotSvg';
import { meshSkin } from '../results/fieldSurface';
import { QUANTITY_FIELDS, quantityScale, quantityUnit } from '../results/probes';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { faceNodes, indexMesh } from '../thermal/meshGeometry';
import { QUANTITIES } from './probes';

const NAME = 'render_fea_results';
/** Auto deformation: the largest displacement is drawn at this fraction of the model size. */
const AUTO_DEFORMATION = 0.08;

/** Marker colour per thermal BC kind (film / radiation / prescribed temperature / flux read apart). */
const BC_COLORS: Readonly<Record<string, string>> = {
  film: '#ffb74d',
  radiation: '#ce93d8',
  temperature: '#ff5252',
  surface_flux: '#fff176',
  concentrated_flux: '#fff176',
};

const isHeat = (analysis: AnalysisCase): boolean => analysis.type === 'heat_steady' || analysis.type === 'heat_transient';

function frameOf(view: (typeof VIEW_DIRECTIONS)[number], direction: readonly number[] | undefined): ViewFrame {
  const [dx = 0, dy = 0, dz = 0] = direction ?? [];
  const length = Math.hypot(dx, dy, dz);
  if (direction === undefined || !(length > 0)) return directionFrame(view);
  const toViewer: Vec3 = [dx / length, dy / length, dz / length];
  const hint: Vec3 = Math.abs(toViewer[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const rx = hint[1] * toViewer[2] - hint[2] * toViewer[1];
  const ry = hint[2] * toViewer[0] - hint[0] * toViewer[2];
  const rz = hint[0] * toViewer[1] - hint[1] * toViewer[0];
  const rl = Math.hypot(rx, ry, rz);
  const right: Vec3 = [rx / rl, ry / rl, rz / rl];
  const up: Vec3 = [
    toViewer[1] * right[2] - toViewer[2] * right[1],
    toViewer[2] * right[0] - toViewer[0] * right[2],
    toViewer[0] * right[1] - toViewer[1] * right[0],
  ];
  return { toViewer, project: (p) => [p[0] * right[0] + p[1] * right[1] + p[2] * right[2], p[0] * up[0] + p[1] * up[1] + p[2] * up[2]] };
}

interface Selected {
  readonly step: ResultStep;
  readonly label: string;
}

function selectStep(
  analysis: AnalysisCase,
  results: FeResultsArtifact,
  loadCase: string | undefined,
  time: number | undefined,
): Selected | string {
  if (isHeat(analysis)) {
    if (results.steps.length === 0) return 'the results hold no result set';
    const step =
      time === undefined
        ? results.steps.at(-1)
        : results.steps.reduce((best, candidate) => (Math.abs(candidate.time - time) < Math.abs(best.time - time) ? candidate : best));
    return step === undefined ? 'the results hold no result set' : { step, label: `t = ${significantNumber(step.time, 6)} s` };
  }
  const cases = loadCasesOf(analysis);
  const index = loadCase === undefined ? 0 : cases.findIndex((entry) => entry.name === loadCase);
  if (index < 0) return `no load case '${loadCase ?? ''}' (load cases: ${cases.map((entry) => entry.name).join(', ')})`;
  const step = stepOfLoadCase(results, index);
  return step === undefined
    ? `no result set for load case '${cases[index]?.name ?? ''}'`
    : { step, label: `load case ${cases[index]?.name ?? ''}` };
}

function markersOf(analysis: AnalysisCase, mesh: FeMeshArtifact, position: (node: number) => Vec3 | undefined): PlotMarker[] {
  const index = indexMesh(mesh);
  const pointsOf = (key: string): Vec3[] => {
    const nodes = new Set(Object.hasOwn(mesh.nodeSets, key) ? (mesh.nodeSets[key] ?? []) : []);
    for (const [elementId, label] of Object.hasOwn(mesh.faceSets, key) ? (mesh.faceSets[key] ?? []) : []) {
      const element = index.elements.get(elementId);
      for (const node of element === undefined ? [] : (faceNodes(element, label) ?? [])) nodes.add(node);
    }
    return [...nodes].map(position).filter((p) => p !== undefined);
  };
  const markers: PlotMarker[] = [];
  for (const id of analysis.constraintOrder) {
    const constraint = analysis.constraints[id];
    if (constraint !== undefined)
      markers.push({ label: `${constraint.name} (${constraint.kind})`, color: '#4fc3f7', points: pointsOf(`C_${id}`) });
  }
  for (const id of analysis.loadOrder) {
    const load = analysis.loads[id];
    if (load === undefined) continue;
    const arrow = load.kind === 'pressure' || load.vector === undefined ? undefined : load.vector;
    markers.push({
      label: `${load.name} (${load.kind})`,
      color: '#ff4fd8',
      points: pointsOf(`L_${id}`),
      ...(arrow === undefined ? {} : { arrow }),
    });
  }
  for (const id of analysis.thermal?.bcOrder ?? []) {
    const record = analysis.thermal?.bcs[id];
    if (record !== undefined)
      markers.push({
        label: `${record.name} (${record.bc.kind})`,
        color: BC_COLORS[record.bc.kind] ?? '#ffb74d',
        points: pointsOf(`B_${id}`),
      });
  }
  return markers.filter((marker) => marker.points.length > 0);
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
 * @invariant read-only; values come from the verified results artifact (trustedRecord), never from the recorded summary; the plot shows the
 *   outer skin of the solid parts, deformed by DISP × deformationScale (auto: the largest displacement drawn at 8 % of the model size)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not solved / artifacts unavailable -> FEA_RESULTS_MISSING; field absent -> FEA_FIELD_MISSING
 */
export const renderFeaResults = defineCommand({
  name: NAME,
  description:
    'Render the solved results of an analysis as a contour plot an engineer (or you) can LOOK at: an SVG image of the outer skin of the ' +
    'meshed parts coloured by a field in 12 bands (blue = low, red = high) with a colour legend in the analysis units, the MAX / MIN locations, ' +
    'supports (cyan dots), loads (magenta dots + arrow) and thermal BCs (orange dots), on the deformed shape (structural fields; the ' +
    'scale is printed in the subtitle) over a faint silhouette of the undeformed part. field: von_mises (default for static / ' +
    'thermo-mechanical), u_mag, u_x, u_y, u_z, s_xx, s_yy, s_zz, temperature (default for heat_*), heat_flux. Returns data { svg, field, ' +
    'unit, resultSet, min { value, at }, max { value, at }, deformationScale, levels, trianglesDrawn }; save it as PNG with the CLI ' +
    '(--save plot.png). Requires a solved analysis on this machine (fea_mesh then fea_solve). Positions are in the analysis length unit.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    field: z
      .enum(QUANTITIES)
      .describe('Field to colour by. Default: temperature for heat_steady / heat_transient, else von_mises.')
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
    const quantity: ProbeQuantity = params.field ?? (isHeat(analysis) ? 'temperature' : 'von_mises');
    const { field, scalar } = QUANTITY_FIELDS[quantity];
    const values = selected.step.fields[field]?.values;
    if (values === undefined)
      return refuseFe(doc, NAME, 'FEA_FIELD_MISSING', `the ${selected.label} result set has no ${field} field for ${quantity}`, [
        analysisId,
      ]);
    const coordinates = nodeCoordinates(mesh);
    const skin = meshSkin(mesh, coordinates);
    const factor = quantityScale(analysis, quantity);
    const value = (node: number): number | undefined => {
      const entry = values[String(node)];
      const v = entry === undefined ? Number.NaN : scalar(entry) * factor;
      return Number.isFinite(v) ? v : undefined;
    };
    const displacement = isHeat(analysis) ? undefined : selected.step.fields['DISP']?.values;
    let maxDisplacement = 0;
    for (const entry of Object.values(displacement ?? {})) maxDisplacement = Math.max(maxDisplacement, magnitude(entry));
    const boxMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const boxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const at of coordinates.values())
      for (const axis of [0, 1, 2] as const)
        [boxMin[axis], boxMax[axis]] = [Math.min(boxMin[axis], at[axis]), Math.max(boxMax[axis], at[axis])];
    const size = Math.hypot(boxMax[0] - boxMin[0], boxMax[1] - boxMin[1], boxMax[2] - boxMin[2]);
    const scale =
      params.deformationScale ?? (maxDisplacement > 0 ? Number(significantNumber((AUTO_DEFORMATION * size) / maxDisplacement, 2)) : 0);
    const deformed = (node: number): Vec3 | undefined => {
      const at = coordinates.get(node);
      if (at === undefined) return undefined;
      const [ux = 0, uy = 0, uz = 0] = displacement?.[String(node)] ?? [];
      return [at[0] + scale * ux, at[1] + scale * uy, at[2] + scale * uz];
    };
    const { min, max } = extremes(coordinates.keys(), value);
    if (min === null || max === null || skin.length === 0)
      return refuseFe(doc, NAME, 'FEA_FIELD_MISSING', `no plottable ${quantity} values on the solid skin`, [analysisId]);
    const [low, high] = params.range ?? [min.value, max.value];
    const levels = bandLevels(Math.min(low, high), Math.max(low, high), params.bands ?? 12);
    const unit = quantityUnit(analysis, quantity);
    const lengthUnit = lengthUnitName(analysis.unitSystem);
    const deformationText =
      scale > 0
        ? `deformation ×${significantNumber(scale, 3)} (max |u| ${significantNumber(maxDisplacement, 4)} ${lengthUnit})`
        : 'undeformed';
    const { svg, trianglesDrawn } = fieldPlotSvg({
      title: `${analysis.name} — ${quantity} [${unit}]`,
      subtitle: `${analysis.type}, ${selected.label}, ${deformationText}; min ${significantNumber(min.value, 4)}, max ${significantNumber(max.value, 4)} ${unit}`,
      frame: frameOf(params.view ?? 'iso', params.direction),
      width: params.width ?? 960,
      height: params.height ?? 640,
      skin,
      position: deformed,
      value,
      levels,
      unit,
      ghost: scale > 0 ? (node) => coordinates.get(node) : null,
      showMesh: params.showMesh ?? false,
      zoom: params.zoom ?? 1,
      focus: params.target === undefined ? null : (deformed(nearestNode(coordinates, params.target)) ?? params.target),
      markers: markersOf(analysis, mesh, deformed),
      min: placedAt(min, deformed),
      max: placedAt(max, deformed),
    });
    const origin = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
    const round = (p: Vec3): Vec3 => [
      Number(significantNumber(p[0], 6)),
      Number(significantNumber(p[1], 6)),
      Number(significantNumber(p[2], 6)),
    ];
    return report(
      doc,
      `${NAME}: '${analysisId}' ${quantity} (${selected.label}) — min ${significantNumber(min.value, 4)} ${unit}, max ${significantNumber(max.value, 4)} ${unit} at [${round(origin(max.node)).join(', ')}] ${lengthUnit}; ${deformationText}; ${trianglesDrawn} faces drawn.`,
      {
        svg,
        field: quantity,
        unit,
        lengthUnit,
        resultSet: { step: selected.step.step, time: selected.step.time, label: selected.label },
        min: { value: min.value, at: round(origin(min.node)), nodeId: min.node },
        max: { value: max.value, at: round(origin(max.node)), nodeId: max.node },
        deformationScale: scale,
        maxDisplacement,
        levels,
        trianglesDrawn,
      },
    );
  },
});
