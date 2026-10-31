/** The footprint preview of emboss_on_face: where the sketch lands on the face and how the chart stretches it, as world polylines (03 WRP, spec §14.17), from the same checks the real command runs and nothing built. */

import type { CadDocument, Vec3 } from '../../model/types';
import type { FaceChart } from '../../geometry/chartFrame';
import type { PlaneSegment } from '../../geometry/planeSegments';
import { sampleSegment } from '../../geometry/planeSegments';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { distortionData } from './distortion';

/** Points kept per loop (a loop is thinned evenly above it): a drawing, not an export. */
const MAX_LOOP_POINTS = 600;
const SAMPLES_PER_PIECE = 17;

export interface EmbossPreviewInput {
  readonly chart: FaceChart;
  readonly pieces: readonly (readonly PlaneSegment[])[];
  readonly holeFlags: readonly boolean[];
  readonly mode: string;
  readonly depth: number;
  readonly distortion: Parameters<typeof distortionData>[0];
  readonly requestedMethod: string;
  readonly limit: number;
  readonly limitDefaulted: boolean;
  readonly expectedVolumeDelta: number | null;
  readonly regionArea: number | null;
  readonly faceKind: string;
  readonly face: number;
  readonly anchor: Vec3;
  /** The direction the relief is lifted along at the anchor (outward for an emboss, into the material for a deboss is the sign of the normal: this is the face normal). */
  readonly normal: Vec3;
  readonly instances: number;
}

/** The polyline of a loop of (u, v) pieces on the face, in world coordinates, closed (first point repeated) and thinned to MAX_LOOP_POINTS. */
function worldLoop(chart: FaceChart, pieces: readonly PlaneSegment[]): Vec3[] {
  const raw = pieces.flatMap((piece, k) => sampleSegment(piece, SAMPLES_PER_PIECE).slice(k === 0 ? 0 : 1)).map((uv) => chart.pointAt(uv));
  const step = Math.max(1, Math.ceil(raw.length / MAX_LOOP_POINTS));
  const kept = raw.filter((_, k) => k % step === 0 || k === raw.length - 1);
  const first = kept[0];
  const last = kept[kept.length - 1];
  return first !== undefined && last !== undefined && (first[0] !== last[0] || first[1] !== last[1] || first[2] !== last[2])
    ? [...kept, first]
    : kept;
}

/** The read-only answer of a preview: nothing is stored. */
export function embossPreviewResult(doc: CadDocument, command: string, input: EmbossPreviewInput): CommandResult {
  const footprint = input.pieces.map((pieces, index) => ({
    hole: input.holeFlags[index] === true,
    points: worldLoop(input.chart, pieces),
  }));
  const data = {
    footprint,
    mode: input.mode,
    depth: input.depth,
    faceKind: input.faceKind,
    face: input.face,
    method: input.chart.method,
    anchor: input.anchor,
    normal: input.normal,
    instances: input.instances,
    expectedVolumeDelta: input.expectedVolumeDelta,
    regionArea: input.regionArea,
    distortion: distortionData(input.distortion, input.chart, input.requestedMethod, input.limit, input.limitDefaulted),
    unit: doc.units,
  };
  const strain = input.distortion.maxLengthStrain;
  return report(
    doc,
    `${command}: the ${input.mode} would land on face ${input.face} (${input.faceKind}, ${input.chart.method} chart) as ${footprint.length} loop(s)${input.instances > 1 ? ` x ${input.instances} instances` : ''}, max length strain ${(100 * strain).toPrecision(3)} %${input.expectedVolumeDelta === null ? '' : `, volume ${input.expectedVolumeDelta >= 0 ? '+' : ''}${input.expectedVolumeDelta.toPrecision(6)} ${doc.units}^3 (closed form)`}; nothing is changed.`,
    data,
  );
}
