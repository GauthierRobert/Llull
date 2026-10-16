/** add_fea_constraint / update_fea_constraint / delete_fea_constraint: supports of an analysis. */

import type { AnalysisCase, FeaConstraint } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget } from '../shared/target';

const DOFS = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const;

const dofsSchema = z
  .partialRecord(z.enum(DOFS), z.number())
  .describe(
    'displacement only: prescribed degrees of freedom as an object with any of the keys ux, uy, uz (document length units), rx, ry, rz ' +
      '(radians); 0 holds the dof, absent = free; at least one required, e.g. { "uz": 0 }.',
  );

const compactDofs = (dofs: Partial<Record<(typeof DOFS)[number], number>>): NonNullable<FeaConstraint['dofs']> =>
  Object.fromEntries(Object.entries(dofs).filter((entry): entry is [string, number] => entry[1] !== undefined));

/** Problem of a constraint in the context of its case, or null. */
function constraintProblem(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  constraint: FeaConstraint,
): { code: string; message: string } | null {
  const target = targetProblem(doc, analysisCase, constraint.target);
  if (target !== null) return target;
  const dofs = Object.entries(constraint.dofs ?? {});
  if (constraint.kind === 'displacement') {
    if (dofs.length === 0) return { code: 'FEA_CONSTRAINT_INVALID', message: 'a displacement constraint needs at least one dof' };
    if (dofs.some(([, value]) => !Number.isFinite(value))) return { code: 'FEA_CONSTRAINT_INVALID', message: 'dof values must be finite' };
  } else if (dofs.length > 0) {
    return { code: 'FEA_CONSTRAINT_INVALID', message: `dofs apply to displacement constraints only, not '${constraint.kind}'` };
  }
  return null;
}

const describeConstraint = (constraint: FeaConstraint): string => {
  const dofs = Object.entries(constraint.dofs ?? {})
    .map(([dof, value]) => `${dof}=${value}`)
    .join(' ');
  return `${constraint.kind}${dofs === '' ? '' : ` ${dofs}`}`;
};

/**
 * @affects doc.analysis.cases[analysisId].constraints (adds 1 constraint, id `fc-<step>.<k>`; affected: [constraintId])
 * @invariant the target is stored as points and only checked for shape + entity existence; the mesher resolves it to faces/edges/nodes
 * @failure unknown analysis, bad target, part not in the analysis, displacement without dofs, dofs on another kind -> refusal, unchanged doc
 */
export const addFeaConstraint = defineCommand({
  name: 'add_fea_constraint',
  description:
    'Add a support to an analysis, returning the constraint id in affected[0]. kind: fixed (all translations and rotations held), pinned ' +
    '(translations held, rotations free), symmetry (planar: the normal displacement is held on the target faces), displacement (prescribed ' +
    'dofs, e.g. { uz: 0 }; 0 holds a dof). target points at the faces / edges / vertices of a PART of the analysis by points near them ' +
    '(facesNear etc., document units): the nearest topology is chosen when the mesh is built, so pick points well inside the intended ' +
    'face. Under-constrained models are reported by check_analysis once built.',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name, e.g. "base fixed".'),
    kind: z.enum(['fixed', 'pinned', 'symmetry', 'displacement']).describe('Constraint type (see the command description).'),
    dofs: dofsSchema.optional(),
    target: feaTargetSchema.describe('Where the constraint applies.'),
  }),
  run: (doc, { analysisId, name, kind, dofs, target }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, 'add_fea_constraint', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const constraint: FeaConstraint = {
      id: nextId('fc'),
      name,
      kind,
      ...(dofs !== undefined ? { dofs: compactDofs(dofs) } : {}),
      target: toTarget(target),
    };
    const problem = constraintProblem(doc, analysisCase, constraint);
    if (problem !== null)
      return refuseCode(doc, 'add_fea_constraint', problem.code, problem.message, [analysisId, target.entityId], ['target']);
    const next: AnalysisCase = {
      ...analysisCase,
      constraints: { ...analysisCase.constraints, [constraint.id]: constraint },
      constraintOrder: [...analysisCase.constraintOrder, constraint.id],
    };
    return changed(
      withCase(doc, next),
      `add_fea_constraint: '${constraint.id}' (${name}) ${describeConstraint(constraint)} on '${target.entityId}' in '${analysisId}'.`,
      [constraint.id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].constraints[constraintId] (name, dofs and/or target replaced; the kind never changes)
 * @failure unknown analysis / constraint, invalid result (same rules as add_fea_constraint) -> refusal, unchanged doc
 */
export const updateFeaConstraint = defineCommand({
  name: 'update_fea_constraint',
  description:
    'Change an existing constraint: rename it, replace its dofs (displacement only) or its target. The kind cannot change (delete and add ' +
    'instead). Only the given fields change; the result is validated like add_fea_constraint.',
  params: z.object({
    analysisId: analysisIdSchema,
    constraintId: z.string().describe('Constraint id (affected[0] of add_fea_constraint, or see describe_analysis).'),
    name: z.string().min(1).optional().describe('New display name.'),
    dofs: dofsSchema.optional(),
    target: feaTargetSchema.optional().describe('New target (replaces the old one entirely).'),
  }),
  run: (doc, { analysisId, constraintId, name, dofs, target }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(
        doc,
        'update_fea_constraint',
        'FEA_ANALYSIS_NOT_FOUND',
        `no analysis '${analysisId}'`,
        [analysisId],
        ['analysisId'],
      );
    const existing = Object.hasOwn(analysisCase.constraints, constraintId) ? analysisCase.constraints[constraintId] : undefined;
    if (existing === undefined)
      return refuseCode(doc, 'update_fea_constraint', 'FEA_CONSTRAINT_NOT_FOUND', `no constraint '${constraintId}' in '${analysisId}'`, [
        analysisId,
        constraintId,
      ]);
    const updated: FeaConstraint = {
      ...existing,
      ...(name !== undefined ? { name } : {}),
      ...(dofs !== undefined ? { dofs: compactDofs(dofs) } : {}),
      ...(target !== undefined ? { target: toTarget(target) } : {}),
    };
    const problem = constraintProblem(doc, analysisCase, updated);
    if (problem !== null)
      return refuseCode(doc, 'update_fea_constraint', problem.code, problem.message, [analysisId, constraintId], ['target']);
    const next: AnalysisCase = { ...analysisCase, constraints: { ...analysisCase.constraints, [constraintId]: updated } };
    return changed(
      withCase(doc, next),
      `update_fea_constraint: '${constraintId}' now ${describeConstraint(updated)} (${updated.name}) in '${analysisId}'.`,
      [constraintId],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].constraints (removes 1; affected: [constraintId])
 * @failure unknown analysis / constraint -> refusal, unchanged doc
 */
export const deleteFeaConstraint = defineCommand({
  name: 'delete_fea_constraint',
  description: 'Remove a constraint from an analysis.',
  annotations: { destructive: true },
  params: z.object({ analysisId: analysisIdSchema, constraintId: z.string().describe('Constraint id to remove.') }),
  run: (doc, { analysisId, constraintId }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(
        doc,
        'delete_fea_constraint',
        'FEA_ANALYSIS_NOT_FOUND',
        `no analysis '${analysisId}'`,
        [analysisId],
        ['analysisId'],
      );
    if (!Object.hasOwn(analysisCase.constraints, constraintId))
      return refuseCode(doc, 'delete_fea_constraint', 'FEA_CONSTRAINT_NOT_FOUND', `no constraint '${constraintId}' in '${analysisId}'`, [
        analysisId,
        constraintId,
      ]);
    const next: AnalysisCase = {
      ...analysisCase,
      constraints: Object.fromEntries(Object.entries(analysisCase.constraints).filter(([id]) => id !== constraintId)),
      constraintOrder: analysisCase.constraintOrder.filter((id) => id !== constraintId),
    };
    return changed(withCase(doc, next), `delete_fea_constraint: removed '${constraintId}' from '${analysisId}'.`, [constraintId]);
  },
});
