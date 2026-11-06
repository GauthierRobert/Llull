/**
 * The `simulation` source of render_animation (FR-MOV-02): ONE simulate_motion run (`detail: 'poses'`, reached through `ctx.registry`), then every
 * frame at its exact instant t_k by pose interpolation (`posesAtTime`) and joint series interpolated linearly at the same instant.
 */

import type { Quaternion, Vec3 } from '../../../model/vectors';
import type { CadDocument } from '../../../model/types';
import { toMetres } from '../../../model/units';
import { documentAtPose, posesAtTime, sampleBracket, type BodyPoseAt } from '../../../geometry/bodyPose';
import type { ExecutionContext } from '../../types';
import { blend, RAD_TO_DEG, XYZ } from './readouts';
import { frameTime } from './timeline';
import {
  own,
  refusal,
  type AnimationTimelineEntry,
  type AnimationWarning,
  type MotionFrames,
  type OverlayIds,
  type ReadoutValue,
  type SourceRefusal,
  type TraceTrack,
} from './types';

/** The recorded-sample cap of simulate_motion (TR-MOV-03). */
const MAX_SAMPLES = 6001;

/** The part of simulate_motion's `data` (detail 'poses') this source reads. */
interface SimulationRun {
  readonly warnings?: readonly string[];
  readonly poses?: { readonly times: number[]; readonly bodies: Record<string, { position: Vec3[]; orientation: Quaternion[] }> };
  readonly series?: { readonly times: number[]; readonly jointPosition: Record<string, number[]> };
}

export interface SimulationSourceInput {
  readonly duration: number;
  readonly timestep?: number | undefined;
  readonly playbackRate: number;
  readonly fps: number;
  readonly frames: number;
}

const idsText = (ids: readonly string[]): string => ids.join(', ');

/** Frames of the simulated mechanism, or the reason there are none. */
export function simulationSource(
  doc: CadDocument,
  input: SimulationSourceInput,
  ids: OverlayIds,
  ctx: ExecutionContext | undefined,
): MotionFrames | SourceRefusal {
  const bodies = doc.dynamics?.bodies ?? {};
  const joints = doc.dynamics?.joints ?? {};
  if (Object.keys(bodies).length === 0)
    return refusal('MOV_NO_MOTION', 'the document has no rigid bodies: add_rigid_body and add_body_joint, or use source clips / sweep');
  const unknownTrace = ids.trace.filter((id) => own(bodies, id) === undefined);
  if (unknownTrace.length > 0) return refusal('MOV_UNKNOWN_ID', `trace: no rigid body ${idsText(unknownTrace)}`, unknownTrace);
  const unknownReadouts = ids.readouts.filter((id) => own(joints, id) === undefined && own(bodies, id) === undefined);
  if (unknownReadouts.length > 0)
    return refusal(
      'MOV_UNKNOWN_ID',
      `readouts: no joint or rigid body ${idsText(unknownReadouts)} (a joint id or a rigid body id)`,
      unknownReadouts,
    );
  const simulate = ctx?.registry('simulate_motion');
  if (simulate === undefined)
    return refusal('MOV_SOURCE_FAILED', 'simulate_motion is not registered (the dynamics plugin is not installed)');
  const cap = (MAX_SAMPLES - 1) / input.duration;
  const sampleRate = Math.min(input.timestep === undefined ? Infinity : 1 / input.timestep, cap);
  const run = simulate.run(
    doc,
    { duration: input.duration, detail: 'poses', sampleRate, ...(input.timestep === undefined ? {} : { timestep: input.timestep }) },
    ctx,
  );
  const data = run.data as SimulationRun | undefined;
  if (data === undefined) return refusal('MOV_SOURCE_FAILED', run.summary);
  const { poses, series } = data;
  if (poses === undefined || series === undefined || poses.times.length === 0)
    return refusal('MOV_SOURCE_FAILED', 'the simulation recorded no poses or joint series');
  const noSeries = ids.readouts.filter((id) => own(joints, id) !== undefined && own(series.jointPosition, id) === undefined);
  if (noSeries.length > 0)
    return refusal('MOV_UNKNOWN_ID', `readouts: joint ${idsText(noSeries)} has no position series (a spherical joint has none)`, noSeries);

  const metresPerUnit = toMetres(doc, 1);
  const times = Array.from({ length: input.frames }, (_, k) => frameTime(k, input.fps, input.playbackRate));
  const framePoses: Record<string, BodyPoseAt>[] = times.map((t) => posesAtTime(poses, t));
  const timeline = times.map((t, k): AnimationTimelineEntry => {
    const bracket = sampleBracket(poses.times, t);
    const readouts: Record<string, ReadoutValue> = {};
    for (const id of ids.readouts) {
      const joint = own(joints, id);
      const track = own(series.jointPosition, id);
      if (joint !== undefined && track !== undefined && bracket !== null) {
        const [a, b] = [track[bracket.before] ?? 0, track[bracket.after] ?? 0];
        const value = blend(a, b, bracket.weight);
        readouts[id] =
          joint.kind === 'prismatic' ? { value: value / metresPerUnit, unit: doc.units } : { value: value * RAD_TO_DEG, unit: 'deg' };
        continue;
      }
      const position = framePoses[k]?.[id]?.position;
      if (position !== undefined) XYZ.forEach((axis, i) => (readouts[`${id}.${axis}`] = { value: position[i] ?? 0, unit: doc.units }));
    }
    return { frame: k, tS: t, ...(bracket === null ? {} : { sample: bracket }), readouts };
  });
  const traces = ids.trace.map((id): TraceTrack => {
    const track = own(poses.bodies, id);
    if (track === undefined) return { id, path: [], at: [] };
    return { id, path: track.position, at: framePoses.map((pose) => pose[id]?.position ?? track.position[0] ?? [0, 0, 0]) };
  });
  const sampleIntervalS = poses.times.length > 1 ? (poses.times[1] ?? 0) - (poses.times[0] ?? 0) : undefined;
  const warnings: AnimationWarning[] = (data.warnings ?? []).map((message) => ({ code: 'MOV_SIMULATION_WARNING', message }));
  const frameInterval = input.playbackRate / input.fps;
  if (sampleIntervalS !== undefined && sampleIntervalS > frameInterval + 1e-12)
    warnings.push({
      code: 'MOV_SAMPLES_SPARSE',
      message: `the simulation sample interval ${sampleIntervalS} s is longer than a frame interval ${frameInterval} s: poses between samples are interpolated; lower timestep or raise fps / lower playbackRate`,
    });
  return {
    documentAt: (frame) => documentAtPose(doc, framePoses[frame] ?? {}),
    timeline,
    traces,
    warnings,
    ...(sampleIntervalS === undefined ? {} : { sampleIntervalS }),
  };
}
