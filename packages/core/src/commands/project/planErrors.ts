/** Stable codes of build_project's own refusals (AGENT_FIRST AF-11 / AF-14), located by plan path. */

import { commandError } from '../noop';
import type { CommandError } from '../types';
import { MAX_LOOP_ITERATIONS, MAX_PROJECT_STEPS } from '../limits';

export interface PlanFix {
  readonly code: string;
  readonly remediation: string;
}

export const PLAN_FIX = {
  invalidAction: {
    code: 'PLAN_INVALID_ACTION',
    remediation: 'Write the item as { command, params?, as? } or { repeat | for, actions: [...] }.',
  },
  loopHeader: {
    code: 'PLAN_LOOP_HEADER',
    remediation: 'Give the loop count / range as numbers or "=expr" over document parameters and outer loop variables.',
  },
  loopLimit: { code: 'PLAN_LOOP_LIMIT', remediation: `Reduce the loop counts: at most ${MAX_LOOP_ITERATIONS} iterations per plan.` },
  stepBudget: { code: 'PLAN_STEP_BUDGET', remediation: `Split the plan into several runs: at most ${MAX_PROJECT_STEPS} executed steps.` },
  unresolvedParam: {
    code: 'PLAN_PARAM_UNRESOLVED',
    remediation: 'Bind the alias with "as" in an earlier step or fix the "=expr"; `llull run plan.json --validate` lists these.',
  },
  noEffect: { code: 'CMD_NO_EFFECT', remediation: 'The command ran but changed nothing: read `summary` for why and fix its params.' },
  empty: { code: 'PLAN_EMPTY', remediation: 'Give at least one action.' },
  tooLarge: { code: 'PLAN_TOO_LARGE', remediation: 'Split the plan into several runs, or use loops instead of repeated actions.' },
  tooDeep: { code: 'PLAN_TOO_DEEP', remediation: 'Flatten the plan: build_project is nested inside build_project too deeply.' },
} as const satisfies Record<string, PlanFix>;

/** The error of a plan failure at `location` (`step 4 › iter 2 › step 1`, or `actions` for the whole plan). */
export function planError(fix: PlanFix, location: string, ids: readonly string[] = []): CommandError {
  return commandError(fix.code, fix.remediation, ids, [location]);
}
