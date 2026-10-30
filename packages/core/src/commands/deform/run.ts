/**
 * The shared pipeline of the deformation commands (01 DEF §2.2): resolve the target, pre-check the closed-form Jacobian and the mesh budget,
 * build the result on the kernel when it evaluates the law (else on the core mesh path), commit one `mesh` entity whose `brep` is the
 * `deform` node.
 * @invariant no silent exact -> mesh fallback: `mode: "exact"` refuses unless the exact kernel built the result; the summary names the path taken
 */

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
import { referenceLossSuffix, replaceEntities, withEntities } from '../entity/entityOps';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { changed } from '../noop';
import type { CommandResult, ExecutionContext } from '../types';
import { defRejection } from './codes';
import type { DeformRequest } from './request';
import { deformSheet } from './runSheet';
import { NEXT_STEP } from './schema';
import { type DeformTarget, type Refusal, defaultTolerance, isRefusal, isTarget, loadTarget } from './target';

/** Largest result (triangles) the post-build overlap test runs on (its grid search degrades on very large meshes). */
const OVERLAP_CHECK_LIMIT = 60_000;
/** Laws whose result can cross itself while det J stays positive (a path curling back, a field pushing one part through another): the tessellation is checked. */
const OVERLAP_LAWS: ReadonlySet<string> = new Set(['flowCurve', 'rbf', 'flowSurface']);

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
      // the kernel says why it refused (approximation above the tolerance, folded map, invalid result); else a failure the core mesh warp also
      // reports (budget, frame) keeps its own code, the same on every host
      const reported = kernel.deformReport?.(node);
      if (reported !== undefined && reported !== null && !reported.ok && reported.code !== '')
        return {
          code: reported.code,
          message: reported.message,
          paths: reported.code === 'DEF_APPROX_TOLERANCE' ? ['params.output.tolerance'] : [],
        };
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

/**
 * Run a deformation request against the document: one body, or each body of `ids` in turn.
 * @invariant all-or-nothing: the first refused body leaves the whole document unchanged and names that body
 */
export function runDeform(doc: CadDocument, ctx: ExecutionContext | undefined, request: DeformRequest): CommandResult {
  const { command, ids } = request;
  if (ids.length === 0)
    return defRejection(doc, command, 'DEF_ENTITY_NOT_FOUND', 'give id or ids: the body(ies) to deform', [], ['params.id']);
  if (ids.length === 1) return deformOne(doc, ctx, request, ids[0] as string);
  let current = doc;
  const affected: string[] = [];
  const parts: CommandResult[] = [];
  for (const id of ids) {
    const part = deformOne(current, ctx, request, id);
    if (part.affected.length === 0)
      return { ...part, document: doc, summary: `${part.summary} (body '${id}' of ${ids.length}; nothing was changed)` };
    current = part.document;
    affected.push(...part.affected);
    parts.push(part);
  }
  const summary = `${command}: ${ids.length} bodies → ${affected.join(', ')}. ${parts.map((part) => part.summary.replace(`${command}: `, '')).join(' ')}`;
  return { ...changed(current, summary, affected), data: { bodies: parts.map((part) => part.data) } };
}

function deformOne(doc: CadDocument, ctx: ExecutionContext | undefined, request: DeformRequest, id: string): CommandResult {
  const { command, verb, output, keepSource = false } = request;
  const sheet = doc.entities[id];
  if (sheet?.kind === 'nurbs_curve' || sheet?.kind === 'nurbs_surface') return deformSheet(doc, request, sheet);
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
  const { kernel } = target;
  const useKernel =
    kernel !== null && !target.faceted && mode !== 'mesh' && kernel.supports('deform') && kernel.supportsDeform?.(plan.law) !== false;
  const estimate = estimateWarp(target.mesh, node, tolerance);
  if (estimate !== null && !useKernel && estimate.triangles > MAX_WARP_TRIANGLES)
    return reject({
      code: 'DEF_BUDGET_EXCEEDED',
      message: `refining to edges of ${estimate.edgeLength.toPrecision(3)} would need about ${Math.round(estimate.triangles)} triangles (limit ${MAX_WARP_TRIANGLES})`,
      paths: ['params.output.tolerance'],
    });
  if (mode === 'exact' && !useKernel)
    return reject({
      code: 'DEF_EXACT_UNAVAILABLE',
      message:
        kernel === null
          ? 'no geometry kernel is installed'
          : target.faceted
            ? `'${target.entity.id}' is a mesh without an exact construction (its triangles are the source): mode "auto" or "mesh" deforms it`
            : 'the installed kernel does not build this deformation exactly',
      paths: ['params.output.mode'],
    });
  const ringRefusal = (): CommandResult =>
    reject({
      code: 'DEF_SELF_INTERSECTION',
      message:
        'a full-turn bend closes into a ring whose two end faces coincide: only the exact kernel sews it closed (native kernel, mode "auto" or "exact"); the faceted path would overlap itself',
      paths: ['params'],
    });
  if (plan.ring === true && !useKernel) return ringRefusal();
  let built = build(target, node, useKernel);
  let fallback: string | null = null;
  if (
    isRefusal(built) &&
    useKernel &&
    mode === 'auto' &&
    output?.allowMeshFallback !== false &&
    built.code !== 'DEF_FOLDOVER' &&
    plan.ring !== true
  ) {
    // mode "auto": a refusal of the exact warp (approximation above the tolerance, modifier failure) is answered by the faceted path unless
    // output.allowMeshFallback is false; folds are real and stay refused
    const faceted = build(target, node, false);
    if (!isRefusal(faceted)) {
      fallback = built.code;
      built = faceted;
    }
  }
  if (isRefusal(built)) return reject(built);
  if (plan.ring === true && (!built.exact || kernel?.deformReport?.(node)?.ring !== true)) return ringRefusal();
  if (mode === 'exact' && !built.exact)
    return reject({ code: 'DEF_EXACT_UNAVAILABLE', message: 'the installed kernel is a mesh kernel', paths: ['params.output.mode'] });
  if ((plan.checkOverlap === true || OVERLAP_LAWS.has(plan.law.kind)) && built.mesh.indices.length / 3 <= OVERLAP_CHECK_LIMIT) {
    const welded = weldMesh(built.mesh, 1e-7 * target.diagonal);
    const crossings = findSelfIntersections(welded.positions, welded.triangles, 1).count;
    if (crossings > 0)
      return reject({
        code: 'DEF_SELF_INTERSECTION',
        message: `the deformed body would cross itself (${crossings} triangle pair(s)): reduce the bend or the move, or keep the path, curves or target surface farther from the body`,
        paths: ['params'],
      });
  }
  const volume = volumeOf(kernel, built);
  const path = built.exact ? 'exact' : 'mesh';
  const why =
    built.exact || mode === 'mesh'
      ? ''
      : target.faceted
        ? ' The source is a mesh without an exact construction, so the result is a faceted mesh.'
        : fallback !== null
          ? ` The exact warp refused (${fallback}), so the result is a faceted mesh (mode "exact" refuses instead).`
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
    ...(fallback === null ? {} : { exactRefused: fallback }),
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
    ...plan.report,
    unit: doc.units,
  });
  if (kernel !== null && built.shape !== null) {
    const committed = commitKernelResult(
      doc,
      kernel,
      { recipe: node, shape: built.shape, mesh: built.mesh },
      [target.entity],
      describe,
      keepSource,
    );
    return { ...committed, data: data(committed.affected[0] ?? '') };
  }
  const newId = nextId('mesh');
  const created = meshEntityOf(newId, built, target.entity);
  const document = keepSource ? withEntities(doc, [created]) : replaceEntities(doc, [id], created);
  const result = changed(document, `${describe(newId, built.mesh.indices.length / 3)}${referenceLossSuffix(doc, document)}`, [newId]);
  return { ...result, data: data(newId) };
}
