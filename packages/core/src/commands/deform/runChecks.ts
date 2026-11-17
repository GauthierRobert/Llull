/** The refusal checks around a deformation build: before it (tolerance, fold, budget, exactness) and on its result (ring, analytic faces, exact mode, self-overlap). */

import { JACOBIAN_FLOOR, jacobianRange, sampledRangeAt } from '../../geometry/deform/bounds';
import type { DeformNode } from '../../geometry/deform/laws';
import { MAX_WARP_TRIANGLES, estimateWarp } from '../../geometry/deform/meshWarp';
import { findSelfIntersections } from '../../geometry/mesh/selfIntersection';
import { weldMesh } from '../../geometry/mesh/weld';
import type { Built } from './runBuilt';
import type { DeformPlan, DeformRequest, OutputInput } from './request';
import { type DeformTarget, type Refusal, defaultTolerance } from './target';

/** Largest result (triangles) the post-build overlap test runs on (its grid search degrades on very large meshes). */
const OVERLAP_CHECK_LIMIT = 60_000;
/** Laws whose result can cross itself while det J stays positive (a path curling back, a field pushing one part through another): the tessellation is checked. */
const OVERLAP_LAWS: ReadonlySet<string> = new Set(['flowCurve', 'rbf', 'flowSurface']);

export const RING_REFUSAL: Refusal = {
  code: 'DEF_SELF_INTERSECTION',
  message:
    'a full-turn bend closes into a ring whose two end faces coincide: only the exact kernel sews it closed (native kernel, mode "auto" or "exact"); the faceted path would overlap itself',
  paths: ['params'],
};

export interface Prepared {
  readonly node: DeformNode;
  readonly mode: NonNullable<OutputInput['mode']>;
  readonly tolerance: number;
  readonly useKernel: boolean;
}

export const rangeOfPlan = (node: DeformNode, plan: DeformPlan): ReturnType<typeof jacobianRange> =>
  plan.samples === undefined ? jacobianRange(node, plan.extent) : sampledRangeAt(node, plan.samples, plan.gridSamples);

function foldRefusal(node: DeformNode, plan: DeformPlan): Refusal | null {
  if (node.law.kind === 'affine') return null;
  const range = rangeOfPlan(node, plan);
  const { extent } = plan;
  if (range.min > JACOBIAN_FLOOR) return null;
  const { law } = node;
  if (law.kind === 'bend') {
    const distance = extent.max[1];
    return {
      code: 'DEF_BEND_RADIUS_TOO_SMALL',
      message: `radius ${law.radius} <= ${distance}, the distance of the body from the neutral fibre on the centre side (min det J ${range.min.toPrecision(6)}); radius must exceed ${distance}`,
      paths: ['params.radius'],
    };
  }
  const where = `at local point [${range.minAt.map((value) => value.toPrecision(5)).join(', ')}]`;
  if (law.kind === 'flowCurve')
    return {
      code: 'DEF_FOLDOVER',
      message: `the body is wider than the radius of curvature of the path: min det J ${range.min.toPrecision(6)} ${where}; use a gentler curve, a thinner body, or a larger path radius`,
      paths: ['params.targetId'],
    };
  if (law.kind === 'lattice')
    return {
      code: 'DEF_FOLDOVER',
      message: `the lattice folds the body: min det J ${range.min.toPrecision(6)} ${where} (Bernstein bound ${range.bound?.min.toPrecision(6) ?? 'n/a'}); reduce the moves`,
      paths: ['params.moves'],
    };
  return { code: 'DEF_FOLDOVER', message: `the map folds the body (min det J ${range.min.toPrecision(6)} <= 0) ${where}`, paths: [] };
}

/** The deform node and the path (kernel or mesh) of a request, or the first refusal that needs no build. */
export function prepare(request: DeformRequest, target: DeformTarget, plan: DeformPlan): Prepared | Refusal {
  const { output } = request;
  const tolerance = output?.tolerance ?? defaultTolerance(target.diagonal);
  if (!(tolerance > 0) || !Number.isFinite(tolerance))
    return { code: 'DEF_TOLERANCE_INVALID', message: `tolerance ${tolerance} must be finite and > 0`, paths: ['params.output.tolerance'] };
  const mode = output?.mode ?? 'auto';
  const node: DeformNode = {
    op: 'deform',
    source: target.source,
    law: plan.law,
    frame: plan.frame,
    ...(plan.region === undefined ? {} : { region: plan.region }),
    output: { mode, tolerance, preserveAnalytic: output?.preserveAnalytic === true },
  };
  const fold = foldRefusal(node, plan);
  if (fold !== null) return fold;
  const { kernel } = target;
  const useKernel =
    kernel !== null &&
    !target.faceted &&
    mode !== 'mesh' &&
    kernel.supports('deform') &&
    kernel.supportsDeform?.(plan.law, plan.region) !== false;
  const estimate = estimateWarp(target.mesh, node, tolerance);
  if (estimate !== null && !useKernel && estimate.triangles > MAX_WARP_TRIANGLES)
    return {
      code: 'DEF_BUDGET_EXCEEDED',
      message: `refining to edges of ${estimate.edgeLength.toPrecision(3)} would need about ${Math.round(estimate.triangles)} triangles (limit ${MAX_WARP_TRIANGLES})`,
      paths: ['params.output.tolerance'],
    };
  if (
    output?.preserveAnalytic === true &&
    (!useKernel || plan.law.kind === 'affine' || kernel?.info?.().capabilities.includes('deform-analytic') !== true)
  )
    return {
      code: 'DEF_EXACT_UNAVAILABLE',
      message:
        'preserveAnalytic rebuilds analytic faces of the exact result: it needs the native kernel and its exact warp (mode "auto" or "exact", a B-rep source, a law the kernel warps, so not a linear scale; a kernel with the deform-analytic capability)',
      paths: ['params.output.preserveAnalytic'],
    };
  if (mode === 'exact' && !useKernel)
    return {
      code: 'DEF_EXACT_UNAVAILABLE',
      message:
        kernel === null
          ? 'no geometry kernel is installed'
          : target.faceted
            ? `'${target.entity.id}' is a mesh without an exact construction (its triangles are the source): mode "auto" or "mesh" deforms it`
            : 'the installed kernel does not build this deformation exactly',
      paths: ['params.output.mode'],
    };
  if (plan.ring === true && !useKernel) return RING_REFUSAL;
  return { node, mode, tolerance, useKernel };
}

/** The refusals on a built result: ring not sewn, analytic faces lost, exact mode on a mesh, the body crossing itself. */
export function checkBuilt(
  request: DeformRequest,
  target: DeformTarget,
  plan: DeformPlan,
  prepared: Prepared,
  built: Built,
  fallback: string | null,
): Refusal | null {
  const { output } = request;
  const { node, mode } = prepared;
  if (plan.ring === true && (!built.exact || target.kernel?.deformReport?.(node)?.ring !== true)) return RING_REFUSAL;
  if (output?.preserveAnalytic === true && !built.exact)
    return {
      code: 'DEF_EXACT_UNAVAILABLE',
      message: `preserveAnalytic needs the exact result, and the exact warp refused${fallback === null ? '' : ` (${fallback})`}: no analytic face to rebuild on a faceted mesh`,
      paths: ['params.output.preserveAnalytic'],
    };
  if (mode === 'exact' && !built.exact)
    return { code: 'DEF_EXACT_UNAVAILABLE', message: 'the installed kernel is a mesh kernel', paths: ['params.output.mode'] };
  if ((plan.checkOverlap === true || OVERLAP_LAWS.has(plan.law.kind)) && built.mesh.indices.length / 3 <= OVERLAP_CHECK_LIMIT) {
    const welded = weldMesh(built.mesh, 1e-7 * target.diagonal);
    const crossings = findSelfIntersections(welded.positions, welded.triangles, 1).count;
    if (crossings > 0)
      return {
        code: 'DEF_SELF_INTERSECTION',
        message: `the deformed body would cross itself (${crossings} triangle pair(s)): reduce the bend or the move, or keep the path, curves or target surface farther from the body`,
        paths: ['params'],
      };
  }
  return null;
}
