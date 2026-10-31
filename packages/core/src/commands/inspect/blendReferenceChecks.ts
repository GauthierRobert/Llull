/**
 * check_model's view of a blend_union step that no longer applies: its operands are all still in the document and its result is not. With a
 * kernel, the step's recorded joint picks are resolved again by the command's own path (`unionRecipe` + the kernel's `blendReport`), so a
 * joint name that is lost, split, or took another joint's `#k` number is reported by joint index and name.
 */

import type { CadDocument, Entity, FeatureStep } from '../../model/types';
import { is3D } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { jointSchema, parsePickRefusal, planJoints, unionRecipe } from '../brep/blendJoints';

export interface BlendStepIssue {
  readonly code: 'REF_LOST' | 'REF_SPLIT';
  readonly message: string;
  readonly entityId: string;
}

/** The operands of a blend_union step still in `doc`, or null when the step is not one that failed to apply. */
function unappliedOperands(doc: CadDocument, step: FeatureStep): { ids: string[]; operands: Entity[]; radius: number } | null {
  if (step.suppressed || step.name !== 'blend_union' || !isRecord(step.params)) return null;
  const { ids, radius } = step.params;
  if (!isStringArray(ids) || ids.length < 2 || typeof radius !== 'number') return null;
  const operands = ids.flatMap((id) => {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    return entity !== undefined && is3D(entity) ? [entity] : [];
  });
  const results = step.affected ?? [];
  if (operands.length !== ids.length || results.length === 0 || results.some((id) => Object.hasOwn(doc.entities, id))) return null;
  return { ids, operands, radius };
}

/** Why the joint picks of a blend_union `step` fail now (REF_LOST / REF_SPLIT by joint), or null when they do not or cannot be checked. */
export function blendStepIssue(doc: CadDocument, kernel: GeometryKernel | null, step: FeatureStep): BlendStepIssue | null {
  const found = unappliedOperands(doc, step);
  if (kernel === null || found === null || !isRecord(step.params)) return null;
  const parsed = jointSchema.array().safeParse(step.params['joints'] ?? []);
  if (!parsed.success) return null;
  const planned = planJoints(parsed.data);
  if ('refusal' in planned) return null;
  const refusal = parsePickRefusal(kernel.blendReport?.(unionRecipe(kernel, found.operands, found.radius, planned.joints))?.message);
  if (refusal === null || (refusal.code !== 'REF_LOST' && refusal.code !== 'REF_SPLIT') || refusal.index === null) return null;
  const name = parsed.data[refusal.index]?.name ?? '(picked by point)';
  const moved = refusal.text.includes('numbering') ? ' (moved: the #k number now belongs to another joint)' : '';
  return {
    code: refusal.code,
    message: `Step '${step.id}' (blend_union of ${found.ids.join(', ')}): joint ${refusal.index} '${name}' ${refusal.code === 'REF_LOST' ? 'is lost' : 'is split'}${moved}: ${refusal.text}. Re-pick: edit_step_params on this step with a current joints[${refusal.index}].name (data.joints[].name of the blend_union result / check_blends sourceEdges), or remove name to pick by near again.`,
    entityId: found.ids[0] ?? '',
  };
}
