/**
 * The crease a setback corner keeps (DES-6c 13.33): at a vertex of exactly three edges where one is left sharp, the corner star continues that edge from its entry point as a crease that leaves
 * at the dihedral angle of the part and fades to nothing at the pole (a design choice: the alternative, a mitre like the rolling ball, would carry a true crease from the entry point to the pole).
 * @invariant pure over the source topology, the planned (rounded) edges and the kernel's continuity samples of the sharp edge
 * @failure a vertex whose edges are not all rounded but one, or a kernel without edge continuity -> that corner is omitted
 */

import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { round6 } from '../../lib/compactNumber';

export interface CornerShape {
  readonly maxCurvature: number;
  readonly maxNormalTurn: number;
  readonly curvatureRatio: number;
}

export interface CornerCrease {
  readonly vertex: Vec3;
  /** Only at a corner that keeps one edge sharp. */
  readonly crease?: { readonly sharpEdge: number; readonly entryRad: number };
  /** The trim builder: how far the corner star stands outside the part (document units), when the kernel measured it. */
  readonly overshoot?: number;
  /** The trim builder: the shape of the corner star (13.41). */
  readonly shape?: CornerShape;
}

const near = (a: Vec3, b: Vec3, tolerance: number): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;

export function creaseOfCorners(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  topology: ShapeTopology | null,
  corners: ReadonlyArray<{ readonly vertex: Vec3; readonly overshoot?: number; readonly shape?: CornerShape }>,
  rounded: readonly number[],
): CornerCrease[] {
  if (topology === null) return [];
  const found: CornerCrease[] = [];
  for (const corner of corners) {
    const meeting = topology.edges.filter((edge) => {
      const tolerance = 1e-7 * Math.max(1, edge.length);
      return near(edge.start, corner.vertex, tolerance) || near(edge.end, corner.vertex, tolerance);
    });
    const sharp = meeting.filter((edge) => !rounded.includes(edge.index));
    const edge = sharp[0];
    const reading = {
      ...(corner.overshoot === undefined ? {} : { overshoot: round6(corner.overshoot) }),
      ...(corner.shape === undefined ? {} : { shape: corner.shape }),
    };
    if (meeting.length !== 3 || sharp.length !== 1 || edge === undefined) {
      if (Object.keys(reading).length > 0) found.push({ vertex: corner.vertex, ...reading });
      continue;
    }
    const samples = kernel.faceQuery?.edgeContinuity(shape, edge.index, 2) ?? null;
    const at =
      samples === null
        ? undefined
        : near(edge.start, corner.vertex, 1e-7 * Math.max(1, edge.length))
          ? samples[0]
          : samples[samples.length - 1];
    if (at === undefined) continue;
    found.push({ vertex: corner.vertex, crease: { sharpEdge: edge.index, entryRad: round6(at.g1Signed ?? at.g1) }, ...reading });
  }
  return found;
}

/** `result` with the creases in its summary and in `data.corners`; every other key of `data` (profile, nonTangent, ...) is kept. */
export function withCreases(result: CommandResult, creases: readonly CornerCrease[]): CommandResult {
  if (creases.length === 0) return result;
  const creased = creases.filter((one) => one.crease !== undefined);
  if (creased.length === 0) return { ...result, data: { ...(result.data as Record<string, unknown> | undefined), corners: creases } };
  return {
    ...result,
    summary: `${result.summary}${creaseText(creased)}`,
    data: { ...(result.data as Record<string, unknown> | undefined), corners: creases },
  };
}

function creaseText(creases: readonly CornerCrease[]): string {
  if (creases.length === 0) return '';
  const each = creases.map((one) => `edge ${one.crease?.sharpEdge} (entry ${one.crease?.entryRad} rad)`).join(', ');
  return ` Sharp edge kept at ${creases.length} corner(s): ${each}; the star continues it as a crease that fades to nothing at the pole.`;
}
