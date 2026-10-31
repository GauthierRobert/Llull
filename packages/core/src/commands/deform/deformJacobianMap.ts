/** deform_jacobian_map — read-only per-vertex det J of a deformation on the deformed body, for a colour map in the viewport (01 DEF M4, FR-DEF-21). */

import type { CadDocument } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { JACOBIAN_FLOOR } from '../../geometry/deform/bounds';
import { type DeformNode, type Warp, warpOf } from '../../geometry/deform/laws';
import { type WarpResult, evaluationCost, reversesOrientation, warpMesh } from '../../geometry/deform/meshWarp';
import type { GeometryKernel } from '../../geometry/kernel';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { defRejection } from './codes';
import { chainOf, isChainFailure } from './deformChain';
import { deformNodeOf, sourceMeshOf } from './sourceMesh';
import { idParam } from './schema';

/** Triangles the map may return (each carries 3 vertices of 3 coordinates and one determinant: about 10 MB of JSON). */
const MAX_TRIANGLES = 200_000;
/** The refinement is coarsened (tolerance x COARSEN) until it fits, at most this many times. */
const COARSEN = 4;
const MAX_COARSENINGS = 10;
/** Work units of the determinant pass (6 evaluations per triangle for the finite-difference laws, weighted by the cost of the law). */
const MAX_DETERMINANT_WORK = 2e7;
const DETERMINANT_EVALUATIONS = 6;

/** How far inside the body (along the inward normal, as a fraction of the body size) a triangle is sampled: a cap lying IN a region-end plane then reads the inside of the region. */
const INWARD = 1e-6;

/** The rest point at which a triangle's det J is read: its centroid, nudged INTO the body (the mesh is outward-oriented), so a cap in a region-end plane reads the side the material is on. */
function sampleAt(rest: ArrayLike<number>, a: number, b: number, c: number, nudge: number): Vec3 {
  const at = (v: number, k: number): number => rest[3 * v + k] as number;
  const [ux, uy, uz] = [at(b, 0) - at(a, 0), at(b, 1) - at(a, 1), at(b, 2) - at(a, 2)];
  const [vx, vy, vz] = [at(c, 0) - at(a, 0), at(c, 1) - at(a, 1), at(c, 2) - at(a, 2)];
  const normal: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const length = Math.hypot(...normal) || 1;
  return [0, 1, 2].map((k) => (at(a, k) + at(b, k) + at(c, k)) / 3 - (nudge * (normal[k] as number)) / length) as unknown as Vec3;
}

const boundsDiagonal = (positions: ArrayLike<number>): number => {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k] as number, positions[i + k] as number);
      high[k] = Math.max(high[k] as number, positions[i + k] as number);
    }
  return positions.length === 0 ? 1 : Math.hypot(...[0, 1, 2].map((k) => (high[k] as number) - (low[k] as number)));
};

/** 4 significant digits: the map is a picture, not a measurement (analyze_deformation has the numbers). */
const roundDet = (value: number): number => Number(value.toPrecision(4));

interface Stage {
  readonly node: DeformNode;
  readonly warp: Warp;
  /** Rest position of every vertex of the final mesh in the input space of the node. */
  readonly positions: number[];
  readonly nudge: number;
}

type Built =
  | { readonly kind: 'ok'; readonly warped: WarpResult & { readonly ok: true }; readonly stages: Stage[]; readonly tolerance: number }
  | { readonly kind: 'big'; readonly tolerance: number }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string };

/**
 * +1 / -1 per node of `nodes` (inner first, the outermost last): the final index order is flipped once by every orientation-reversing node from this one outward,
 * so the normal of a triangle read from the node's input space points INTO the body when that count is odd.
 */
function inwardSigns(nodes: readonly DeformNode[]): number[] {
  let flips = 0;
  const signs: number[] = new Array<number>(nodes.length);
  for (let k = nodes.length - 1; k >= 0; k--) {
    if (reversesOrientation(nodes[k] as DeformNode)) flips++;
    signs[k] = flips % 2 === 0 ? 1 : -1;
  }
  return signs;
}

/** The chain re-run and the outermost node warped at `coarsen` times their tolerances; 'big' when the budget (triangles of any warp, or determinant work of the whole chain) is exceeded. */
function build(doc: CadDocument, node: DeformNode, kernel: GeometryKernel | null, composed: boolean, coarsen: number): Built {
  const limits = { maxTriangles: MAX_TRIANGLES, coarsen };
  const chain = composed ? chainOf(kernel, node.source, doc, limits) : null;
  const tolerance = node.output.tolerance * coarsen;
  if (chain !== null && isChainFailure(chain))
    return chain.code === 'DEF_BUDGET_EXCEEDED'
      ? { kind: 'big', tolerance }
      : { kind: 'refused', code: chain.code, message: chain.message };
  const source = chain === null ? sourceMeshOf(kernel, node.source, doc) : chain.mesh;
  if (source === null)
    return {
      kind: 'refused',
      code: 'DEF_SOURCE_UNAVAILABLE',
      message: 'the deformation source cannot be rebuilt without a geometry kernel',
    };
  const innerNodes = chain === null ? [] : chain.nodes;
  const warped = warpMesh(source, node, { tolerance, maxTriangles: MAX_TRIANGLES, attributes: chain === null ? [] : chain.stages });
  if (!warped.ok)
    return warped.code === 'DEF_BUDGET_EXCEEDED'
      ? { kind: 'big', tolerance }
      : { kind: 'refused', code: warped.code, message: warped.message };
  const unitWork = DETERMINANT_EVALUATIONS * [node, ...innerNodes].reduce((sum, each) => sum + evaluationCost(each), 0);
  if ((warped.mesh.indices.length / 3) * unitWork > MAX_DETERMINANT_WORK) return { kind: 'big', tolerance };
  const stages: Stage[] = [];
  for (const [k, stageNode] of innerNodes.entries()) {
    const stageWarp = warpOf(stageNode);
    const positions = warped.attributes[k];
    if (stageWarp === null || positions === undefined)
      return {
        kind: 'refused',
        code: 'DEF_FRAME_DEGENERATE',
        message: 'the recorded frame axis of an inner deformation is zero or the reference is parallel to it',
      };
    stages.push({ node: stageNode, warp: stageWarp, positions, nudge: INWARD * boundsDiagonal(positions) });
  }
  return { kind: 'ok', warped, stages, tolerance };
}

/**
 * @affects none
 (read-only); data = positions (flat world xyz of the deformed body), indices, determinant PER TRIANGLE (at its rest centroid nudged inward; the product over the chain with scope composed), min / max / folded triangle count, law, laws, deforms, scope, floor, displayTolerance
 * @invariant computed on read: the source is re-refined as the deformation did (coarsened when the answer would be too large); planeRule cuts at the region ends so no triangle straddles a jump of det J, and each triangle carries det J of the map at its REST centroid, nudged into the body so a cap in a region-end plane reads the material side; nothing is stored
 * @invariant a mirror (orientation-reversing affine node, det J < 0) reads as folded: det J <= floor on every triangle it reaches, and the sign multiplies through a chain (mirror then taper = minus the taper); the inward nudge follows the orientation flips of the nodes from each stage outward
 * @invariant scope composed (default): the determinant of every node of the chain is read at the rest point of the triangle in that node's input space (carried through every refinement, barycentric for new vertices) and multiplied: the volume ratio against the ORIGINAL body; scope outermost: the outermost node alone
 * @failure unknown id -> DEF_ENTITY_NOT_FOUND; no deform node -> DEF_NOT_DEFORMED; degenerate frame -> DEF_FRAME_DEGENERATE; source not rebuildable -> DEF_SOURCE_UNAVAILABLE; refinement still over the budget after coarsening, or refused -> the warp's code (DEF_BUDGET_EXCEEDED, DEF_APPROX_TOLERANCE)
 */
export const deformJacobianMap = defineCommand({
  name: 'deform_jacobian_map',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Jacobian determinant of a deformed body, per triangle, for a colour map drawn on the body (document units, world coordinates): by default COMPOSED along the chain of deformations (the volume ratio against the original body), or `scope: "outermost"` for the last node alone. ' +
    'data: positions (flat [x, y, z, ...] of the deformed body), indices (triangles), determinant (det J at the rest centroid of each triangle: 1 = volume kept, > 1 stretched, < 1 compressed, <= floor folded), ' +
    'min, max (of the determinants), folded (triangles with det J <= floor = 1e-6), floor, law (kind of the outermost node), laws (every node of the chain used, inner first), deforms (their count), scope, displayTolerance (the refinement tolerance used: coarser than the deformation output.tolerance when the answer would exceed 200000 triangles). ' +
    'Computed from the recipe by re-refining the source as the deformation did (with scope composed the inner deformations are re-run on the mesh path at their own tolerance, coarsened with the picture); read-only, nothing is stored. A single deformation: scope makes no difference. ' +
    'Next: analyze_deformation for the closed-form range over the whole body, check_deformation for a verdict.',
  params: z.object({
    id: idParam.describe('Id of the deformed mesh entity (the id a deformation command returned in affected).'),
    scope: z
      .enum(['composed', 'outermost'])
      .optional()
      .describe(
        'composed (default): the product of the determinants of every deform node of the chain (the volume ratio against the original body); outermost: only the last node.',
      ),
  }),
  run: (doc: CadDocument, { id, scope = 'composed' }, ctx): CommandResult => {
    const fail = (code: string, message: string): CommandResult =>
      defRejection(doc, 'deform_jacobian_map', code, message, [id], ['params.id']);
    const entity = doc.entities[id];
    if (entity === undefined) return fail('DEF_ENTITY_NOT_FOUND', `entity '${id}' not found`);
    const node = deformNodeOf(entity);
    if (node === null) return fail('DEF_NOT_DEFORMED', `entity '${id}' (kind '${entity.kind}') has no deform node in its recipe`);
    const warp = warpOf(node);
    if (warp === null) return fail('DEF_FRAME_DEGENERATE', 'the recorded frame axis is zero or the reference is parallel to it');
    const composed = scope === 'composed' && node.source.op === 'deform';
    // too many triangles (or too much determinant work, the inner nodes' determinants included): coarsen the picture, never the deformation itself; the inner nodes are re-run at the coarsened tolerance too
    let coarsen = 1;
    let built = build(doc, node, ctx?.kernel ?? null, composed, coarsen);
    for (let attempt = 0; attempt < MAX_COARSENINGS && built.kind === 'big'; attempt++) {
      coarsen *= COARSEN;
      built = build(doc, node, ctx?.kernel ?? null, composed, coarsen);
    }
    if (built.kind === 'refused') return fail(built.code, built.message);
    if (built.kind === 'big')
      return fail(
        'DEF_BUDGET_EXCEEDED',
        `the map needs more than ${MAX_TRIANGLES} triangles or ${MAX_DETERMINANT_WORK} work units even at tolerance ${built.tolerance}`,
      );
    const { warped, stages, tolerance } = built;
    const { indices } = warped.mesh;
    const rest = warped.restPositions;
    const count = indices.length / 3;
    const nudge = INWARD * boundsDiagonal(rest);
    const signs = inwardSigns([...stages.map((stage) => stage.node), node]);
    const determinant: number[] = new Array<number>(count);
    let min = Infinity;
    let max = -Infinity;
    let folded = 0;
    for (let t = 0; t < count; t++) {
      const [a, b, c] = [indices[3 * t] as number, indices[3 * t + 1] as number, indices[3 * t + 2] as number];
      let product = warp.determinant(sampleAt(rest, a, b, c, (signs[stages.length] as number) * nudge));
      stages.forEach((stage, k) => {
        product *= stage.warp.determinant(sampleAt(stage.positions, a, b, c, (signs[k] as number) * stage.nudge));
      });
      const det = roundDet(product);
      determinant[t] = det;
      min = Math.min(min, det);
      max = Math.max(max, det);
      if (!(det > JACOBIAN_FLOOR)) folded++;
    }
    const range = count === 0 ? 'no triangles' : `det J ${min.toPrecision(4)} .. ${max.toPrecision(4)}`;
    const coarse = tolerance === node.output.tolerance ? '' : `; refinement coarsened to tolerance ${tolerance.toPrecision(3)}`;
    return report(
      doc,
      `deform_jacobian_map: '${id}' ${stages.length === 0 ? `outermost deform (${node.law.kind})` : `composed (${stages.length + 1} deforms)`}: ${count} triangles, ${range}, ${folded} folded (det J <= ${JACOBIAN_FLOOR})${coarse}.`,
      {
        id,
        unit: doc.units,
        law: node.law.kind,
        laws: [...stages.map((stage) => stage.node.law.kind), node.law.kind],
        deforms: stages.length + 1,
        scope,
        positions: Array.from(warped.mesh.positions, Math.fround),
        indices: Array.from(indices),
        determinant,
        min: count === 0 ? null : min,
        max: count === 0 ? null : max,
        folded,
        floor: JACOBIAN_FLOOR,
        displayTolerance: tolerance,
      },
    );
  },
});
