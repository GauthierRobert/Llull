// What the stress overlay draws: one tube per finite element of the analysis (building pipes and 02 RTE runs alike), toned by the worst
// station ratio of that element for the chosen case, optionally on the deformed shape. Positions come from the analysis geometry (absolute
// document mm) and are converted to document units here. Pure.

import type { Vec3 } from '@core/model/types';
import { segmentPose, type SegmentPose } from './segmentPose';
import { elementRatios, ratioTone, type RatioTone, type StressRow, type StressView } from './stressView';

/** The painted tube is slightly fatter than the pipe so it reads over the pipe's own shading. */
const RADIUS_FACTOR = 0.62;

export interface PaintedElement {
  readonly id: string;
  readonly pipeId: string;
  readonly tone: RatioTone;
  /** Tube radius in document units. */
  readonly radius: number;
  readonly pose: SegmentPose;
}

const scaled = (v: Vec3, factor: number): Vec3 => [v[0] * factor, v[1] * factor, v[2] * factor];

/**
 * Node positions in mm: the analysis positions, moved by `deformScale` times the node displacement of `caseName` when both are set
 * (the deformed shape; no case or a scale of 0 is the undeformed model).
 */
export function nodePositions(view: StressView, caseName: string | null, deformScale: number): Map<string, Vec3> {
  const positions = new Map<string, Vec3>(view.geometry?.nodes ?? []);
  if (caseName === null || deformScale === 0) return positions;
  for (const displacement of view.displacements) {
    const at = positions.get(displacement.node);
    if (displacement.case === caseName && at !== undefined)
      positions.set(displacement.node, [
        at[0] + displacement.uMm[0] * deformScale,
        at[1] + displacement.uMm[1] * deformScale,
        at[2] + displacement.uMm[2] * deformScale,
      ]);
  }
  return positions;
}

/** Nothing for an answer without geometry. An element without a station of the case (no code check) is `unknown`; a zero-length element is skipped. */
export function paintedElements(view: StressView, caseName: string | null, deformScale: number, mmPerUnit: number): PaintedElement[] {
  if (view.geometry === null) return [];
  const ratios = elementRatios(view.rows, caseName);
  const positions = nodePositions(view, caseName, deformScale);
  return view.geometry.elements.flatMap((element): PaintedElement[] => {
    const a = positions.get(element.nodeIds[0]);
    const b = positions.get(element.nodeIds[1]);
    const pose = a === undefined || b === undefined ? null : segmentPose(scaled(a, 1 / mmPerUnit), scaled(b, 1 / mmPerUnit));
    if (pose === null) return [];
    const ratio = ratios.get(element.id);
    return [
      {
        id: element.id,
        pipeId: element.pipeId,
        tone: ratio === undefined ? 'unknown' : ratioTone(ratio),
        radius: (element.odMm * RADIUS_FACTOR) / mmPerUnit,
        pose,
      },
    ];
  });
}

/** The elements grouped by tone (one instanced mesh per tone). */
export function groupByTone(elements: readonly PaintedElement[]): Record<RatioTone, PaintedElement[]> {
  const groups: Record<RatioTone, PaintedElement[]> = { pass: [], warn: [], fail: [], unknown: [] };
  for (const element of elements) groups[element.tone].push(element);
  return groups;
}

/** The position, in document units, of a station on the undeformed model: at its node, else along the element by `xMm`. Null without geometry. */
export function stationPosition(view: StressView, row: StressRow, mmPerUnit: number): Vec3 | null {
  const element = view.geometry?.elements.find((candidate) => candidate.id === row.element);
  const a = element === undefined ? undefined : view.geometry?.nodes.get(element.nodeIds[0]);
  const b = element === undefined ? undefined : view.geometry?.nodes.get(element.nodeIds[1]);
  if (element === undefined || a === undefined || b === undefined) return null;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const atEnd = row.node === element.nodeIds[1] || length === 0;
  const t = row.node === element.nodeIds[0] ? 0 : atEnd ? 1 : Math.min(1, Math.max(0, row.xMm / length));
  return scaled([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], 1 / mmPerUnit);
}
