/**
 * @affects constraints record and constraintOrder in CadDocument; solve_constraints also updates entity positions in entities record.
 * @invariant Constraint ids are unique; every stored constraint was consistent, non-redundant and non-flipping when it was added or edited
 *   (add_constraint / update_constraint refuse otherwise); dimensional kinds always carry `value`; unary kinds store `b` equal to `a`.
 * @failure Unknown constraint id / malformed input / conflicting, redundant or flipping constraint → no-op, affected:[]. Solver
 *   non-convergence → best-effort positions returned, converged:false in data.
 */

import { type CadDocument, type Constraint, CONSTRAINT_KINDS, DIMENSION_CONSTRAINT_KINDS } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { idOrNext, idTaken } from '../entity/explicitId';
import { constraintRefusal } from './constraintGuard';
import { constraintList, runSolver } from './solver/solve';
import { changed, noop, report } from '../noop';
import { expressionSyntaxError } from './expression';

/** Optional named point of a line / arc / circle (`EntityRef.kind`). */
const SUB_POINT = z.enum(['start', 'end', 'center', 'mid']).optional();

const entityRef = (entityIdDescription: string, kindDescription: string): z.ZodObject<{ entityId: z.ZodString; kind: typeof SUB_POINT }> =>
  z.object({ entityId: z.string().describe(entityIdDescription), kind: SUB_POINT.describe(kindDescription) });

const DIMENSION_KINDS: ReadonlySet<string> = new Set(DIMENSION_CONSTRAINT_KINDS);

const KIND_GUIDE =
  'Geometric kinds (no value): coincident (points a,b equal); parallel / perpendicular (lines a,b); ' +
  'tangent (line + circle/arc, or two circles/arcs; internal/external kept as drawn); ' +
  'horizontal / vertical (one line: a = b = the line id with no sub-point kind; or two points a,b at equal y / equal x); ' +
  'equal (two lines of equal length, or two circles/arcs of equal radius); concentric (two circles/arcs); ' +
  'collinear (line b lies on the infinite line a); midpoint (point a is the midpoint of line b); ' +
  'symmetric (points a,b mirror about "axis": a line id, or a point given with a sub-point kind); ' +
  'fix (point a stays where it is now; a curve id with no sub-point kind pins the whole curve); ' +
  'point_on_curve (point a lies on the infinite line, or full circle, b); ' +
  'curvature (continuity at a shared end: a = { entityId, kind: "start"|"end" } of the incoming line/arc, b the same on the outgoing one; ' +
  'G0 + G1, and G2 equal signed curvature for arc-arc; line-arc is G1 only, splines unsupported). ' +
  'Dimensional kinds (value required): distance (a-b point distance), angle (signed radians from line a to line b), ' +
  'radius / diameter (circle or arc a), aligned (point a-b distance, or a = b = a line id: its length), ' +
  'horizontal_distance / vertical_distance (|x| or |y| offset b - a, side kept as drawn), ' +
  'point_to_line (perpendicular distance from point a to line b, side kept), arc_sweep (arc a end-start angle, radians), ' +
  'arc_length (arc a), slot_length (center distance between the two end-cap circles/arcs a and b). ' +
  'Unary kinds take only "a" (b defaults to a).';

/** Semantic checks zod cannot express: non-empty entity ids; `value` on dimensional kinds; `axis` on symmetric. */
function validateConstraintShape(c: {
  kind: string;
  a: { entityId: string };
  b: { entityId: string };
  axis?: { entityId: string } | undefined;
  value?: unknown;
}): string | null {
  for (const key of ['a', 'b'] as const) {
    if (c[key].entityId.length === 0) return `constraint.${key} must be a valid EntityRef (has entityId)`;
  }
  if (DIMENSION_KINDS.has(c.kind) && c.value === undefined) return `constraint kind '${c.kind}' requires a numeric or string 'value' field`;
  if (c.kind === 'symmetric' && c.axis === undefined) return "constraint kind 'symmetric' requires an 'axis' reference";
  if (c.axis !== undefined && c.axis.entityId.length === 0) return 'constraint.axis must be a valid EntityRef (has entityId)';
  return null;
}

/**
 * @affects adds 1 entry to document.constraints and document.constraintOrder
 * @invariant constraint.id is unique within the document; the stored constraint is consistent with, and not implied by, the others
 * @failure malformed, conflicting, redundant or sketch-flipping constraint → no-op, affected:[] (summary names the constraint ids)
 */
export const addConstraint = defineCommand({
  name: 'add_constraint',
  description:
    'Add a geometric or dimensional constraint between sketch entities (lines, arcs, circles; other entities act as points at their position). ' +
    KIND_GUIDE +
    ' The sketch is checked first: a constraint that conflicts with the existing ones, that is already implied by them (redundant), ' +
    'or whose solution would mirror the sketch is refused with the conflicting constraint ids; the document is unchanged. ' +
    'Call solve_constraints afterward to move the entities (it also reports degrees of freedom). Returns the new constraint id in affected[0].',
  params: z.object({
    constraint: z
      .object({
        kind: z
          .enum(CONSTRAINT_KINDS)
          .describe('Constraint type; see the command description for the meaning and required references of each kind.'),
        a: entityRef('Id of the first entity.', 'Sub-point selector: start, end, center, or mid.').describe(
          'First entity reference. Minimum: { entityId: "<id>" }. ' +
            'Optional sub-point: { entityId: "<id>", kind: "start"|"end"|"center"|"mid" } ' +
            'to target a specific geometric point on a line, arc, or circle.',
        ),
        b: entityRef('Id of the second entity.', 'Sub-point selector: start, end, center, or mid.')
          .optional()
          .describe(
            'Second entity reference. Same shape as "a". Omit for unary kinds (horizontal/vertical on one line, fix, radius, diameter, ' +
              'arc_sweep, arc_length, aligned on one line): it then defaults to "a".',
          ),
        axis: entityRef('Id of the mirror line or point entity.', 'Sub-point selector; omit for a line axis.')
          .optional()
          .describe(
            'Mirror axis of "symmetric": { entityId: "<line>" } or a point { entityId, kind: "start"|"end"|"center"|"mid" }. Required for symmetric only.',
          ),
        value: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            'Required for dimensional kinds. A numeric literal ("10", "1.5708") or a parameter expression string ("width", "height / 2"). ' +
              'Lengths in document units; angle and arc_sweep in radians.',
          ),
      })
      .describe(
        'The constraint to add: "kind", "a", usually "b", and "value" for dimensions (a number or parameter expression string); "axis" for symmetric.',
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
    const full = { ...constraint, b: constraint.b ?? constraint.a };
    const err = validateConstraintShape(full);
    if (err !== null) return noop(doc, `add_constraint failed: ${err}.`);
    const unknownEntity = [full.a.entityId, full.b.entityId, ...(full.axis ? [full.axis.entityId] : [])].find(
      (entityId) => !Object.hasOwn(doc.entities, entityId),
    );
    if (unknownEntity !== undefined)
      return noop(doc, `add_constraint failed: entity '${unknownEntity}' does not exist in the document; create it first.`);
    if (typeof full.value === 'string') {
      const syntaxError = expressionSyntaxError(full.value);
      if (syntaxError !== null)
        return noop(doc, `add_constraint failed: value '${full.value}' is not a valid expression — ${syntaxError}.`);
    }
    const constraintId = idOrNext(id, 'con');
    if (idTaken(doc.constraints, constraintId))
      return noop(doc, `add_constraint: constraint id '${constraintId}' already exists — no change made.`);
    const newConstraint = { ...full, id: constraintId } as Constraint;
    const newDoc: CadDocument = {
      ...doc,
      constraints: { ...doc.constraints, [constraintId]: newConstraint },
      constraintOrder: [...doc.constraintOrder, constraintId],
    };
    const refusal = constraintRefusal(newDoc, constraintId, true);
    if (refusal !== null) return noop(doc, `add_constraint refused: ${refusal}. No change made.`);
    return changed(
      newDoc,
      `add_constraint: added '${full.kind}' constraint ${constraintId} between entities '${full.a.entityId}' and '${full.b.entityId}'.`,
      [constraintId],
    );
  },
});

/**
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
    if (!constraint) return noop(doc, `delete_constraint: constraint '${id}' does not exist — no change made.`);
    const newConstraints = { ...doc.constraints };
    delete newConstraints[id];
    const newDoc: CadDocument = { ...doc, constraints: newConstraints, constraintOrder: doc.constraintOrder.filter((cid) => cid !== id) };
    return report(newDoc, `delete_constraint: removed '${constraint.kind}' constraint '${id}'.`);
  },
});

/**
 * @affects updates 1 entry in document.constraints
 * @invariant only value, a, b, axis may be patched; kind is immutable after creation; the edited constraint passes the add_constraint checks
 * @failure unknown constraint id / invalid patch / conflicting, redundant or flipping result → no-op, affected:[]
 */
export const updateConstraint = defineCommand({
  name: 'update_constraint',
  description:
    'Update a mutable field of an existing constraint. ' +
    'Supported patch fields: "value" (dimensional constraints only — a number or parameter expression), ' +
    '"a" and "b" (EntityRef objects to retarget the constraint to different entity points), "axis" (symmetric only). ' +
    'The constraint kind cannot be changed; delete and re-add to change the kind. ' +
    'The edited sketch is checked like add_constraint: an edit that conflicts, becomes redundant or would flip the sketch ' +
    '(for example a signed angle changing side) is refused with the constraint ids involved. ' +
    'Call solve_constraints after updating to propagate the new constraint value to entity positions.',
  params: z.object({
    id: z.string().describe('Id of the constraint to update. Must exist in the document.'),
    patch: z
      .object({
        value: z
          .union([z.string(), z.number()])
          .optional()
          .describe('New value for dimensional constraints (distance, angle, radius, ...). Number or expression string.'),
        a: entityRef('Entity id.', 'Sub-point selector.').optional().describe('New first entity reference { entityId, kind? }.'),
        b: entityRef('Entity id.', 'Sub-point selector.').optional().describe('New second entity reference { entityId, kind? }.'),
        axis: entityRef('Entity id.', 'Sub-point selector.').optional().describe('New mirror axis reference (symmetric only).'),
      })
      .describe(
        'Fields to update. All fields are optional; omitted fields are not changed. ' +
          '"value": new numeric target or parameter expression for dimensional constraints. ' +
          '"a" / "b" / "axis": new EntityRef objects ({ entityId, kind? }) to retarget the constraint.',
      ),
  }),
  run: (doc, { id, patch }): CommandResult => {
    const existing = Object.hasOwn(doc.constraints, id) ? doc.constraints[id] : undefined;
    if (!existing) return noop(doc, `update_constraint: constraint '${id}' does not exist — no change made.`);
    const updates: Record<string, unknown> = {};
    for (const key of ['a', 'b', 'axis'] as const) {
      const ref = patch[key];
      if (ref === undefined) continue;
      if (key === 'axis' && existing.kind !== 'symmetric')
        return noop(doc, `update_constraint: constraint '${id}' is kind '${existing.kind}' which has no 'axis' — no change made.`);
      if (ref.entityId.length === 0) return noop(doc, `update_constraint: patch.${key} is not a valid EntityRef — no change made.`);
      if (!Object.hasOwn(doc.entities, ref.entityId))
        return noop(doc, `update_constraint: patch.${key} entity '${ref.entityId}' does not exist in the document — no change made.`);
      updates[key] = ref;
    }
    if (patch.value !== undefined) {
      if (!DIMENSION_KINDS.has(existing.kind))
        return noop(doc, `update_constraint: constraint '${id}' is kind '${existing.kind}' which has no 'value' field — no change made.`);
      if (typeof patch.value === 'string') {
        const syntaxError = expressionSyntaxError(patch.value);
        if (syntaxError !== null)
          return noop(doc, `update_constraint: value '${patch.value}' is not a valid expression — ${syntaxError}. No change made.`);
      }
      updates['value'] = patch.value;
    }
    const updatedConstraint = { ...existing, ...updates } as Constraint;
    const newDoc: CadDocument = { ...doc, constraints: { ...doc.constraints, [id]: updatedConstraint } };
    const refusal = constraintRefusal(newDoc, id, false);
    if (refusal !== null) return noop(doc, `update_constraint refused: ${refusal}. No change made.`);
    const changedFields = Object.keys(updates).join(', ');
    return changed(
      newDoc,
      `update_constraint: updated constraint '${id}' (kind: '${existing.kind}'), changed fields: ${changedFields || 'none'}.`,
      [id],
    );
  },
});

/**
 * @affects updates entity positions in document.entities to satisfy all constraints
 * @invariant all entity ids and kinds are preserved; only XY geometry (line ends, centers, radii, arc angles, positions) changes
 * @failure non-convergence → best-effort positions returned; converged:false in data
 */
export const solveConstraints = defineCommand({
  name: 'solve_constraints',
  description:
    'Run the constraint solver (constructive pass on fixed points and dimension chains, then damped Levenberg-Marquardt) and update ' +
    'entity geometry so that all declared constraints are satisfied, keeping the branch the sketch already has. The solver works on the ' +
    '2D XY plane (position Z is unchanged); lines, circles and arcs move by their own endpoints/centers/radii/angles, other entities by position. ' +
    'Returns in data: { residual, iterations, converged, dof, fullyConstrained, isFullyConstrained, skipped } where dof = unknowns minus ' +
    'rank of the constraint Jacobian over every line/arc/circle (a free line has 4), fullyConstrained lists the entity ids that no ' +
    'constraint leaves free to move, and skipped lists constraints that could not be evaluated (wrong entity kinds, unknown parameter). ' +
    'Non-convergent results are returned with the best-effort positions and converged:false. No parameters required.',
  params: z.object({}),
  run: (doc, _params): CommandResult => {
    const outcome = runSolver(doc);
    const { residual, iterations, converged, dof, fullyConstrained, skipped } = outcome;
    const touched = constraintList(doc).flatMap((c) => [c.a.entityId, c.b.entityId, ...('axis' in c ? [c.axis.entityId] : [])]);
    const uniqueMoved = [...new Set(touched)].filter((id) => id in doc.entities);
    const status = `${dof} degree(s) of freedom; ${fullyConstrained.length} entit${fullyConstrained.length === 1 ? 'y' : 'ies'} fully constrained.`;
    const summary = converged
      ? `solve_constraints: converged in ${iterations} iteration(s). Residual: ${residual.toExponential(3)}. ${uniqueMoved.length} entity/entities may have moved. ${status}`
      : `solve_constraints: did NOT converge after ${iterations} iteration(s). Residual: ${residual.toExponential(3)}. Positions reflect best-effort result. ${status}`;
    return {
      document: outcome.document,
      summary,
      affected: uniqueMoved,
      data: { residual, iterations, converged, dof, fullyConstrained, isFullyConstrained: dof === 0, skipped },
    };
  },
});
