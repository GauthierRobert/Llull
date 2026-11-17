/**
 * The shared pipeline of the deformation commands (01 DEF §2.2): resolve the target, pre-check the closed-form Jacobian and the mesh budget,
 * build the result on the kernel when it evaluates the law (else on the core mesh path), commit one `mesh` entity whose `brep` is the
 * `deform` node.
 * @invariant no silent exact -> mesh fallback: `mode: "exact"` refuses unless the exact kernel built the result; the summary names the path taken
 */

import type { CadDocument } from '../../model/types';
import { nextId } from '../../lib/id';
import { referenceLossSuffix, replaceEntities, withEntities } from '../entity/entityOps';
import { commitKernelResult } from '../kernelShape';
import { changed } from '../noop';
import type { CommandResult, ExecutionContext } from '../types';
import { defRejection } from './codes';
import type { DeformPlan, DeformRequest } from './request';
import { type Built, build, meshEntityOf, volumeOf } from './runBuilt';
import { checkBuilt, prepare, type Prepared } from './runChecks';
import { type DeformOutcome, deformData, deformSummary } from './runReport';
import { deformSheet } from './runSheet';
import { type DeformTarget, type Refusal, isRefusal, isTarget, loadTarget } from './target';

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

/** Build on the kernel; in mode "auto" a refusal of the exact warp is answered by the faceted path unless output.allowMeshFallback is false (folds are real and stay refused). */
function buildWithFallback(
  request: DeformRequest,
  target: DeformTarget,
  plan: DeformPlan,
  prepared: Prepared,
): { readonly built: Built | Refusal; readonly fallback: string | null } {
  const { node, mode, useKernel } = prepared;
  let built = build(target, node, useKernel);
  let fallback: string | null = null;
  if (
    isRefusal(built) &&
    useKernel &&
    mode === 'auto' &&
    request.output?.allowMeshFallback !== false &&
    built.code !== 'DEF_FOLDOVER' &&
    plan.ring !== true
  ) {
    const faceted = build(target, node, false);
    if (!isRefusal(faceted)) {
      fallback = built.code;
      built = faceted;
    }
  }
  return { built, fallback };
}

function deformOne(doc: CadDocument, ctx: ExecutionContext | undefined, request: DeformRequest, id: string): CommandResult {
  const { command, keepSource = false } = request;
  const sheet = doc.entities[id];
  if (sheet?.kind === 'nurbs_curve' || sheet?.kind === 'nurbs_surface') return deformSheet(doc, request, sheet);
  const target = loadTarget(doc, command, id, ctx);
  if (!isTarget(target)) return target;
  const reject = (refusal: Refusal): CommandResult => defRejection(doc, command, refusal.code, refusal.message, [id], refusal.paths);
  const plan = request.plan(target);
  if (isRefusal(plan)) return reject(plan);
  const prepared = prepare(request, target, plan);
  if (isRefusal(prepared)) return reject(prepared);
  const { node } = prepared;
  const { built, fallback } = buildWithFallback(request, target, plan, prepared);
  if (isRefusal(built)) return reject(built);
  const refused = checkBuilt(request, target, plan, prepared, built, fallback);
  if (refused !== null) return reject(refused);
  const { kernel } = target;
  const outcome: DeformOutcome = { doc, request, id, target, plan, prepared, built, fallback, volume: volumeOf(target, built) };
  const describe = (newId: string, triangles: number): string => deformSummary(outcome, newId, triangles);
  if (kernel !== null && built.shape !== null) {
    const committed = commitKernelResult(
      doc,
      kernel,
      { recipe: node, shape: built.shape, mesh: built.mesh },
      [target.entity],
      describe,
      keepSource,
    );
    return { ...committed, data: deformData(outcome, committed.affected[0] ?? '') };
  }
  const newId = nextId('mesh');
  const created = meshEntityOf(newId, built, target.entity);
  const document = keepSource ? withEntities(doc, [created]) : replaceEntities(doc, [id], created);
  const result = changed(document, `${describe(newId, built.mesh.indices.length / 3)}${referenceLossSuffix(doc, document)}`, [newId]);
  return { ...result, data: deformData(outcome, newId) };
}
