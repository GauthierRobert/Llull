/**
 * check_model's view of edge-picking feature steps that no longer apply (SC-N2): a fillet / chamfer step whose target is still in the
 * document while its result is not did not regenerate. With a kernel, the step's recorded persistent edge names are looked up on the
 * target again to say why: REF_LOST (an edge is gone) or REF_SPLIT (an edge now has several images), with the way to re-pick.
 */

import type { CadDocument, FeatureStep } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { referenceProblem, resolveNames, hasNames } from '../../geometry/naming/references';
import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { operandRecipe } from '../../geometry/operandRecipe';
import { REPICK_EDGES } from '../brep/edgeReferences';

const EDGE_PICKING_STEPS: ReadonlySet<string> = new Set(['fillet_edge', 'chamfer_edge', 'project_edges_to_sketch']);

export interface ReferenceIssue {
  readonly code: 'REF_LOST' | 'REF_SPLIT' | 'feature_step_not_applied' | 'sketch_link_lost';
  readonly message: string;
  readonly entityId: string;
}

/** Why the recorded names of `step` fail on `target` now, or null when they resolve (or cannot be checked). */
function nameProblem(kernel: GeometryKernel | null, doc: CadDocument, target: string, names: readonly string[]): ReferenceIssue | null {
  const entity = doc.entities[target];
  if (kernel === null || entity === undefined || names.length === 0) return null;
  const shape = kernel.evaluate(operandRecipe(kernel, entity));
  const topology = shape === null ? null : kernel.topology(shape);
  if (!hasNames(topology, 'edge')) return null;
  const resolved = resolveNames(topology, 'edge', names);
  if (resolved.ok) return null;
  return {
    code: resolved.lost.length > 0 ? 'REF_LOST' : 'REF_SPLIT',
    message: `${referenceProblem('edge', resolved)} on '${target}'. ${REPICK_EDGES}`,
    entityId: target,
  };
}

function stepIssue(doc: CadDocument, kernel: GeometryKernel | null, step: FeatureStep): ReferenceIssue | null {
  if (step.suppressed || !EDGE_PICKING_STEPS.has(step.name) || !isRecord(step.params)) return null;
  const target = step.params['id'];
  if (typeof target !== 'string' || !Object.hasOwn(doc.entities, target)) return null;
  const results = step.affected ?? [];
  if (results.length === 0 || results.some((id) => Object.hasOwn(doc.entities, id))) return null;
  const names = step.params['edgeNames'];
  const precise = isStringArray(names) ? nameProblem(kernel, doc, target, names) : null;
  return (
    precise ?? {
      code: 'feature_step_not_applied',
      message: `Step '${step.id}' (${step.name}) did not apply: its target '${target}' is still unmodified. Run replay_history to see why, then fix the step with edit_step_params.`,
      entityId: target,
    }
  );
}

/** Linked sketch geometry (SC-S3) whose solid is gone, or whose recorded edges no longer resolve on it. */
function sketchLinkIssues(doc: CadDocument, kernel: GeometryKernel | null): ReferenceIssue[] {
  return Object.values(doc.sketchLinks ?? {}).flatMap((link): ReferenceIssue[] => {
    const { entityId, edgeNames } = link.source;
    if (!Object.hasOwn(doc.entities, entityId))
      return [
        {
          code: 'sketch_link_lost',
          message: `Sketch entity '${link.id}' is linked to '${entityId}', which is gone; break_sketch_link keeps its geometry.`,
          entityId: link.id,
        },
      ];
    const problem = nameProblem(kernel, doc, entityId, edgeNames);
    return problem === null
      ? []
      : [{ ...problem, code: 'sketch_link_lost', message: `Sketch entity '${link.id}': ${problem.message}`, entityId: link.id }];
  });
}

/** One issue per edge-picking step that no longer applies and per broken sketch link (see the module doc). */
export function featureReferenceIssues(doc: CadDocument, kernel: GeometryKernel | null): ReferenceIssue[] {
  const steps = doc.featureHistory.flatMap((step) => {
    const found = stepIssue(doc, kernel, step);
    return found === null ? [] : [found];
  });
  return [...steps, ...sketchLinkIssues(doc, kernel)];
}
