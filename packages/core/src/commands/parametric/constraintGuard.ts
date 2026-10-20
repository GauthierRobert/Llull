import type { CadDocument, Constraint } from '../../model/types';
import { findFlips } from './flipGuard';
import { runSolver, constraintList } from './solver/solve';

const list = (ids: readonly string[]): string => ids.map((id) => `'${id}'`).join(', ');

const entitiesOf = (c: Constraint): string[] => [c.a.entityId, c.b.entityId, ...('axis' in c ? [c.axis.entityId] : [])];

/** The constraints connected to `changedId` through shared entities: the only ones whose equations it can interact with. */
function clusterOf(constraints: readonly Constraint[], changedId: string): Set<string> {
  const byEntity = new Map<string, Constraint[]>();
  for (const c of constraints) for (const id of entitiesOf(c)) byEntity.set(id, [...(byEntity.get(id) ?? []), c]);
  const cluster = new Set<string>([changedId]);
  const pending = constraints.filter((c) => c.id === changedId);
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    for (const id of entitiesOf(next)) {
      for (const neighbour of byEntity.get(id) ?? []) {
        if (cluster.has(neighbour.id)) continue;
        cluster.add(neighbour.id);
        pending.push(neighbour);
      }
    }
  }
  return cluster;
}

/**
 * Why `next` (a document that adds or edits constraint `changedId`) must be refused, or null when it may be stored.
 * Refused: a constraint that cannot be expressed on its entities; one that no sketch satisfies together with the others (conflict);
 * one whose equations are already implied by others (redundant, even when consistent); one whose solution mirrors the sketch.
 * A value that cannot be evaluated yet (unknown parameter) is tolerated: the solver ignores the constraint until it can.
 * Only the cluster of constraints connected to the changed one is solved and analysed.
 */
export function constraintRefusal(next: CadDocument, changedId: string, adding: boolean): string | null {
  const constraints = constraintList(next);
  const cluster = clusterOf(constraints, changedId);
  const outcome = runSolver(next, { constraintIds: cluster, focus: changedId });
  const skipped = outcome.skipped.find((entry) => entry.id === changedId);
  if (skipped) return skipped.reason.startsWith('value ') ? null : skipped.reason;
  const changed = next.constraints[changedId];
  const others = outcome.focus?.on ?? [];
  if (!outcome.converged) {
    const touched = new Set(changed ? entitiesOf(changed) : []);
    const related = constraints
      .filter((c) => c.id !== changedId && cluster.has(c.id) && entitiesOf(c).some((id) => touched.has(id)))
      .map((c) => c.id);
    const culprits = others.length > 0 ? others : related;
    return `'${changedId}' conflicts with ${culprits.length > 0 ? `constraint(s) ${list(culprits)}` : 'the sketch'}: no solution satisfies them together (residual ${outcome.residual.toExponential(2)})`;
  }
  if (outcome.focus?.redundant) {
    return others.length > 0
      ? `'${changedId}' is redundant with constraint(s) ${list(others)}: those already determine it (over-constrained)`
      : `'${changedId}' adds no restriction (its equations are degenerate or already satisfied by the geometry it acts on)`;
  }
  const flips = findFlips(
    outcome.layout,
    outcome.layout.x0,
    outcome.solution,
    constraints.filter((c) => cluster.has(c.id)),
    adding ? changedId : null,
  );
  if (flips.length > 0) return `solving it would flip the sketch: ${flips.join('; ')}`;
  return null;
}
