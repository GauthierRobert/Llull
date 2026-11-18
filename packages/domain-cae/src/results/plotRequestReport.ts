/** render_fea_results output phases: colour levels, unit and notes, the `FieldPlotInput`, and the report built from the finished SVG. */

import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { AnalysisCase, FeMeshArtifact, ProbeQuantity } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import type { VIEW_DIRECTIONS } from '@core/model/sheet';
import { toMetres } from '@core/model/units';
import { bandLevels } from '@lib/isoBands';
import { significantNumber } from '@lib/compactNumber';
import { lengthUnitName } from '../decks/units';
import type { AxisFrame } from './cylindrical';
import type { CutPlane, FieldFace } from './fieldFaces';
import { surfacePayload, SURFACE_CORNER_BUDGET } from './surfacePayload';
import type { FieldPlotInput, PlotExtreme } from './fieldPlotSvg';
import { frameOf, isEigen, markersOf, type Selected } from './plotSetup';
import { quantityUnit } from './probes';
import { PLOT_COMMAND, type NodeExtreme, type PlotField } from './plotRequestInputs';

const isSteady = (type: string): boolean => type === 'heat_steady';

function nearestNode(coordinates: ReadonlyMap<number, Vec3>, point: Vec3): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [node, at] of coordinates) {
    const distance = Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]);
    if (distance < bestDistance) [best, bestDistance] = [node, distance];
  }
  return best;
}

const placedAt = (extreme: NodeExtreme, at: (node: number) => Vec3 | undefined): PlotExtreme | null => {
  const point = at(extreme.node);
  return point === undefined ? null : { value: extreme.value, at: point };
};

const round = (p: readonly number[]): Vec3 => [
  Number(significantNumber(p[0] ?? 0, 6)),
  Number(significantNumber(p[1] ?? 0, 6)),
  Number(significantNumber(p[2] ?? 0, 6)),
];

/** The params the plot and its report read. */
interface ReportParams {
  readonly analysisId: string;
  readonly entityIds?: string[] | undefined;
  readonly view?: (typeof VIEW_DIRECTIONS)[number] | undefined;
  readonly direction?: number[] | undefined;
  readonly range?: [number, number] | undefined;
  readonly bands?: number | undefined;
  readonly showMesh?: boolean | undefined;
  readonly zoom?: number | undefined;
  readonly target?: [number, number, number] | undefined;
  readonly surface?: boolean | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

/** Everything the earlier phases settled, for the plot and its report. */
export interface PlotAssembly {
  readonly doc: CadDocument;
  readonly params: ReportParams;
  readonly analysis: AnalysisCase;
  readonly mesh: FeMeshArtifact;
  readonly selected: Selected;
  readonly quantity: PlotField;
  readonly cylindrical: boolean;
  readonly coordinates: ReadonlyMap<number, Vec3>;
  readonly axis: AxisFrame;
  readonly cut: CutPlane | null;
  readonly plotted: ReadonlySet<number>;
  readonly faces: readonly FieldFace[];
  readonly min: NodeExtreme;
  readonly max: NodeExtreme;
  readonly deformed: (node: number) => Vec3 | undefined;
  readonly scale: number;
  readonly maxDisplacement: number;
}

function unitOf(a: PlotAssembly): string {
  const { analysis, quantity, cylindrical } = a;
  return quantity === 'mode'
    ? 'normalised |u|'
    : quantityUnit(analysis, quantity === 'u_radial' ? 'u_x' : cylindrical ? 's_xx' : (quantity as ProbeQuantity));
}

function notesOf(a: PlotAssembly, lengthUnit: string): string {
  const { params, analysis, cylindrical, axis, cut, scale, maxDisplacement } = a;
  const deformationText =
    scale > 0
      ? isEigen(analysis)
        ? `mode shape drawn ×${significantNumber(scale, 3)} (amplitude arbitrary)`
        : `deformation ×${significantNumber(scale, 3)} (max |u| ${significantNumber(maxDisplacement, 4)} ${lengthUnit})`
      : 'undeformed';
  const axisText = cylindrical ? `axis [${round(axis.direction).join(', ')}] through [${round(axis.point).join(', ')}]` : '';
  const sectionText = cut === null ? '' : `cut ${round(cut.normal).join(', ')} · p <= ${significantNumber(cut.offset, 6)}`;
  const partsText = params.entityIds === undefined ? '' : `parts ${params.entityIds.join(', ')}`;
  return [deformationText, axisText, sectionText, partsText].filter((text) => text !== '').join('; ');
}

function plotOf(a: PlotAssembly, levels: readonly number[], unit: string, notes: string): FieldPlotInput {
  const { params, analysis, mesh, selected, quantity, coordinates, plotted, faces, min, max, deformed, scale } = a;
  const visibleNode = (node: number): Vec3 | undefined => (plotted.has(node) ? deformed(node) : undefined);
  return {
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
  };
}

function reportOf(
  a: PlotAssembly,
  levels: readonly number[],
  unit: string,
  lengthUnit: string,
  notes: string,
  svg: string,
  facesDrawn: number,
): CommandResult {
  const { doc, params, analysis, selected, quantity, cylindrical, coordinates, axis, cut, faces, min, max, scale, maxDisplacement } = a;
  const surface = params.surface === true ? surfacePayload(faces, analysis.unitSystem, toMetres(doc, 1), SURFACE_CORNER_BUDGET) : undefined;
  const origin = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
  return report(
    doc,
    `${PLOT_COMMAND}: '${params.analysisId}' ${quantity} (${selected.label}) — min ${significantNumber(min.value, 4)} ${unit}, max ${significantNumber(max.value, 4)} ${unit} at [${round(origin(max.node)).join(', ')}] ${lengthUnit}; ${notes}; ${facesDrawn} faces drawn.`,
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
      ...(surface === undefined ? {} : { surface }),
    },
  );
}

/** The plot input and the function that turns the finished SVG into the command result. */
export function plotRequestOf(a: PlotAssembly): {
  readonly plot: FieldPlotInput;
  readonly finish: (svg: string, facesDrawn: number) => CommandResult;
} {
  const [low, high] = a.params.range ?? [a.min.value, a.max.value];
  const levels = bandLevels(Math.min(low, high), Math.max(low, high), a.params.bands ?? 12);
  const unit = unitOf(a);
  const lengthUnit = lengthUnitName(a.analysis.unitSystem);
  const notes = notesOf(a, lengthUnit);
  return {
    plot: plotOf(a, levels, unit, notes),
    finish: (svg, facesDrawn) => reportOf(a, levels, unit, lengthUnit, notes, svg, facesDrawn),
  };
}
