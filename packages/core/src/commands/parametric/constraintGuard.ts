import type { CadDocument } from '../../model/types';
import { findFlips } from './flipGuard';
import { runSolver, constraintList } from './solver/solve';

const list = (ids: readonly string[]): string => ids.map((id) => `'${id}'`).join(', ');

/**
 * Why `next` (a document that adds or edits constraint `changedId`) must be refused, or null when it may be stored.
 * Refused: a constraint that cannot be expressed on its entities; one that no sketch satisfies together with the others (conflict);
 * one whose equations are already implied by others (redundant, even when consistent); one whose solution mirrors the sketch.
 * A value that cannot be evaluated yet (unknown parameter) is tolerated: the solver ignores the constraint until it can.
 */
export function constraintRefusal(next: CadDocument, changedId: string, adding: boolean): string | null {
  const outcome = runSolver(next);
  const skipped = outcome.skipped.find((entry) => entry.id === changedId);
  if (skipped) return skipped.reason.startsWith('value ') ? null : skipped.reason;
  const index = outcome.compiledIds.indexOf(changedId);
  const dependencies = outcome.analysis.dependenciesOf(index);
  const changed = next.constraints[changedId];
  if (!outcome.converged) {
    const related = constraintList(next)
      .filter((c) => c.id !== changedId && outcome.compiledIds.includes(c.id))
      .filter((c) => {
        const touched = new Set([c.a.entityId, c.b.entityId, ...('axis' in c ? [c.axis.entityId] : [])]);
        return changed !== undefined && [changed.a.entityId, changed.b.entityId].some((id) => touched.has(id));
      })
      .map((c) => c.id);
    const culprits = dependencies.others.length > 0 ? dependencies.others.flatMap((i) => outcome.compiledIds[i] ?? []) : related;
    return `'${changedId}' conflicts with ${culprits.length > 0 ? `constraint(s) ${list(culprits)}` : 'the sketch'}: no solution satisfies them together (residual ${outcome.residual.toExponential(2)})`;
  }
  if (dependencies.selfRedundant || dependencies.others.length > 0) {
    const others = dependencies.others.flatMap((i) => outcome.compiledIds[i] ?? []);
    return others.length > 0
      ? `'${changedId}' is redundant with constraint(s) ${list(others)}: those already determine it (over-constrained)`
      : `'${changedId}' adds no restriction (its equations are degenerate or already satisfied by the geometry it acts on)`;
  }
  const flips = findFlips(outcome.layout, outcome.layout.x0, outcome.solution, constraintList(next), adding ? changedId : null);
  if (flips.length > 0) return `solving it would flip the sketch: ${flips.join('; ')}`;
  return null;
}
