/** One work budget per run: every value evaluation, loop iteration and expression step of a design is charged to it. */

import { DesignError } from './errors';

/** Steps (expression nodes, list cells, loop iterations) one run may spend. */
const MAX_RUN_STEPS = 10_000_000;

export class RunBudget {
  private used = 0;

  /** @failure more than MAX_RUN_STEPS in this run -> DESIGN_EVAL_LIMIT naming `line` */
  spend(count: number, line: number): void {
    this.used += count;
    if (this.used > MAX_RUN_STEPS)
      throw new DesignError(
        'DESIGN_EVAL_LIMIT',
        line,
        `the design needs more than ${MAX_RUN_STEPS} evaluation steps in one run (values, loop iterations)`,
        'Shorten the loops and lists, or split the design.',
      );
  }
}
