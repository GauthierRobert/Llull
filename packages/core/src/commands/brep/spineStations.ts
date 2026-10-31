/**
 * Where each section of a blend lies along its source edge, for an edge the kernel reports as running at an uneven speed (ShapeEdge.unevenSpeed): the arc
 * fraction of the edge point nearest to the section's mid point (a section lies in the plane normal to the spine). A read that cannot be trusted is a reason, never a guess.
 * @invariant the stations are monotone in section order (a nearest point that jumps back means the radius reached the local radius of curvature of the edge)
 * @invariant a closed edge is unwrapped by continuity from the neighbouring sections, so a section on the seam is neither 0 nor 1 by accident
 */

import { closedEdge } from '../../geometry/blend/law';
import type { GeometryKernel, ShapeEdge } from '../../geometry/kernel';
import type { BlendSection } from '../../geometry/kernelPorts';
import type { ShapeHandle } from '../../geometry/kernelTypes';

/** Samples of the source edge the sections are placed on (the arc fraction of a section is read between two of them). */
const SPINE_SAMPLES = 1001;
/** A step of the stations against the direction of the sweep above this fraction of the edge is a jump of the nearest point, not noise of the polyline. */
const MONOTONE_SLACK = 5e-4;
/** A closed edge's first station within this fraction below an integer is read as just past the seam (a blend that starts on the seam starts at the law's start). */
const SEAM_SLACK = 2e-3;

export interface SpineStations {
  /** Arc fraction of each section (same order as the sections); on a closed edge unwrapped past 1 (or below 0) so that it is continuous along the blend. */
  readonly stations: readonly number[];
  readonly closed: boolean;
}

export interface SpineUnreadable {
  readonly reason: string;
}

export function spineStations(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  edge: number,
  info: ShapeEdge,
  sections: readonly BlendSection[],
): SpineStations | SpineUnreadable {
  const samples = kernel.faceQuery?.edgeSamples?.(shape, edge, SPINE_SAMPLES) ?? null;
  const total = samples?.[samples.length - 1]?.s ?? 0;
  if (samples === null || samples.length < 2 || !(total > 0))
    return {
      reason: `edge ${edge} runs at an uneven speed and the kernel cannot sample it (faceQuery.edgeSamples), so the law cannot be read at the spine position of each section`,
    };
  const point = (k: number, axis: number): number => samples[k]?.point[axis] ?? 0;
  const raw = sections.map((section) => {
    let best = { gap: Number.POSITIVE_INFINITY, s: 0 };
    for (let k = 0; k + 1 < samples.length; k++) {
      const along = [0, 1, 2].map((axis) => point(k + 1, axis) - point(k, axis));
      const toward = [0, 1, 2].map((axis) => (section.mid[axis] ?? 0) - point(k, axis));
      const length2 = along.reduce((sum, value) => sum + value * value, 0);
      const dot = along.reduce((sum, value, axis) => sum + value * (toward[axis] ?? 0), 0);
      const share = length2 > 0 ? Math.min(1, Math.max(0, dot / length2)) : 0;
      const gap = Math.hypot(...along.map((value, axis) => share * value - (toward[axis] ?? 0)));
      if (gap < best.gap) best = { gap, s: (samples[k]?.s ?? 0) + share * ((samples[k + 1]?.s ?? 0) - (samples[k]?.s ?? 0)) };
    }
    return best.s / total;
  });
  const closed = closedEdge(info);
  const unwrapped = closed
    ? raw.reduce<number[]>((out, station, k) => {
        const before = out[k - 1];
        const step = before === undefined ? 0 : station - (raw[k - 1] ?? station);
        out.push(before === undefined ? station : before + step - Math.round(step));
        return out;
      }, [])
    : raw;
  const sweep = (unwrapped[unwrapped.length - 1] ?? 0) - (unwrapped[0] ?? 0);
  const direction = Math.sign(sweep);
  const jump = unwrapped.findIndex((station, k) => k > 0 && (station - (unwrapped[k - 1] ?? station)) * direction < -MONOTONE_SLACK);
  if (direction === 0 || jump >= 0)
    return {
      reason:
        direction === 0
          ? `edge ${edge}: the sections of the blend all project to one point of the edge, so the law cannot be read along it`
          : `edge ${edge}: the nearest edge point jumps backwards between sections ${jump - 1} and ${jump} (the radius approaches the local radius of curvature of the edge), so the law is not read at the spine`,
    };
  const shift = closed ? -Math.floor(Math.min(...unwrapped) + SEAM_SLACK) : 0;
  return { stations: unwrapped.map((station) => station + shift), closed };
}
