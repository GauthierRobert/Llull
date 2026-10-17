/**
 * Resolution of the `up_to_next` / `up_to_face` hole extents (07 FTR §3.1): their depth is measured on the target solid once the entrance face
 * is known, then stored in the `feature` node (`depth`), so a replay re-measures through the command.
 * @invariant `up_to_next` is measured per hole by a centre-line ray cast; holes with different depths become separate groups (one node each)
 */

import type { ShapeRecipe, Vec2 } from '../../model/types';
import type { FeatureFrame, HoleExtent } from '../../model/features';
import type { GeometryKernel } from '../../geometry/kernel';
import { buildMeshBvh } from '../../geometry/meshBvh';
import { meshDiagonal } from '../../geometry/meshExtent';
import { depthToNextExit } from '../../geometry/featureReach';
import { dot3, sub3 } from '../../lib/vec3';
import { resolveFace } from './faceResolve';
import type { PendingExtent } from './holeSpec';

export interface ExtentGroup {
  readonly points: Vec2[];
  readonly extent: HoleExtent;
}

export interface ExtentProblem {
  readonly why: string;
  readonly remediation: string;
  readonly paths: readonly string[];
}

const PARALLEL = 1 - 1e-9;

/** Distance from the plane of `frame` down to the planar face picked at `near` (parallel, below); `path` names the offending param. */
export function depthToFace(
  kernel: GeometryKernel,
  source: ShapeRecipe,
  frame: FeatureFrame,
  near: readonly [number, number, number],
  path: string,
): number | ExtentProblem {
  const target = resolveFace(kernel, source, near);
  const paths = [path];
  if (target === 'not_found' || target === 'not_planar')
    return {
      why: target === 'not_found' ? `no face within reach of ${path} ${JSON.stringify(near)}` : 'the target face is not planar',
      remediation: 'pick a point on a planar face below the feature face',
      paths,
    };
  if (Math.abs(dot3(target.frame.normal, frame.normal)) < PARALLEL)
    return { why: 'the target face is not parallel to the feature face', remediation: 'pick a face parallel to the feature face', paths };
  const depth = dot3(sub3(frame.origin, target.frame.origin), frame.normal);
  return depth > 0
    ? depth
    : { why: 'the target face lies at or above the feature face plane', remediation: 'pick a face below the feature face', paths };
}

/**
 * The extent groups of the holes at `points`, or why no target depth can be resolved.
 * @failure target face not found / not planar / not parallel / not below, or an axis that never leaves the material -> ExtentProblem
 */
export function resolveExtents(
  kernel: GeometryKernel,
  source: ShapeRecipe,
  frame: FeatureFrame,
  points: readonly Vec2[],
  pending: PendingExtent,
): ExtentGroup[] | ExtentProblem {
  if (pending.kind === 'up_to_face') {
    const depth = depthToFace(kernel, source, frame, pending.near, 'extent.face.near');
    return typeof depth === 'number' ? [{ points: [...points], extent: { kind: 'up_to_face', depth } }] : depth;
  }
  const shape = kernel.evaluate(source);
  const mesh = shape === null ? null : kernel.tessellate(shape);
  if (mesh === null)
    return { why: 'the kernel could not build the target solid', remediation: 'check the solid with inspect_topology', paths: [] };
  const bvh = buildMeshBvh(mesh);
  const reach = 2 * meshDiagonal(mesh);
  const groups = new Map<number, ExtentGroup>();
  const missed: number[] = [];
  points.forEach((point, index) => {
    const depth = depthToNextExit(bvh, frame, point, reach);
    if (depth === null || !(depth > 0)) return void missed.push(index);
    const key = Math.round(depth / (1e-7 * (1 + depth)));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { points: [point], extent: { kind: 'up_to_next', depth } });
    else group.points.push(point);
  });
  return missed.length > 0
    ? {
        why: `the axis at points ${missed.join(', ')} never leaves the material`,
        remediation: 'use through_all, or pick another extent',
        paths: ['extent.kind'],
      }
    : [...groups.values()];
}
