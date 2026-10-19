import type { CadDocument, Constraint } from '../../../model/types';
import { constructiveGuess } from './constructive';
import { isFailure, type Compiled } from './compileContext';
import { analyze, focusDependencies } from './dof';
import { applyLayout, buildLayout, featureSize, type Layout } from './layout';
import { levenbergMarquardt } from './levenbergMarquardt';
import { buildProblem, cost } from './problem';
import { referenceOnlyEntities } from './reference';
import { sizePreservation } from './rigid';
import { compileConstraint } from './residuals';

export interface SolveOptions {
  /** Solve only these constraints (and only the entities they reference). */
  readonly constraintIds?: ReadonlySet<string>;
  /** A constraint whose redundancy against the others is reported in `focus`. */
  readonly focus?: string;
}

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
  readonly solution: Float64Array;
  /** For `options.focus`: whether its equations are implied by others, and which. */
  readonly focus: { readonly redundant: boolean; readonly on: readonly string[] } | null;
}

/** Constraints in document order (ids that no longer exist are dropped). */
export function constraintList(doc: CadDocument): Constraint[] {
  return doc.constraintOrder.flatMap((id) => {
    const constraint = doc.constraints[id];
    return constraint ? [constraint] : [];
  });
}

/** Groups of constraints connected through shared entities. */
function components(compiled: readonly Compiled[]): Compiled[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  for (const c of compiled) {
    const [first, ...rest] = c.entities;
    if (first === undefined) continue;
    for (const id of rest) parent.set(find(id), find(first));
  }
  const groups = new Map<string, Compiled[]>();
  for (const c of compiled) {
    const root = find(c.entities[0] ?? c.id);
    groups.set(root, [...(groups.get(root) ?? []), c]);
  }
  return [...groups.values()];
}

interface ComponentResult {
  readonly x: Float64Array;
  readonly iterations: number;
  readonly cost: number;
  readonly converged: boolean;
}

/**
 * One connected group. The start is the constructive guess, improved by size-preserving attempts (reference entities held still,
 * curve sizes kept) that only ever serve as a starting point: the result always comes from a plain least-squares finish, so a small
 * dimension change is applied in full rather than compromised against the size-keeping equations.
 */
function solveComponent(layout: Layout, group: readonly Compiled[], usable: readonly Constraint[], guess: Float64Array): ComponentResult {
  const problem = buildProblem(layout, group);
  const entities = new Set(group.flatMap((c) => c.entities));
  const scale = Math.max(1, ...[...entities].map((id) => featureSize(layout, id)));
  const rows = Math.max(problem.rows, 1);
  const costTarget = (1e-11 * scale) ** 2;
  const satisfied = rows * (1e-10 * scale) ** 2;
  const convergedCost = rows * (1e-8 * scale) ** 2;
  const initial = cost(problem, guess);
  if (initial < satisfied) return { x: guess, iterations: 0, cost: initial, converged: true };
  const mine = new Set(group.map((c) => c.id));
  const frozen = referenceOnlyEntities(
    layout,
    usable.filter((c) => mine.has(c.id)),
  );
  const rigid = sizePreservation(layout, entities);
  if (frozen.size === 0) {
    const plain = levenbergMarquardt(problem, guess, { costTarget });
    const drift = cost(buildProblem(layout, rigid), plain.x);
    if (plain.cost < convergedCost && drift < satisfied)
      return { x: plain.x, iterations: plain.iterations, cost: plain.cost, converged: true };
  }
  const attempts: [ReadonlySet<string>, readonly Compiled[]][] = [
    ...(frozen.size > 0 ? [[frozen, rigid] as [ReadonlySet<string>, readonly Compiled[]]] : []),
    [new Set(), rigid],
    ...(frozen.size > 0 ? [[frozen, []] as [ReadonlySet<string>, readonly Compiled[]]] : []),
  ];
  let start = guess;
  for (const [still, extra] of attempts) {
    const trial = levenbergMarquardt(buildProblem(layout, [...group, ...extra], still), guess, { costTarget });
    if (cost(problem, trial.x) < rows * (1e-4 * scale) ** 2) {
      start = trial.x;
      break;
    }
  }
  let best = levenbergMarquardt(problem, start, { costTarget });
  let iterations = best.iterations;
  if (best.cost >= convergedCost) {
    const retry = levenbergMarquardt(problem, layout.x0, { costTarget, lambda: 1e-2 });
    iterations += retry.iterations;
    if (retry.cost < best.cost) best = retry;
  }
  return { x: best.x, iterations, cost: best.cost, converged: best.cost < convergedCost };
}

/**
 * Solve the document's constraints on the sketch plane (XY; Z untouched): per connected group, a constructive pass and size-preserving
 * attempts as the start, then Levenberg–Marquardt. Residual rows compile against the sketch as it is now, so every branch choice (side
 * of a line, internal/external tangency, sign of an offset) keeps the current one.
 */
export function runSolver(doc: CadDocument, options: SolveOptions = {}): SolveOutcome {
  const all = constraintList(doc);
  const constraints = options.constraintIds ? all.filter((c) => options.constraintIds?.has(c.id)) : all;
  const layout = buildLayout(doc, constraints, options.constraintIds !== undefined);
  const compiled: Compiled[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const constraint of constraints) {
    const outcome = compileConstraint(doc, layout, constraint);
    if (isFailure(outcome)) skipped.push({ id: constraint.id, reason: outcome.error });
    else compiled.push(outcome);
  }
  const compiledIds = new Set(compiled.map((c) => c.id));
  const usable = constraints.filter((c) => compiledIds.has(c.id));
  const guess = compiled.length > 0 ? constructiveGuess(doc, layout, usable) : layout.x0;
  const solution = Float64Array.from(guess);
  let residual = 0;
  let iterations = 0;
  let converged = true;
  let rank = 0;
  const fullyConstrained: string[] = [];
  let focus: SolveOutcome['focus'] = null;
  for (const group of components(compiled)) {
    const result = solveComponent(layout, group, usable, guess);
    const problem = buildProblem(layout, group);
    problem.active.forEach((variable) => {
      solution[variable] = result.x[variable] ?? 0;
    });
    residual += result.cost;
    iterations += result.iterations;
    converged = converged && result.converged;
    const focusIndex = options.focus === undefined ? -1 : group.findIndex((c) => c.id === options.focus);
    if (focusIndex >= 0) {
      const dependencies = focusDependencies(problem, solution, focusIndex);
      focus = { redundant: dependencies.redundant, on: dependencies.on.flatMap((index) => group[index]?.id ?? []) };
    } else if (options.focus === undefined) {
      const analysis = analyze(problem, layout, solution);
      rank += analysis.rank;
      fullyConstrained.push(...analysis.fullyConstrained);
    }
  }
  return {
    document: applyLayout(doc, layout, solution),
    residual,
    iterations,
    converged,
    dof: layout.x0.length - rank,
    fullyConstrained,
    skipped,
    layout,
    solution,
    focus,
  };
}
