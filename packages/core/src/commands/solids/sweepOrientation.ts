/** Orientation param of `sweep_profile`: zod fields, parsing into the model, and the global overlap check of helical sweeps. */

import type { SweepEntity, Vec2, Vec3 } from '../../model/types';
import type { SweepFrame } from '../../geometry/sweepEval/frames';
import { transformPoint, type SectionTransform } from '../../geometry/sweepEval/laws';
import type { HelixDefinition } from '../../lib/helix/types';
import { lawFunction } from '../../lib/law/evaluate';
import { dot3, isVec3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { sectionLoops } from '../../geometry/sweepEval/sections';
import { z } from '../schema';

export const orientationField = z
  .object({
    mode: z
      .enum(['minimal', 'frenet', 'fixed', 'binormal', 'axis_plane'])
      .describe(
        'minimal (default): twist-free frame, for pipes and anything round; frenet: section follows the curvature normal, only on paths that bend everywhere; fixed: the section keeps its plane (normal = direction), oblique to the path; binormal: the section y axis tracks `direction`; axis_plane: the section lies in the plane through an axis (threads, springs and screws with a non-round section: x = radial, y = along the axis).',
      ),
    direction: z
      .array(z.number())
      .describe(
        '[x, y, z] reference direction: fixed = section plane normal (default [0, 0, 1]); binormal = the direction the section y axis follows (required); axis_plane = the axis direction (default: the axis of a helix path).',
      )
      .optional(),
    axisPoint: z
      .array(z.number())
      .describe('axis_plane only: [x, y, z] world point on the axis (default: the origin of a helix path).')
      .optional(),
  })
  .describe('Orientation of the section along the path; omit for the default minimal (rotation-minimizing) frame.')
  .optional();

export const sectionFrameField = z
  .enum(['path', 'axial'])
  .describe(
    'axis_plane only. "path" (default): section coordinates are offsets from the path point. "axial": x is the radius from the axis and y the axial offset from the path point height, so a thread profile is given where it lies (e.g. [[18,-1.5],[22,-1.5],[22,1.5],[18,1.5]] round a radius-20 helix).',
  )
  .optional();

export interface OrientationInput {
  readonly mode: string;
  readonly direction?: number[] | undefined;
  readonly axisPoint?: number[] | undefined;
}

/** What the orientation needs besides its own params: the path start (sweep-local origin), a helix path's axis, the section frame. */
export interface OrientationContext {
  readonly start: Vec3;
  readonly helix: HelixDefinition | undefined;
  readonly sectionFrame: 'path' | 'axial' | undefined;
}

/** The `orientation` param in the model's shape (axis points moved to sweep-local coordinates), or the reason it is unusable. */
export function parseOrientation(input: OrientationInput | undefined, context: OrientationContext): SweepEntity['orientation'] | string {
  if (input === undefined) return undefined;
  const { direction, axisPoint } = input;
  if (direction !== undefined && (!isVec3(direction) || len3(direction as Vec3) < 1e-9))
    return 'orientation.direction must be a non-zero [x, y, z]';
  if (axisPoint !== undefined && !isVec3(axisPoint)) return 'orientation.axisPoint must be a finite [x, y, z]';
  switch (input.mode) {
    case 'minimal':
      return { mode: 'minimal' };
    case 'frenet':
      return { mode: 'frenet' };
    case 'fixed':
      return direction === undefined ? { mode: 'fixed' } : { mode: 'fixed', direction: direction as Vec3 };
    case 'axis_plane': {
      const axis = (direction as Vec3 | undefined) ?? context.helix?.axis;
      const point = axisPoint === undefined ? context.helix?.origin : sub3(axisPoint as Vec3, context.start);
      if (axis === undefined || point === undefined) return 'orientation axis_plane needs a direction and an axisPoint (or a helix path)';
      return { mode: 'axis_plane', axisPoint: point, direction: axis, sectionFrame: context.sectionFrame ?? 'path' };
    }
    default:
      return direction === undefined ? 'orientation binormal needs a direction' : { mode: 'binormal', direction: direction as Vec3 };
  }
}

/** Smallest pitch of a helix over its turns. */
function leastPitch(helix: HelixDefinition): number {
  if (typeof helix.pitch === 'number') return helix.pitch;
  const f = lawFunction(helix.pitch);
  return Math.min(...Array.from({ length: 257 }, (_, k) => f(k / 256, 1)));
}

const maxScaleOf = (transforms: readonly SectionTransform[] | null): number =>
  transforms === null ? 1 : Math.max(...transforms.map((t) => Math.max(t.sx, t.sy)));

/** The section loop under the transform of frame `i` (as placed). */
function transformedLoop(loop: readonly Vec2[], transforms: readonly SectionTransform[] | null, i: number): Vec2[] {
  const transform = transforms?.[i];
  return transform === undefined ? [...loop] : loop.map((p) => transformPoint(p, transform));
}

/**
 * Whether neighbouring turns of a helical sweep overlap (SWG_SELF_INTERSECTION_GLOBAL): a screw section's axial extent (over the twisted, scaled
 * loops of every frame) reaches the pitch, or a round wire is wider than the distance between turns. Other sections in the twist-free frame turn
 * relative to the axis, so they are not judged here.
 */
export function helixOverlap(entity: SweepEntity, transforms: readonly SectionTransform[] | null): string | null {
  const helix = entity.helix;
  if (helix === undefined || helix.type !== 'helix') return null;
  const pitch = leastPitch(helix);
  const loop = sectionLoops(entity.section).outer;
  if (entity.orientation?.mode === 'axis_plane') {
    let extent = 0;
    const count = transforms === null ? 1 : transforms.length;
    for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 128))) {
      const ys = transformedLoop(loop, transforms, i).map((p) => p[1]);
      extent = Math.max(extent, Math.max(...ys) - Math.min(...ys));
    }
    return extent >= pitch
      ? `the section reaches ${extent.toFixed(4)} along the axis, the pitch is ${pitch.toFixed(4)}: neighbouring turns overlap`
      : null;
  }
  if (entity.section.shape !== 'circle') return null;
  const smallest = Math.min(helix.radius, helix.endRadius);
  const lead = (2 * Math.PI * smallest) / Math.hypot(2 * Math.PI * smallest, pitch);
  const reach = Math.max(...loop.map((p) => Math.hypot(p[0], p[1]))) * maxScaleOf(transforms);
  return 2 * reach >= pitch * lead
    ? `the section is ${(2 * reach).toFixed(4)} wide, the turns are ${(pitch * lead).toFixed(4)} apart: neighbouring turns overlap`
    : null;
}

/**
 * Whether a screw section reaches across the axis (SWG_SELF_INTERSECTION_LOCAL): with the path frame its inward reach is at least the radius of
 * the path from the axis; with the axial frame its radius coordinate is not positive.
 */
export function axisCrossing(
  entity: SweepEntity,
  frames: readonly SweepFrame[],
  transforms: readonly SectionTransform[] | null,
): string | null {
  const orientation = entity.orientation;
  if (orientation?.mode !== 'axis_plane' || entity.stations !== undefined) return null;
  const axis = normalize3(orientation.direction);
  const loop = sectionLoops(entity.section).outer;
  for (let i = 0; i < frames.length; i += Math.max(1, Math.floor(frames.length / 128))) {
    const relative = sub3((frames[i] as SweepFrame).point, orientation.axisPoint);
    const radius = len3(sub3(relative, scale3(axis, dot3(relative, axis))));
    const xs = transformedLoop(loop, transforms, i).map((p) => p[0]);
    const crosses = orientation.sectionFrame === 'axial' ? Math.min(...xs) <= 0 : -Math.min(...xs) >= radius;
    if (crosses) return `the section reaches across the axis (path radius ${radius.toFixed(4)}); the solid would self-intersect`;
  }
  return null;
}
