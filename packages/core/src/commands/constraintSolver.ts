import type { CadDocument, Constraint, EntityRef, Vec3 } from '../model/types';
import { evaluateExpression } from './expression';

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
      const dot = da[0] * db[0] + da[1] * db[1]; // da · db
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
