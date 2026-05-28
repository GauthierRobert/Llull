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

import type { CadDocument, Constraint, ConstraintKind, EntityRef, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';
import { evaluateExpression } from './expression';

// ---------------------------------------------------------------------------
// Internal geometry helpers
// ---------------------------------------------------------------------------

/** Resolve a 2D point [x, y] from an EntityRef. Returns null when the entity is missing. */
function resolvePoint(doc: CadDocument, ref: EntityRef): [number, number] | null {
  const entity = doc.entities[ref.entityId];
  if (!entity) return null;

  const [px, py] = entity.position;

  // Distinguish named sub-points for line/arc entities.
  if ('kind' in ref) {
    const k = entity.kind;
    const subKind = ref.kind;

    if (k === 'line') {
      const line = entity as { start: readonly [number, number]; end: readonly [number, number] };
      if (subKind === 'start') return [line.start[0] + px, line.start[1] + py];
      if (subKind === 'end') return [line.end[0] + px, line.end[1] + py];
      if (subKind === 'center' || subKind === 'mid') {
        return [(line.start[0] + line.end[0]) / 2 + px, (line.start[1] + line.end[1]) / 2 + py];
      }
    }

    if (k === 'arc' || k === 'circle') {
      const circ = entity as { center: readonly [number, number] };
      if (subKind === 'center') return [circ.center[0] + px, circ.center[1] + py];
    }
  }

  // Default: use entity position projected to XY.
  return [px, py];
}

/**
 * Resolve the 2D direction vector of a line entity. Returns null when not applicable.
 * Normalises to unit length; returns [1, 0] on degenerate (zero-length) line.
 */
function resolveDirection(doc: CadDocument, ref: EntityRef): [number, number] | null {
  const entity = doc.entities[ref.entityId];
  if (!entity) return null;
  if (entity.kind !== 'line') return null;
  const line = entity as { start: readonly [number, number]; end: readonly [number, number] };
  const dx = line.end[0] - line.start[0];
  const dy = line.end[1] - line.start[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-12) return [1, 0];
  return [dx / len, dy / len];
}

/** Get the radius of a circle or arc entity; null for other kinds. */
function resolveRadius(doc: CadDocument, ref: EntityRef): number | null {
  const entity = doc.entities[ref.entityId];
  if (!entity) return null;
  if (entity.kind === 'circle' || entity.kind === 'arc') {
    return (entity as { radius: number }).radius;
  }
  return null;
}

/**
 * Resolve a dimensional value which may be a plain number or a parameter
 * expression referencing the document's parameter table.
 *
 * Returns the numeric value on success, or null when the expression cannot be
 * resolved (unknown parameter / parse error).
 */
function resolveValue(doc: CadDocument, v: number | string): number | null {
  if (typeof v === 'number') return v;
  // Build env from current parameter values.
  const env: Record<string, number> = {};
  for (const [name, param] of Object.entries(doc.parameters)) {
    env[name] = param.value;
  }
  const result = evaluateExpression(v, env);
  return result.ok ? result.value : null;
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/** Per-entity 2D position deltas accumulated in one solver iteration. */
type Delta = Map<string, [number, number]>;

/**
 * Compute the gradient contribution of one constraint and accumulate the position
 * delta into `deltas`. Each entity in the constraint receives a push that reduces
 * the constraint error.
 *
 * All movements are 2D (XY plane) — the solver only adjusts entity position[0] and
 * position[1]. Z is preserved.
 *
 * Returns the squared error term for this constraint (for convergence check).
 */
function applyConstraintGradient(
  doc: CadDocument,
  c: Constraint,
  deltas: Delta,
  stepSize: number,
): number {
  function addDelta(entityId: string, dx: number, dy: number): void {
    const existing = deltas.get(entityId) ?? [0, 0];
    deltas.set(entityId, [existing[0] + dx, existing[1] + dy]);
  }

  switch (c.kind) {
    case 'coincident': {
      const pa = resolvePoint(doc, c.a);
      const pb = resolvePoint(doc, c.b);
      if (!pa || !pb) return 0;
      const dx = pa[0] - pb[0];
      const dy = pa[1] - pb[1];
      const err2 = dx * dx + dy * dy;
      // Gradient of ||pa - pb||²: push a toward b, b toward a.
      addDelta(c.a.entityId, -stepSize * dx, -stepSize * dy);
      addDelta(c.b.entityId, stepSize * dx, stepSize * dy);
      return err2;
    }

    case 'distance': {
      const pa = resolvePoint(doc, c.a);
      const pb = resolvePoint(doc, c.b);
      if (!pa || !pb) return 0;
      const target = resolveValue(doc, c.value);
      if (target === null) return 0;
      const dx = pa[0] - pb[0];
      const dy = pa[1] - pb[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-12) return 0;
      const err = dist - target;
      const err2 = err * err;
      // Gradient of (dist - target)²: move each entity half the signed error.
      const ux = dx / dist;
      const uy = dy / dist;
      addDelta(c.a.entityId, -stepSize * err * ux, -stepSize * err * uy);
      addDelta(c.b.entityId, stepSize * err * ux, stepSize * err * uy);
      return err2;
    }

    case 'angle': {
      const da = resolveDirection(doc, c.a);
      const db = resolveDirection(doc, c.b);
      if (!da || !db) return 0;
      const target = resolveValue(doc, c.value);
      if (target === null) return 0;
      // Angle from da to db (z-component of cross product + dot product).
      const cross = da[0] * db[1] - da[1] * db[0]; // da × db
      const dot = da[0] * db[0] + da[1] * db[1];   // da · db
      const angle = Math.atan2(cross, dot);
      const err = angle - target;
      const err2 = err * err;
      // Move entity b's position to rotate its direction (approximate gradient).
      // We perturb the entity position to change the line direction.
      addDelta(c.b.entityId, -stepSize * err * da[1], stepSize * err * da[0]);
      return err2;
    }

    case 'parallel': {
      const da = resolveDirection(doc, c.a);
      const db = resolveDirection(doc, c.b);
      if (!da || !db) return 0;
      // Error: (da × db)²  — the z-component of the cross product.
      const cross = da[0] * db[1] - da[1] * db[0];
      const err2 = cross * cross;
      // Gradient: rotate b direction toward a's direction.
      addDelta(c.b.entityId, -stepSize * cross * da[1], stepSize * cross * da[0]);
      return err2;
    }

    case 'perpendicular': {
      const da = resolveDirection(doc, c.a);
      const db = resolveDirection(doc, c.b);
      if (!da || !db) return 0;
      // Error: (da · db)².
      const dot = da[0] * db[0] + da[1] * db[1];
      const err2 = dot * dot;
      addDelta(c.b.entityId, -stepSize * dot * da[0], -stepSize * dot * da[1]);
      return err2;
    }

    case 'tangent': {
      const rA = resolveRadius(doc, c.a);
      const rB = resolveRadius(doc, c.b);

      if (rA !== null && rB !== null) {
        // Circle/arc ↔ circle/arc: external tangency.
        const pa = resolvePoint(doc, c.a);
        const pb = resolvePoint(doc, c.b);
        if (!pa || !pb) return 0;
        const dx = pa[0] - pb[0];
        const dy = pa[1] - pb[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1e-12) return 0;
        const target = rA + rB;
        const err = dist - target;
        const err2 = err * err;
        const ux = dx / dist;
        const uy = dy / dist;
        addDelta(c.a.entityId, -stepSize * err * ux, -stepSize * err * uy);
        addDelta(c.b.entityId, stepSize * err * ux, stepSize * err * uy);
        return err2;
      }

      // Line ↔ circle: |distance from circle center to line| == radius.
      // Determine which is the circle and which is the line.
      const circleRef = rA !== null ? c.a : rB !== null ? c.b : null;
      const lineRef = circleRef === c.a ? c.b : c.a;
      if (circleRef === null) return 0;

      const radius = rA !== null ? rA : rB!;
      const pc = resolvePoint(doc, circleRef);
      const lineEntity = doc.entities[lineRef.entityId];
      if (!pc || !lineEntity || lineEntity.kind !== 'line') return 0;
      const le = lineEntity as { start: readonly [number, number]; end: readonly [number, number] };
      const [lpx, lpy] = lineEntity.position;
      const ax = le.start[0] + lpx;
      const ay = le.start[1] + lpy;
      const bx = le.end[0] + lpx;
      const by = le.end[1] + lpy;
      // Line direction.
      const ldx = bx - ax;
      const ldy = by - ay;
      const llen = Math.sqrt(ldx * ldx + ldy * ldy);
      if (llen < 1e-12) return 0;
      // Normal to the line.
      const nx = -ldy / llen;
      const ny = ldx / llen;
      // Signed distance from pc to line.
      const d = (pc[0] - ax) * nx + (pc[1] - ay) * ny;
      const err = Math.abs(d) - radius;
      const err2 = err * err;
      const sign = d >= 0 ? 1 : -1;
      addDelta(circleRef.entityId, -stepSize * err * sign * nx, -stepSize * err * sign * ny);
      return err2;
    }
  }
}

/**
 * Run the constraint solver and return a new document with updated entity positions.
 *
 * The solver is a 2D projected gradient descent / Newton-style iteration:
 * - Only entity.position[0] and position[1] are adjusted (2D XY plane).
 * - position[2] (Z) is preserved.
 * - Iterates up to MAX_ITERATIONS steps, stopping early when residual < RESIDUAL_THRESHOLD
 *   or step delta < DELTA_THRESHOLD.
 *
 * @pure — never mutates `doc`.
 */
export function runSolver(doc: CadDocument): {
  document: CadDocument;
  residual: number;
  iterations: number;
  converged: boolean;
} {
  const MAX_ITERATIONS = 64;
  const RESIDUAL_THRESHOLD = 1e-8;
  const DELTA_THRESHOLD = 1e-10;
  const BASE_STEP = 0.1;

  const constraints = Object.values(doc.constraints);
  if (constraints.length === 0) {
    return { document: doc, residual: 0, iterations: 0, converged: true };
  }

  // Working copy of positions keyed by entity id.
  const positions = new Map<string, Vec3>();
  for (const [id, entity] of Object.entries(doc.entities)) {
    positions.set(id, entity.position);
  }

  /** Build a document with the current working positions applied. */
  function buildDoc(): CadDocument {
    const newEntities: CadDocument['entities'] = {};
    for (const [id, entity] of Object.entries(doc.entities)) {
      const pos = positions.get(id) ?? entity.position;
      newEntities[id] = { ...entity, position: pos };
    }
    return { ...doc, entities: newEntities };
  }

  let residual = Infinity;
  let iterations = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const workingDoc = buildDoc();
    const deltas: Delta = new Map();
    let totalError = 0;

    for (const c of constraints) {
      totalError += applyConstraintGradient(workingDoc, c, deltas, BASE_STEP);
    }

    residual = totalError;
    iterations = iter + 1;

    if (residual < RESIDUAL_THRESHOLD) break;

    // Apply deltas.
    let maxDelta = 0;
    for (const [id, [dx, dy]] of deltas) {
      const pos = positions.get(id);
      if (!pos) continue;
      const newPos: Vec3 = [pos[0] + dx, pos[1] + dy, pos[2]];
      positions.set(id, newPos);
      maxDelta = Math.max(maxDelta, Math.abs(dx), Math.abs(dy));
    }

    if (maxDelta < DELTA_THRESHOLD) break;
  }

  const converged = residual < RESIDUAL_THRESHOLD;
  return { document: buildDoc(), residual, iterations, converged };
}

// ---------------------------------------------------------------------------
// Validation helpers for constraint shape
// ---------------------------------------------------------------------------

const VALID_CONSTRAINT_KINDS: ReadonlySet<string> = new Set<ConstraintKind>([
  'coincident', 'parallel', 'perpendicular', 'tangent', 'distance', 'angle',
]);

function isEntityRef(v: unknown): v is EntityRef {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['entityId'] !== 'string' || obj['entityId'].length === 0) return false;
  if ('kind' in obj) {
    const k = obj['kind'];
    if (k !== 'start' && k !== 'end' && k !== 'center' && k !== 'mid') return false;
  }
  return true;
}

function isValidValue(v: unknown): v is number | string {
  return typeof v === 'number' || typeof v === 'string';
}

/** Validate a raw constraint object. Returns an error string or null on success. */
function validateConstraintShape(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'constraint is not an object';
  const obj = v as Record<string, unknown>;
  const kind = obj['kind'];
  if (typeof kind !== 'string' || !VALID_CONSTRAINT_KINDS.has(kind)) {
    return `unknown constraint kind '${String(kind)}'`;
  }
  if (!isEntityRef(obj['a'])) return `constraint.a must be a valid EntityRef (has entityId)`;
  if (!isEntityRef(obj['b'])) return `constraint.b must be a valid EntityRef (has entityId)`;
  if (kind === 'distance' || kind === 'angle') {
    if (!isValidValue(obj['value'])) {
      return `constraint kind '${kind}' requires a numeric or string 'value' field`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// add_constraint
// ---------------------------------------------------------------------------

interface AddConstraintParams {
  constraint: {
    kind: string;
    a: { entityId: string; kind?: string };
    b: { entityId: string; kind?: string };
    value?: number | string;
  };
  id?: string;
}

/**
 * @command add_constraint
 * @pure
 * @layer core/commands
 * @affects adds 1 entry to document.constraints and document.constraintOrder
 * @invariant constraint.id is unique within the document
 * @failure malformed constraint shape → no-op, affected:[]
 */
export const addConstraint: CommandDefinition<AddConstraintParams> = {
  name: 'add_constraint',
  description:
    'Add a geometric or dimensional constraint between two entity references. ' +
    'Geometric kinds (coincident, parallel, perpendicular, tangent) impose a ' +
    'positional or directional relationship with no numeric target. ' +
    'Dimensional kinds (distance, angle) require a numeric "value" field. ' +
    'Call solve_constraints afterward to update entity positions. ' +
    'Returns the new constraint id in affected[0].',
  paramsSchema: {
    type: 'object',
    properties: {
      constraint: {
        type: 'object',
        description:
          'The constraint to add. Must have: "kind" (one of coincident|parallel|perpendicular|tangent|distance|angle), ' +
          '"a" (EntityRef: { entityId: string, kind?: "start"|"end"|"center"|"mid" }), ' +
          '"b" (EntityRef: same shape). ' +
          'Dimensional kinds also require "value": a number or parameter expression string.',
        properties: {
          kind: {
            type: 'string',
            description:
              'Constraint type. Geometric: "coincident" (two points share a location), ' +
              '"parallel" (two lines are parallel), "perpendicular" (two lines are at 90°), ' +
              '"tangent" (line tangent to circle/arc, or two arcs externally tangent). ' +
              'Dimensional: "distance" (distance between two points equals value), ' +
              '"angle" (angle between two line directions equals value in radians).',
            enum: ['coincident', 'parallel', 'perpendicular', 'tangent', 'distance', 'angle'],
          },
          a: {
            type: 'object',
            description:
              'First entity reference. Minimum: { entityId: "<id>" }. ' +
              'Optional sub-point: { entityId: "<id>", kind: "start"|"end"|"center"|"mid" } ' +
              'to target a specific geometric point on a line, arc, or circle.',
            properties: {
              entityId: { type: 'string', description: 'Id of the first entity.' },
              kind: {
                type: 'string',
                description: 'Sub-point selector: start, end, center, or mid.',
                enum: ['start', 'end', 'center', 'mid'],
              },
            },
          },
          b: {
            type: 'object',
            description:
              'Second entity reference. Same shape as "a". ' +
              '{ entityId: "<id>" } or { entityId: "<id>", kind: "start"|"end"|"center"|"mid" }.',
            properties: {
              entityId: { type: 'string', description: 'Id of the second entity.' },
              kind: {
                type: 'string',
                description: 'Sub-point selector: start, end, center, or mid.',
                enum: ['start', 'end', 'center', 'mid'],
              },
            },
          },
          value: {
            type: 'string',
            description:
              'Required for dimensional constraints (distance, angle). ' +
              'A numeric literal ("10", "1.5708") or a parameter expression string ' +
              '("width", "height / 2"). Angle is in radians.',
          },
        },
      },
      id: {
        type: 'string',
        description:
          'Optional explicit constraint id. When omitted a unique id is generated. ' +
          'If the id already exists in the document the command is a no-op.',
      },
    },
    required: ['constraint'],
  },
  run: (doc, { constraint, id }): CommandResult => {
    const err = validateConstraintShape(constraint);
    if (err !== null) {
      return {
        document: doc,
        summary: `add_constraint failed: ${err}.`,
        affected: [],
      };
    }

    const constraintId = (typeof id === 'string' && id.length > 0) ? id : nextId('con');

    if (constraintId in doc.constraints) {
      return {
        document: doc,
        summary: `add_constraint: constraint id '${constraintId}' already exists — no change made.`,
        affected: [],
      };
    }

    // Build the typed Constraint. validateConstraintShape already confirmed the shape.
    const newConstraint = { ...constraint, id: constraintId } as Constraint;

    const newDoc: CadDocument = {
      ...doc,
      constraints: { ...doc.constraints, [constraintId]: newConstraint },
      constraintOrder: [...doc.constraintOrder, constraintId],
    };

    return {
      document: newDoc,
      summary: `add_constraint: added '${constraint.kind}' constraint ${constraintId} between entities '${constraint.a.entityId}' and '${constraint.b.entityId}'.`,
      affected: [constraintId],
    };
  },
};

// ---------------------------------------------------------------------------
// delete_constraint
// ---------------------------------------------------------------------------

interface DeleteConstraintParams {
  id: string;
}

/**
 * @command delete_constraint
 * @pure
 * @layer core/commands
 * @affects removes 1 entry from document.constraints and document.constraintOrder
 * @invariant constraintOrder and constraints remain consistent after deletion
 * @failure unknown constraint id → no-op, affected:[]
 */
export const deleteConstraint: CommandDefinition<DeleteConstraintParams> = {
  name: 'delete_constraint',
  annotations: { destructive: true },
  description:
    'Remove a constraint from the document by its id. ' +
    'Entity positions are NOT automatically updated; call solve_constraints if needed. ' +
    'If the constraint id does not exist the document is left unchanged.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Id of the constraint to remove. Must match an existing constraint id exactly. ' +
          'Use describe_scene or list the document constraints to find valid ids.',
      },
    },
    required: ['id'],
  },
  run: (doc, { id }): CommandResult => {
    if (typeof id !== 'string' || !(id in doc.constraints)) {
      return {
        document: doc,
        summary: `delete_constraint: constraint '${String(id)}' does not exist — no change made.`,
        affected: [],
      };
    }

    const constraint = doc.constraints[id]!;
    const newConstraints = { ...doc.constraints };
    delete newConstraints[id];

    const newDoc: CadDocument = {
      ...doc,
      constraints: newConstraints,
      constraintOrder: doc.constraintOrder.filter((cid) => cid !== id),
    };

    return {
      document: newDoc,
      summary: `delete_constraint: removed '${constraint.kind}' constraint '${id}'.`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// update_constraint
// ---------------------------------------------------------------------------

interface UpdateConstraintParams {
  id: string;
  patch: {
    value?: number | string;
    a?: { entityId: string; kind?: string };
    b?: { entityId: string; kind?: string };
  };
}

/**
 * @command update_constraint
 * @pure
 * @layer core/commands
 * @affects updates 1 entry in document.constraints
 * @invariant only value, a, b may be patched; kind is immutable after creation
 * @failure unknown constraint id / invalid patch → no-op, affected:[]
 */
export const updateConstraint: CommandDefinition<UpdateConstraintParams> = {
  name: 'update_constraint',
  description:
    'Update a mutable field of an existing constraint. ' +
    'Supported patch fields: "value" (dimensional constraints only — a number or parameter expression), ' +
    '"a" and "b" (EntityRef objects to retarget the constraint to different entity points). ' +
    'The constraint kind cannot be changed; delete and re-add to change the kind. ' +
    'Call solve_constraints after updating to propagate the new constraint value to entity positions.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the constraint to update. Must exist in the document.',
      },
      patch: {
        type: 'object',
        description:
          'Fields to update. All fields are optional; omitted fields are not changed. ' +
          '"value": new numeric target or parameter expression for distance/angle constraints. ' +
          '"a" / "b": new EntityRef objects ({ entityId, kind? }) to retarget the constraint.',
        properties: {
          value: {
            type: 'string',
            description: 'New value for distance/angle constraints. Number or expression string.',
          },
          a: {
            type: 'object',
            description: 'New first entity reference { entityId, kind? }.',
            properties: {
              entityId: { type: 'string', description: 'Entity id.' },
              kind: {
                type: 'string',
                description: 'Sub-point selector.',
                enum: ['start', 'end', 'center', 'mid'],
              },
            },
          },
          b: {
            type: 'object',
            description: 'New second entity reference { entityId, kind? }.',
            properties: {
              entityId: { type: 'string', description: 'Entity id.' },
              kind: {
                type: 'string',
                description: 'Sub-point selector.',
                enum: ['start', 'end', 'center', 'mid'],
              },
            },
          },
        },
      },
    },
    required: ['id', 'patch'],
  },
  run: (doc, { id, patch }): CommandResult => {
    if (typeof id !== 'string' || !(id in doc.constraints)) {
      return {
        document: doc,
        summary: `update_constraint: constraint '${String(id)}' does not exist — no change made.`,
        affected: [],
      };
    }

    if (typeof patch !== 'object' || patch === null) {
      return {
        document: doc,
        summary: `update_constraint: 'patch' must be an object — no change made.`,
        affected: [],
      };
    }

    const existing = doc.constraints[id]!;
    const updates: Partial<Constraint> = {};

    if ('a' in patch && patch.a !== undefined) {
      if (!isEntityRef(patch.a)) {
        return {
          document: doc,
          summary: `update_constraint: patch.a is not a valid EntityRef — no change made.`,
          affected: [],
        };
      }
      (updates as Record<string, unknown>)['a'] = patch.a;
    }

    if ('b' in patch && patch.b !== undefined) {
      if (!isEntityRef(patch.b)) {
        return {
          document: doc,
          summary: `update_constraint: patch.b is not a valid EntityRef — no change made.`,
          affected: [],
        };
      }
      (updates as Record<string, unknown>)['b'] = patch.b;
    }

    if ('value' in patch && patch.value !== undefined) {
      if (existing.kind !== 'distance' && existing.kind !== 'angle') {
        return {
          document: doc,
          summary: `update_constraint: constraint '${id}' is kind '${existing.kind}' which has no 'value' field — no change made.`,
          affected: [],
        };
      }
      if (!isValidValue(patch.value)) {
        return {
          document: doc,
          summary: `update_constraint: patch.value must be a number or string — no change made.`,
          affected: [],
        };
      }
      (updates as Record<string, unknown>)['value'] = patch.value;
    }

    const updatedConstraint = { ...existing, ...updates } as Constraint;

    const newDoc: CadDocument = {
      ...doc,
      constraints: { ...doc.constraints, [id]: updatedConstraint },
    };

    const changedFields = Object.keys(updates).join(', ');
    return {
      document: newDoc,
      summary: `update_constraint: updated constraint '${id}' (kind: '${existing.kind}'), changed fields: ${changedFields || 'none'}.`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// solve_constraints
// ---------------------------------------------------------------------------

/**
 * @command solve_constraints
 * @pure
 * @layer core/commands
 * @affects updates entity positions in document.entities to satisfy all constraints
 * @invariant all entity ids and kinds are preserved; only position XY is changed
 * @failure non-convergence → best-effort positions returned; converged:false in data
 */
export const solveConstraints: CommandDefinition<Record<string, never>> = {
  name: 'solve_constraints',
  description:
    'Run the constraint solver and update entity positions so that all declared ' +
    'constraints are satisfied. The solver uses gradient descent on the 2D XY plane ' +
    '(position Z is unchanged). It iterates up to 64 steps, stopping early when the ' +
    'total constraint residual is below 1e-8. Returns convergence info in data: ' +
    '{ residual: number, iterations: number, converged: boolean }. ' +
    'Non-convergent results are returned with the best-effort positions and converged:false. ' +
    'No parameters required.',
  paramsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
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
};
