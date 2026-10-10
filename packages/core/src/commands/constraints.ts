/**
 * @command add_constraint
 * @command delete_constraint
 * @command update_constraint
 * @command solve_constraints
 * @pure
 * @layer core/commands
 * @affects constraints record and constraintOrder in CadDocument; solve_constraints also
 *          updates entity positions in entities record.
 * @invariant Constraint ids are unique; each EntityRef.entityId must exist in the document
 *            at solve time (dangling refs produce a graceful no-op per constraint).
 * @failure Unknown constraint id / malformed input → no-op, affected:[].
 *          Solver non-convergence → best-effort positions returned, converged:false in data.
 */

import { type CadDocument, type Constraint, CONSTRAINT_KINDS } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { runSolver } from './constraintSolver';
import { changed, noop, report } from './noop';
import { expressionSyntaxError } from './expression';

/** Optional named point of a line / arc / circle (`EntityRef.kind`). */
const SUB_POINT = z.enum(['start', 'end', 'center', 'mid']).optional();

const entityRef = (
  entityIdDescription: string,
  kindDescription: string,
): z.ZodObject<{ entityId: z.ZodString; kind: typeof SUB_POINT }> =>
  z.object({
    entityId: z.string().describe(entityIdDescription),
    kind: SUB_POINT.describe(kindDescription),
  });

/** Semantic checks zod cannot express: non-empty entity ids; `value` on dimensional kinds. */
function validateConstraintShape(c: {
  kind: string;
  a: { entityId: string };
  b: { entityId: string };
  value?: unknown;
}): string | null {
  for (const key of ['a', 'b'] as const) {
    if (c[key].entityId.length === 0)
      return `constraint.${key} must be a valid EntityRef (has entityId)`;
  }
  if ((c.kind === 'distance' || c.kind === 'angle') && c.value === undefined)
    return `constraint kind '${c.kind}' requires a numeric or string 'value' field`;
  return null;
}

/**
 * @command add_constraint
 * @pure
 * @layer core/commands
 * @affects adds 1 entry to document.constraints and document.constraintOrder
 * @invariant constraint.id is unique within the document
 * @failure malformed constraint shape → no-op, affected:[]
 */
export const addConstraint = defineCommand({
  name: 'add_constraint',
  description:
    'Add a geometric or dimensional constraint between two entity references. ' +
    'Geometric kinds (coincident, parallel, perpendicular, tangent) impose a ' +
    'positional or directional relationship with no numeric target. ' +
    'Dimensional kinds (distance, angle) require a numeric "value" field. ' +
    'Call solve_constraints afterward to update entity positions. ' +
    'Returns the new constraint id in affected[0].',
  params: z.object({
    constraint: z
      .object({
        kind: z
          .enum(CONSTRAINT_KINDS)
          .describe(
            'Constraint type. Geometric: "coincident" (two points share a location), ' +
              '"parallel" (two lines are parallel), "perpendicular" (two lines are at 90°), ' +
              '"tangent" (line tangent to circle/arc, or two arcs externally tangent). ' +
              'Dimensional: "distance" (distance between two points equals value), ' +
              '"angle" (angle between two line directions equals value in radians).',
          ),
        a: entityRef(
          'Id of the first entity.',
          'Sub-point selector: start, end, center, or mid.',
        ).describe(
          'First entity reference. Minimum: { entityId: "<id>" }. ' +
            'Optional sub-point: { entityId: "<id>", kind: "start"|"end"|"center"|"mid" } ' +
            'to target a specific geometric point on a line, arc, or circle.',
        ),
        b: entityRef(
          'Id of the second entity.',
          'Sub-point selector: start, end, center, or mid.',
        ).describe(
          'Second entity reference. Same shape as "a". ' +
            '{ entityId: "<id>" } or { entityId: "<id>", kind: "start"|"end"|"center"|"mid" }.',
        ),
        value: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            'Required for dimensional constraints (distance, angle). ' +
              'A numeric literal ("10", "1.5708") or a parameter expression string ' +
              '("width", "height / 2"). Angle is in radians.',
          ),
      })
      .describe(
        'The constraint to add. Must have: "kind" (one of coincident|parallel|perpendicular|tangent|distance|angle), ' +
          '"a" (EntityRef: { entityId: string, kind?: "start"|"end"|"center"|"mid" }), ' +
          '"b" (EntityRef: same shape). ' +
          'Dimensional kinds also require "value": a number or parameter expression string.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Optional explicit constraint id. When omitted a unique id is generated. ' +
          'If the id already exists in the document the command is a no-op.',
      ),
  }),
  run: (doc, { constraint, id }): CommandResult => {
    const err = validateConstraintShape(constraint);
    if (err !== null) return noop(doc, `add_constraint failed: ${err}.`);

    const unknownEntity = [constraint.a.entityId, constraint.b.entityId].find(
      (entityId) => !Object.hasOwn(doc.entities, entityId),
    );
    if (unknownEntity !== undefined) {
      return noop(
        doc,
        `add_constraint failed: entity '${unknownEntity}' does not exist in the document; create it first.`,
      );
    }
    if (typeof constraint.value === 'string') {
      const syntaxError = expressionSyntaxError(constraint.value);
      if (syntaxError !== null) {
        return noop(
          doc,
          `add_constraint failed: value '${constraint.value}' is not a valid expression — ${syntaxError}.`,
        );
      }
    }

    const constraintId = id !== undefined && id.length > 0 ? id : nextId('con');

    if (constraintId in doc.constraints) {
      return noop(
        doc,
        `add_constraint: constraint id '${constraintId}' already exists — no change made.`,
      );
    }

    const newConstraint = { ...constraint, id: constraintId } as Constraint;

    const newDoc: CadDocument = {
      ...doc,
      constraints: { ...doc.constraints, [constraintId]: newConstraint },
      constraintOrder: [...doc.constraintOrder, constraintId],
    };

    return changed(
      newDoc,
      `add_constraint: added '${constraint.kind}' constraint ${constraintId} between entities '${constraint.a.entityId}' and '${constraint.b.entityId}'.`,
      [constraintId],
    );
  },
});

/**
 * @command delete_constraint
 * @pure
 * @layer core/commands
 * @affects removes 1 entry from document.constraints and document.constraintOrder
 * @invariant constraintOrder and constraints remain consistent after deletion
 * @failure unknown constraint id → no-op, affected:[]
 */
export const deleteConstraint = defineCommand({
  name: 'delete_constraint',
  annotations: { destructive: true },
  description:
    'Remove a constraint from the document by its id. ' +
    'Entity positions are NOT automatically updated; call solve_constraints if needed. ' +
    'If the constraint id does not exist the document is left unchanged.',
  params: z.object({
    id: z
      .string()
      .describe(
        'Id of the constraint to remove. Must match an existing constraint id exactly. ' +
          'Use describe_scene or list the document constraints to find valid ids.',
      ),
  }),
  run: (doc, { id }): CommandResult => {
    const constraint = Object.hasOwn(doc.constraints, id) ? doc.constraints[id] : undefined;
    if (!constraint)
      return noop(doc, `delete_constraint: constraint '${id}' does not exist — no change made.`);

    const newConstraints = { ...doc.constraints };
    delete newConstraints[id];

    const newDoc: CadDocument = {
      ...doc,
      constraints: newConstraints,
      constraintOrder: doc.constraintOrder.filter((cid) => cid !== id),
    };

    return report(newDoc, `delete_constraint: removed '${constraint.kind}' constraint '${id}'.`);
  },
});

/**
 * @command update_constraint
 * @pure
 * @layer core/commands
 * @affects updates 1 entry in document.constraints
 * @invariant only value, a, b may be patched; kind is immutable after creation
 * @failure unknown constraint id / invalid patch → no-op, affected:[]
 */
export const updateConstraint = defineCommand({
  name: 'update_constraint',
  description:
    'Update a mutable field of an existing constraint. ' +
    'Supported patch fields: "value" (dimensional constraints only — a number or parameter expression), ' +
    '"a" and "b" (EntityRef objects to retarget the constraint to different entity points). ' +
    'The constraint kind cannot be changed; delete and re-add to change the kind. ' +
    'Call solve_constraints after updating to propagate the new constraint value to entity positions.',
  params: z.object({
    id: z.string().describe('Id of the constraint to update. Must exist in the document.'),
    patch: z
      .object({
        value: z
          .union([z.string(), z.number()])
          .optional()
          .describe('New value for distance/angle constraints. Number or expression string.'),
        a: entityRef('Entity id.', 'Sub-point selector.')
          .optional()
          .describe('New first entity reference { entityId, kind? }.'),
        b: entityRef('Entity id.', 'Sub-point selector.')
          .optional()
          .describe('New second entity reference { entityId, kind? }.'),
      })
      .describe(
        'Fields to update. All fields are optional; omitted fields are not changed. ' +
          '"value": new numeric target or parameter expression for distance/angle constraints. ' +
          '"a" / "b": new EntityRef objects ({ entityId, kind? }) to retarget the constraint.',
      ),
  }),
  run: (doc, { id, patch }): CommandResult => {
    const existing = Object.hasOwn(doc.constraints, id) ? doc.constraints[id] : undefined;
    if (!existing)
      return noop(doc, `update_constraint: constraint '${id}' does not exist — no change made.`);

    const updates: Record<string, unknown> = {};

    for (const key of ['a', 'b'] as const) {
      const ref = patch[key];
      if (ref === undefined) continue;
      if (ref.entityId.length === 0) {
        return noop(
          doc,
          `update_constraint: patch.${key} is not a valid EntityRef — no change made.`,
        );
      }
      if (!Object.hasOwn(doc.entities, ref.entityId)) {
        return noop(
          doc,
          `update_constraint: patch.${key} entity '${ref.entityId}' does not exist in the document — no change made.`,
        );
      }
      updates[key] = ref;
    }

    if (patch.value !== undefined) {
      if (existing.kind !== 'distance' && existing.kind !== 'angle') {
        return noop(
          doc,
          `update_constraint: constraint '${id}' is kind '${existing.kind}' which has no 'value' field — no change made.`,
        );
      }
      if (typeof patch.value === 'string') {
        const syntaxError = expressionSyntaxError(patch.value);
        if (syntaxError !== null) {
          return noop(
            doc,
            `update_constraint: value '${patch.value}' is not a valid expression — ${syntaxError}. No change made.`,
          );
        }
      }
      updates['value'] = patch.value;
    }

    const updatedConstraint = { ...existing, ...updates } as Constraint;

    const newDoc: CadDocument = {
      ...doc,
      constraints: { ...doc.constraints, [id]: updatedConstraint },
    };

    const changedFields = Object.keys(updates).join(', ');
    return changed(
      newDoc,
      `update_constraint: updated constraint '${id}' (kind: '${existing.kind}'), changed fields: ${changedFields || 'none'}.`,
      [id],
    );
  },
});

/**
 * @command solve_constraints
 * @pure
 * @layer core/commands
 * @affects updates entity positions in document.entities to satisfy all constraints
 * @invariant all entity ids and kinds are preserved; only position XY is changed
 * @failure non-convergence → best-effort positions returned; converged:false in data
 */
export const solveConstraints = defineCommand({
  name: 'solve_constraints',
  description:
    'Run the constraint solver and update entity positions so that all declared ' +
    'constraints are satisfied. The solver works on the 2D XY plane (position Z is unchanged): ' +
    'point constraints (coincident, distance, tangent) move entity positions; angle, parallel and ' +
    'perpendicular turn line b about its midpoint (line a is the reference). It iterates up to 64 steps, stopping early when the ' +
    'total constraint residual is below 1e-8. Returns convergence info in data: ' +
    '{ residual: number, iterations: number, converged: boolean }. ' +
    'Non-convergent results are returned with the best-effort positions and converged:false. ' +
    'No parameters required.',
  params: z.object({}),
  run: (doc, _params): CommandResult => {
    const { document: newDoc, residual, iterations, converged } = runSolver(doc);

    const movedIds = doc.constraintOrder.flatMap((cid) => {
      const c = doc.constraints[cid];
      if (!c) return [];
      return [c.a.entityId, c.b.entityId];
    });
    const uniqueMoved = [...new Set(movedIds)].filter((id) => id in doc.entities);

    const summary = converged
      ? `solve_constraints: converged in ${iterations} iteration(s). Residual: ${residual.toExponential(3)}. ${uniqueMoved.length} entity/entities may have moved.`
      : `solve_constraints: did NOT converge after ${iterations} iteration(s). Residual: ${residual.toExponential(3)} (threshold 1e-8). Positions reflect best-effort result.`;

    return {
      document: newDoc,
      summary,
      affected: uniqueMoved,
      data: { residual, iterations, converged },
    };
  },
});
