// Support reaction arrows of the stress overlay: one arrow per support node, its tip on the node, pointing along the force the support
// applies to the pipe, its length scaled by the force magnitude (the largest force gets the longest arrow). Pure.

import type { Vec3 } from '@core/model/types';
import { segmentPose, type SegmentPose } from './segmentPose';
import type { StressView } from './stressView';

/** Longest arrow as a share of the model's bounding diagonal, never shorter than this many outside diameters. */
const MAX_LENGTH_OF_DIAGONAL = 0.08;
const MIN_OD_MULTIPLE = 3;
/** The smallest arrow, as a share of the longest. */
const MIN_LENGTH_SHARE = 0.25;
const HEAD_SHARE = 0.35;
const HEAD_RADIUS_SHARE = 0.09;
const SHAFT_RADIUS_SHARE = 0.035;
/** Forces below this share of the largest are not drawn. */
const NEGLIGIBLE_SHARE = 1e-6;

export interface ReactionArrow {
  readonly nodeId: string;
  readonly forceN: Vec3;
  readonly magnitudeN: number;
  /** Shaft cylinder, document units. */
  readonly shaft: SegmentPose;
  /** Head cone, document units. */
  readonly head: SegmentPose;
  /** Head base radius, document units. */
  readonly headRadius: number;
  /** Shaft radius, document units. */
  readonly shaftRadius: number;
}

const magnitude = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

/** Per support node, the force of `caseName` (the largest over all cases when null). */
function nodeForces(view: StressView, caseName: string | null): Map<string, Vec3> {
  const forces = new Map<string, Vec3>();
  for (const reaction of view.reactions) {
    if (caseName !== null && reaction.case !== caseName) continue;
    const known = forces.get(reaction.nodeId);
    if (known === undefined || magnitude(reaction.forceN) > magnitude(known)) forces.set(reaction.nodeId, reaction.forceN);
  }
  return forces;
}

function longestArrowMm(view: StressView): number {
  const points = [...(view.geometry?.nodes.values() ?? [])];
  if (points.length === 0) return 0;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const zs = points.map((p) => p[2]);
  const span = (values: number[]): number => Math.max(...values) - Math.min(...values);
  const maxOd = Math.max(0, ...(view.geometry?.elements.map((element) => element.odMm) ?? []));
  return Math.max(MAX_LENGTH_OF_DIAGONAL * Math.hypot(span(xs), span(ys), span(zs)), MIN_OD_MULTIPLE * maxOd);
}

/** Arrows at the undeformed node positions of the nodes that carry a reaction; nothing without geometry or reactions. */
export function reactionArrows(view: StressView, caseName: string | null, mmPerUnit: number): ReactionArrow[] {
  const nodes = view.geometry?.nodes;
  const forces = nodeForces(view, caseName);
  const largest = Math.max(0, ...[...forces.values()].map(magnitude));
  const longest = longestArrowMm(view) / mmPerUnit;
  if (nodes === undefined || largest === 0 || longest === 0) return [];
  return [...forces].flatMap(([nodeId, force]): ReactionArrow[] => {
    const at = nodes.get(nodeId);
    const mag = magnitude(force);
    if (at === undefined || mag < largest * NEGLIGIBLE_SHARE) return [];
    const length = longest * (MIN_LENGTH_SHARE + (1 - MIN_LENGTH_SHARE) * (mag / largest));
    const dir: Vec3 = [force[0] / mag, force[1] / mag, force[2] / mag];
    const tip: Vec3 = [at[0] / mmPerUnit, at[1] / mmPerUnit, at[2] / mmPerUnit];
    const back = (distance: number): Vec3 => [tip[0] - dir[0] * distance, tip[1] - dir[1] * distance, tip[2] - dir[2] * distance];
    const headLength = length * HEAD_SHARE;
    const shaft = segmentPose(back(length), back(headLength));
    const head = segmentPose(back(headLength), tip);
    return shaft === null || head === null
      ? []
      : [
          {
            nodeId,
            forceN: force,
            magnitudeN: mag,
            shaft,
            head,
            headRadius: length * HEAD_RADIUS_SHARE,
            shaftRadius: length * SHAFT_RADIUS_SHARE,
          },
        ];
  });
}
