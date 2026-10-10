import type { CadDocument, Constraint, EntityRef, Vec2, Vec3 } from '../model/types';
import { cross2, dot2, len2 } from '../lib/vec2';
import { resolveNumeric } from './expression';

type Point = readonly [number, number];

/** Resolve a 2D point [x, y] from an EntityRef. Returns null when the entity is missing. */
function resolvePoint(doc: CadDocument, ref: EntityRef): Point | null {
  const entity = doc.entities[ref.entityId];
  if (!entity) return null;

  const [px, py] = entity.position;
  const subKind = 'kind' in ref ? ref.kind : undefined;

  // Named sub-points of line/arc/circle entities; anything else falls back to the entity position.
  if (entity.kind === 'line') {
    const { start, end } = entity;
    if (subKind === 'start') return [start[0] + px, start[1] + py];
    if (subKind === 'end') return [end[0] + px, end[1] + py];
    if (subKind === 'center' || subKind === 'mid')
      return [(start[0] + end[0]) / 2 + px, (start[1] + end[1]) / 2 + py];
  }

  if ((entity.kind === 'arc' || entity.kind === 'circle') && subKind === 'center')
    return [entity.center[0] + px, entity.center[1] + py];

  return [px, py];
}

/**
 * Resolve the 2D direction vector of a line entity. Returns null when not applicable.
 * Normalises to unit length; returns [1, 0] on degenerate (zero-length) line.
 */
function resolveDirection(doc: CadDocument, ref: EntityRef): [number, number] | null {
  const entity = doc.entities[ref.entityId];
  if (entity?.kind !== 'line') return null;
  const dx = entity.end[0] - entity.start[0];
  const dy = entity.end[1] - entity.start[1];
  const len = len2([dx, dy]);
  if (len < 1e-12) return [1, 0];
  return [dx / len, dy / len];
}

/** Get the radius of a circle or arc entity; null for other kinds. */
function resolveRadius(doc: CadDocument, ref: EntityRef): number | null {
  const entity = doc.entities[ref.entityId];
  return entity?.kind === 'circle' || entity?.kind === 'arc' ? entity.radius : null;
}

/** Per-entity 2D position deltas accumulated in one solver iteration. */
type Delta = Map<string, [number, number]>;

/** Per-line rotation (radians, CCW, about the line midpoint) accumulated in one solver iteration. */
type Turns = Map<string, number>;

/** Fraction of the angular error corrected per iteration (keeps coupled constraints stable). */
const TURN_RELAXATION = 0.5;

/** `angle` wrapped into (-π, π]. */
function wrapAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

/** Smallest signed distance from `angle` to the nearest multiple of `period` (offset by `phase`). */
function distanceToLattice(angle: number, phase: number, period: number): number {
  const shifted = angle - phase;
  return shifted - period * Math.round(shifted / period);
}

/** Line endpoints rotated by `turn` about their midpoint. */
function turnedLine(start: Vec2, end: Vec2, turn: number): { start: Vec2; end: Vec2 } {
  const mx = (start[0] + end[0]) / 2;
  const my = (start[1] + end[1]) / 2;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const rotate = (p: Vec2): Vec2 => [
    mx + (p[0] - mx) * cos - (p[1] - my) * sin,
    my + (p[0] - mx) * sin + (p[1] - my) * cos,
  ];
  return { start: rotate(start), end: rotate(end) };
}

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
  turns: Turns,
  stepSize: number,
): number {
  function addTurn(entityId: string, angle: number): void {
    turns.set(entityId, (turns.get(entityId) ?? 0) + angle);
  }

  function addDelta(entityId: string, dx: number, dy: number): void {
    const existing = deltas.get(entityId) ?? [0, 0];
    deltas.set(entityId, [existing[0] + dx, existing[1] + dy]);
  }

  /** Gradient of (|pa - pb| - target)²; returns the squared error. */
  function pullToDistance(
    idA: string,
    idB: string,
    pa: readonly [number, number],
    pb: readonly [number, number],
    target: number,
  ): number {
    const dx = pa[0] - pb[0];
    const dy = pa[1] - pb[1];
    const dist = len2([dx, dy]);
    if (dist < 1e-12) return 0;
    const err = dist - target;
    const ux = dx / dist;
    const uy = dy / dist;
    addDelta(idA, -stepSize * err * ux, -stepSize * err * uy);
    addDelta(idB, stepSize * err * ux, stepSize * err * uy);
    return err * err;
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
      const target = resolveNumeric(c.value, doc.parameters);
      if (target === null) return 0;
      return pullToDistance(c.a.entityId, c.b.entityId, pa, pb, target);
    }

    case 'angle': {
      const da = resolveDirection(doc, c.a);
      const db = resolveDirection(doc, c.b);
      if (!da || !db) return 0;
      const target = resolveNumeric(c.value, doc.parameters);
      if (target === null) return 0;
      const err = wrapAngle(Math.atan2(cross2(da, db), dot2(da, db)) - target);
      // Line b turns about its midpoint (translating a line never changes its direction).
      addTurn(c.b.entityId, -TURN_RELAXATION * err);
      return err * err;
    }

    case 'parallel': {
      const da = resolveDirection(doc, c.a);
      const db = resolveDirection(doc, c.b);
      if (!da || !db) return 0;
      // Error: signed angle from b to the nearest parallel (or anti-parallel) direction of a.
      const err = distanceToLattice(Math.atan2(cross2(da, db), dot2(da, db)), 0, Math.PI);
      addTurn(c.b.entityId, -TURN_RELAXATION * err);
      return err * err;
    }

    case 'perpendicular': {
      const da = resolveDirection(doc, c.a);
      const db = resolveDirection(doc, c.b);
      if (!da || !db) return 0;
      // Error: signed angle from b to the nearest perpendicular direction of a.
      const err = distanceToLattice(Math.atan2(cross2(da, db), dot2(da, db)), Math.PI / 2, Math.PI);
      addTurn(c.b.entityId, -TURN_RELAXATION * err);
      return err * err;
    }

    case 'tangent': {
      const rA = resolveRadius(doc, c.a);
      const rB = resolveRadius(doc, c.b);

      if (rA !== null && rB !== null) {
        // Circle/arc ↔ circle/arc: external tangency.
        const pa = resolvePoint(doc, c.a);
        const pb = resolvePoint(doc, c.b);
        if (!pa || !pb) return 0;
        return pullToDistance(c.a.entityId, c.b.entityId, pa, pb, rA + rB);
      }

      // Line ↔ circle: |distance from circle center to line| == radius.
      const circleRef = rA !== null ? c.a : rB !== null ? c.b : null;
      if (circleRef === null) return 0;
      const lineRef = circleRef === c.a ? c.b : c.a;
      const radius = rA !== null ? rA : (rB as number);
      const pc = resolvePoint(doc, circleRef);
      if (!pc || doc.entities[lineRef.entityId]?.kind !== 'line') return 0;
      const [ax, ay] = resolvePoint(doc, { entityId: lineRef.entityId, kind: 'start' }) as Point;
      const [bx, by] = resolvePoint(doc, { entityId: lineRef.entityId, kind: 'end' }) as Point;
      const ldx = bx - ax;
      const ldy = by - ay;
      const llen = len2([ldx, ldy]);
      if (llen < 1e-12) return 0;
      const nx = -ldy / llen;
      const ny = ldx / llen;
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
 * - Points are pulled by adjusting entity.position[0] and position[1] (2D XY plane); position[2] (Z)
 *   is preserved.
 * - angle/parallel/perpendicular turn line b about its midpoint (its start/end change, not position).
 * - `residual` and `converged` describe the returned document, not the previous iterate.
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
  if (constraints.length === 0)
    return { document: doc, residual: 0, iterations: 0, converged: true };

  // Working copy of positions keyed by entity id.
  const positions = new Map<string, Vec3>();
  for (const [id, entity] of Object.entries(doc.entities)) {
    positions.set(id, entity.position);
  }

  // Working line endpoints for lines turned by angle/parallel/perpendicular constraints.
  const lineEnds = new Map<string, { start: Vec2; end: Vec2 }>();

  /** Build a document with the current working positions and line endpoints applied. */
  function buildDoc(): CadDocument {
    const newEntities: CadDocument['entities'] = {};
    for (const [id, entity] of Object.entries(doc.entities)) {
      const pos = positions.get(id) ?? entity.position;
      const ends = entity.kind === 'line' ? lineEnds.get(id) : undefined;
      newEntities[id] = ends ? { ...entity, ...ends, position: pos } : { ...entity, position: pos };
    }
    return { ...doc, entities: newEntities };
  }

  /** Total squared constraint error of `target` (gradient output discarded). */
  function totalResidual(target: CadDocument): number {
    const scratch: Delta = new Map();
    const scratchTurns: Turns = new Map();
    return constraints.reduce(
      (sum, c) => sum + applyConstraintGradient(target, c, scratch, scratchTurns, BASE_STEP),
      0,
    );
  }

  let residual = Infinity;
  let iterations = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const workingDoc = buildDoc();
    const deltas: Delta = new Map();
    const turns: Turns = new Map();
    let totalError = 0;

    for (const c of constraints) {
      totalError += applyConstraintGradient(workingDoc, c, deltas, turns, BASE_STEP);
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

    for (const [id, turn] of turns) {
      const line = workingDoc.entities[id];
      if (line?.kind !== 'line') continue;
      const current = lineEnds.get(id) ?? { start: line.start, end: line.end };
      lineEnds.set(id, turnedLine(current.start, current.end, turn));
      maxDelta = Math.max(maxDelta, Math.abs(turn));
    }

    if (maxDelta < DELTA_THRESHOLD) break;
  }

  const document = buildDoc();
  // The loop measures the error BEFORE each update; report the error of the document returned.
  residual = totalResidual(document);
  const converged = residual < RESIDUAL_THRESHOLD;
  return { document, residual, iterations, converged };
}
