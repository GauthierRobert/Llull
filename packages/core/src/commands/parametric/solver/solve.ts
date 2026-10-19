import type { CadDocument, Constraint } from '../../../model/types';
import { constructiveGuess } from './constructive';
import { isFailure, type Compiled } from './compileContext';
import { analyze, type Analysis } from './dof';
import { applyLayout, buildLayout, type Layout } from './layout';
import { levenbergMarquardt } from './levenbergMarquardt';
import { buildProblem, cost, type Problem } from './problem';
import { sizePreservation } from './rigid';
import { referenceOnlyEntities } from './reference';
import { compileConstraint } from './residuals';

export interface SolveOutcome {
  /** The sketch with the solution written back (the input document when nothing moved). */
  readonly document: CadDocument;
  /** Sum of squared residuals of the returned document. */
  readonly residual: number;
  readonly iterations: number;
  readonly converged: boolean;
  readonly dof: number;
  /** Entities that no constraint leaves free to move. */
  readonly fullyConstrained: readonly string[];
  /** Constraints that could not be turned into equations (wrong entity kinds, unresolved parameter): ignored by the solve. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly layout: Layout;
  readonly problem: Problem;
  readonly solution: Float64Array;
  readonly analysis: Analysis;
  readonly compiledIds: readonly string[];
}

const CONVERGED_RESIDUAL = 1e-8;

/** Constraints in document order (ids that no longer exist are dropped). */
export function constraintList(doc: CadDocument): Constraint[] {
  return doc.constraintOrder.flatMap((id) => {
    const constraint = doc.constraints[id];
    return constraint ? [constraint] : [];
  });
}

/**
 * Solve every constraint of the document on the sketch plane (XY; Z untouched): constructive pass, then Levenberg–Marquardt.
 * Residual rows compile against the sketch as it is now, so every branch choice (side of a line, internal/external tangency,
 * sign of an offset) keeps the current one.
 */
export function runSolver(doc: CadDocument): SolveOutcome {
  const constraints = constraintList(doc);
  const layout = buildLayout(doc, constraints);
  const compiled: Compiled[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const constraint of constraints) {
    const outcome = compileConstraint(doc, layout, constraint);
    if (isFailure(outcome)) skipped.push({ id: constraint.id, reason: outcome.error });
    else compiled.push(outcome);
  }
  const problem = buildProblem(layout, compiled);
  const usable = constraints.filter((constraint) => compiled.some((c) => c.id === constraint.id));
  const guess = compiled.length > 0 ? constructiveGuess(doc, layout, usable) : layout.x0;
  const frozen = referenceOnlyEntities(layout, usable);
  const rigid = sizePreservation(layout, new Set(compiled.flatMap((c) => c.entities)));
  const attempts: [ReadonlySet<string>, readonly Compiled[]][] = [
    ...(frozen.size > 0 ? [[frozen, rigid] as [ReadonlySet<string>, readonly Compiled[]]] : []),
    [new Set(), rigid],
    ...(frozen.size > 0 ? [[frozen, []] as [ReadonlySet<string>, readonly Compiled[]]] : []),
  ];
  let result = null as ReturnType<typeof levenbergMarquardt> | null;
  for (const [still, extra] of attempts) {
    const trial = levenbergMarquardt(buildProblem(layout, [...compiled, ...extra], still), guess);
    if (cost(problem, trial.x) < CONVERGED_RESIDUAL) {
      result = trial;
      break;
    }
  }
  result ??= levenbergMarquardt(problem, guess);
  const residual = cost(problem, result.x);
  const analysis = analyze(problem, layout, result.x);
  const document = applyLayout(doc, layout, result.x);
  return {
    document,
    residual,
    iterations: result.iterations,
    converged: residual < CONVERGED_RESIDUAL,
    dof: analysis.dof,
    fullyConstrained: analysis.fullyConstrained,
    skipped,
    layout,
    problem,
    solution: result.x,
    analysis,
    compiledIds: compiled.map((c) => c.id),
  };
}
