/**
 * The shared pipeline of the deformation commands (01 DEF §2.2): resolve the target, pre-check the closed-form Jacobian and the mesh budget,
 * build the result on the kernel when it evaluates the law (else on the core mesh path), commit one `mesh` entity whose `brep` is the
 * `deform` node.
 * @invariant no silent exact -> mesh fallback: `mode: "exact"` refuses unless the exact kernel built the result; the summary names the path taken
 */

import type { DeformFrame, DeformLaw, DeformRegion } from '../../model/deform';
import type { CadDocument, Entity, MeshData, Vec3 } from '../../model/types';
import { JACOBIAN_FLOOR, type LocalExtent, jacobianRange } from '../../geometry/deform/bounds';
import type { DeformNode } from '../../geometry/deform/laws';
import { MAX_WARP_TRIANGLES, estimateWarp, warpMesh } from '../../geometry/deform/meshWarp';
import { findSelfIntersections } from '../../geometry/mesh/selfIntersection';
import { weldMesh } from '../../geometry/mesh/weld';
import { signedMeshVolume } from '../../geometry/meshVolume';
import type { GeometryKernel, ShapeHandle } from '../../geometry/kernel';
import { nextId } from '../../lib/id';
import { newEntity } from '../entity/newEntity';
import { referenceLossSuffix, replaceEntities } from '../entity/entityOps';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { changed } from '../noop';
import type { CommandResult, ExecutionContext } from '../types';
import { defRejection } from './codes';
import { NEXT_STEP } from './schema';
import { type DeformTarget, type Refusal, defaultTolerance, isRefusal, isTarget, loadTarget } from './target';

/** What a command decided from the target: the map and where it acts. */
export interface DeformPlan {
  readonly law: DeformLaw;
  readonly frame: DeformFrame;
  readonly region?: DeformRegion;
  /** Frame of the body in the plan's frame (for the Jacobian pre-check and the report). */
  readonly extent: LocalExtent;
  /** Look for the result crossing itself (a bend past a quarter turn with straight parts left). */
  readonly checkOverlap?: boolean;
  /** Names of frame fields taken from the body bounds. */
  readonly defaulted: readonly string[];
}

export interface OutputInput {
  readonly mode?: 'auto' | 'exact' | 'mesh' | undefined;
  readonly tolerance?: number | undefined;
  readonly preserveAnalytic?: boolean | undefined;
}

export interface DeformRequest {
  readonly command: string;
  readonly id: string;
  readonly verb: string;
  readonly output: OutputInput | undefined;
  readonly plan: (target: DeformTarget) => DeformPlan | Refusal;
}

/** Largest result (triangles) the post-build overlap test runs on (its grid search degrades on very large meshes). */
const OVERLAP_CHECK_LIMIT = 60_000;

/** Wire-friendly form of a point for `data`. */
const list = (v: Vec3): number[] => [v[0], v[1], v[2]];

interface Built {
  readonly recipe: DeformNode;
  readonly mesh: MeshData;
  readonly shape: ShapeHandle | null;
  readonly exact: boolean;
  readonly edgeLength: number | null;
  readonly chordError: number | null;
}

function meshEntityOf(id: string, built: Built, source: Entity): Entity {
  return newEntity('mesh', id, { mesh: built.mesh, brep: built.recipe }, [0, 0, 0], source.color, { layerId: source.layerId });
}

function volumeOf(kernel: GeometryKernel | null, built: Built): { value: number; method: 'exact' | 'mesh' } {
  const exact = built.exact && built.shape !== null ? kernel?.massProperties?.(built.shape)?.volume : undefined;
  return exact === undefined
    ? { value: Math.abs(signedMeshVolume(built.mesh.positions, built.mesh.indices)), method: 'mesh' }
    : { value: exact, method: 'exact' };
}

/** The kernel result of `node`, or a refusal; `useKernel` false skips straight to the core mesh path. */
function build(target: DeformTarget, node: DeformNode, useKernel: boolean): Built | Refusal {
  const { kernel } = target;
  if (useKernel && kernel !== null) {
    const evaluated = evaluateRecipe(kernel, node);
    if (typeof evaluated === 'string') {
      // the same refusal on every host: a failure the core mesh warp also reports (budget, frame) keeps its own code
      const diagnosis = warpMesh(target.mesh, node, { tolerance: node.output.tolerance });
      if (!diagnosis.ok) return { code: diagnosis.code, message: diagnosis.message, paths: [] };
      return {
        code: 'DEF_KERNEL_REFUSED',
        message: `the kernel ${evaluated === 'empty' ? 'built an empty shape' : 'refused the deformation'}`,
        paths: [],
      };
    }
    return {
      recipe: node,
      mesh: evaluated.mesh,
      shape: evaluated.shape,
      exact: kernel.topology(evaluated.shape) !== null,
      edgeLength: null,
      chordError: null,
    };
  }
  const warped = warpMesh(target.mesh, node, { tolerance: node.output.tolerance });
  if (!warped.ok) return { code: warped.code, message: warped.message, paths: [] };
  return {
    recipe: node,
    mesh: warped.mesh,
    shape: null,
    exact: false,
    edgeLength: Number.isFinite(warped.edgeLength) ? warped.edgeLength : null,
    chordError: warped.maxChordError,
  };
}

function foldRefusal(node: DeformNode, extent: LocalExtent): Refusal | null {
  if (node.law.kind === 'affine') return null;
  const range = jacobianRange(node, extent);
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
  return { code: 'DEF_FOLDOVER', message: `the map folds the body (min det J ${range.min.toPrecision(6)} <= 0)`, paths: [] };
}

/** Run a deformation request against the document. */
export function runDeform(doc: CadDocument, ctx: ExecutionContext | undefined, request: DeformRequest): CommandResult {
  const { command, id, verb, output } = request;
  const target = loadTarget(doc, command, id, ctx);
  if (!isTarget(target)) return target;
  const reject = (refusal: Refusal): CommandResult => defRejection(doc, command, refusal.code, refusal.message, [id], refusal.paths);
  const plan = request.plan(target);
  if (isRefusal(plan)) return reject(plan);
  const tolerance = output?.tolerance ?? defaultTolerance(target.diagonal);
  if (!(tolerance > 0) || !Number.isFinite(tolerance))
    return reject({
      code: 'DEF_TOLERANCE_INVALID',
      message: `tolerance ${tolerance} must be finite and > 0`,
      paths: ['params.output.tolerance'],
    });
  if (output?.preserveAnalytic === true)
    return reject({
      code: 'DEF_EXACT_UNAVAILABLE',
      message: 'preserveAnalytic needs the exact warp of a later milestone',
      paths: ['params.output.preserveAnalytic'],
    });
  const mode = output?.mode ?? 'auto';
  const node: DeformNode = {
    op: 'deform',
    source: target.source,
    law: plan.law,
    frame: plan.frame,
    ...(plan.region === undefined ? {} : { region: plan.region }),
    output: { mode, tolerance, preserveAnalytic: false },
  };
  const fold = foldRefusal(node, plan.extent);
  if (fold !== null) return reject(fold);
  const estimate = estimateWarp(target.mesh, node, tolerance);
  if (estimate !== null && estimate.triangles > MAX_WARP_TRIANGLES)
    return reject({
      code: 'DEF_BUDGET_EXCEEDED',
      message: `refining to edges of ${estimate.edgeLength.toPrecision(3)} would need about ${Math.round(estimate.triangles)} triangles (limit ${MAX_WARP_TRIANGLES})`,
      paths: ['params.output.tolerance'],
    });
  const { kernel } = target;
  const useKernel = kernel !== null && mode !== 'mesh' && kernel.supports('deform') && kernel.supportsDeform?.(plan.law) !== false;
  if (mode === 'exact' && !useKernel)
    return reject({
      code: 'DEF_EXACT_UNAVAILABLE',
      message: kernel === null ? 'no geometry kernel is installed' : 'the installed kernel does not build this deformation exactly',
      paths: ['params.output.mode'],
    });
  const built = build(target, node, useKernel);
  if (isRefusal(built)) return reject(built);
  if (mode === 'exact' && !built.exact)
    return reject({ code: 'DEF_EXACT_UNAVAILABLE', message: 'the installed kernel is a mesh kernel', paths: ['params.output.mode'] });
  if (plan.checkOverlap === true && built.mesh.indices.length / 3 <= OVERLAP_CHECK_LIMIT) {
    const welded = weldMesh(built.mesh, 1e-7 * target.diagonal);
    const crossings = findSelfIntersections(welded.positions, welded.triangles, 1).count;
    if (crossings > 0)
      return reject({
        code: 'DEF_SELF_INTERSECTION',
        message: `the bent body would cross itself (${crossings} triangle pair(s)): reduce the angle or shorten the straight part`,
        paths: ['params'],
      });
  }
  const volume = volumeOf(kernel, built);
  const path = built.exact ? 'exact' : 'mesh';
  const why =
    built.exact || mode === 'mesh'
      ? ''
      : kernel === null
        ? ' No geometry kernel is installed, so the result is a faceted mesh.'
        : !useKernel
          ? ' The kernel does not build this law exactly, so the result is a faceted mesh (mode "exact" refuses instead).'
          : ' The kernel is a mesh kernel, so the result is a faceted mesh.';
  const describe = (newId: string, triangles: number): string =>
    `${command}: ${verb} '${id}' (kind '${target.entity.kind}') → mesh '${newId}' (${triangles} triangles, ${path} path, volume ${volume.value.toPrecision(8)} ${doc.units}^3 ${volume.method}).${why} ` +
    `Frame origin [${list(plan.frame.origin).join(', ')}] axis [${list(plan.frame.axis).join(', ')}]${plan.defaulted.length > 0 ? ` (defaulted: ${plan.defaulted.join(', ')})` : ''}. ${NEXT_STEP}`;
  const data = (newId: string): Record<string, unknown> => ({
    id: newId,
    path,
    kernel: kernel?.name ?? null,
    law: plan.law,
    frame: {
      origin: list(plan.frame.origin),
      axis: list(plan.frame.axis),
      reference: list(plan.frame.reference),
      defaulted: plan.defaulted,
    },
    ...(plan.region === undefined ? {} : { region: plan.region }),
    tolerance: { value: tolerance, unit: doc.units, defaulted: output?.tolerance === undefined },
    jacobian: { min: jacobianRange(node, plan.extent).min, max: jacobianRange(node, plan.extent).max },
    triangles: built.mesh.indices.length / 3,
    volume: { ...volume, unit: `${doc.units}^3` },
    edgeLength: built.edgeLength,
    chordError: built.chordError,
    unit: doc.units,
  });
  if (kernel !== null && built.shape !== null) {
    const committed = commitKernelResult(doc, kernel, { recipe: node, shape: built.shape, mesh: built.mesh }, [target.entity], describe);
    return { ...committed, data: data(committed.affected[0] ?? '') };
  }
  const newId = nextId('mesh');
  const document = replaceEntities(doc, [id], meshEntityOf(newId, built, target.entity));
  const result = changed(document, `${describe(newId, built.mesh.indices.length / 3)}${referenceLossSuffix(doc, document)}`, [newId]);
  return { ...result, data: data(newId) };
}
