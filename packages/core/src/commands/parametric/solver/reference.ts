import type { Constraint } from '../../../model/types';
import { subKindOf, type Layout } from './layout';

/** Kinds whose references without a sub-point act on the entity position only, never on its geometry. */
const POSITION_KINDS: ReadonlySet<string> = new Set(['coincident', 'distance', 'aligned', 'horizontal_distance', 'vertical_distance']);

/** The entity a constraint takes as its reference (it should not move to satisfy the constraint), or null when all its entities may move. */
function referenceOf(layout: Layout, c: Constraint): string | null {
  if (c.kind === 'parallel' || c.kind === 'perpendicular' || c.kind === 'angle') return c.a.entityId;
  if (c.kind === 'collinear' || c.kind === 'concentric' || c.kind === 'equal') return c.a.entityId;
  if (c.kind === 'midpoint' || c.kind === 'point_on_curve' || c.kind === 'point_to_line') return c.b.entityId;
  if (c.kind === 'symmetric') return c.axis.entityId;
  if (c.kind !== 'tangent') return null;
  const [kindA, kindB] = [layout.blocks.get(c.a.entityId)?.kind, layout.blocks.get(c.b.entityId)?.kind];
  if (kindA === 'line' && (kindB === 'circle' || kindB === 'arc')) return c.a.entityId;
  if (kindB === 'line' && (kindA === 'circle' || kindA === 'arc')) return c.b.entityId;
  return null;
}

/**
 * Entities that only ever act as the reference of orientation/tangent constraints. The solver first tries to satisfy everything while
 * keeping them still (line b turns to line a, a circle moves to its tangent line) and lets them move only when that fails.
 */
export function referenceOnlyEntities(layout: Layout, constraints: readonly Constraint[]): Set<string> {
  const references = new Set<string>();
  const driven = new Set<string>();
  for (const c of constraints) {
    const reference = referenceOf(layout, c);
    if (reference !== null) references.add(reference);
    const refs = 'axis' in c ? [c.a, c.b, c.axis] : [c.a, c.b];
    for (const ref of refs) {
      const positionOnly = POSITION_KINDS.has(c.kind) && subKindOf(ref) === undefined;
      if (ref.entityId !== reference && !positionOnly) driven.add(ref.entityId);
    }
  }
  return new Set([...references].filter((id) => !driven.has(id)));
}
