/**
 * A wall-clock budget for a performance assertion. A coverage run instruments every function, which slows tight loops by a factor that has
 * nothing to do with the code under test: the budget is doubled there (`LLULL_COVERAGE`, set in vite.config.ts) and exact in a plain run.
 */
export function timeBudgetMs(milliseconds: number): number {
  return process.env['LLULL_COVERAGE'] === '1' ? milliseconds * 2 : milliseconds;
}
