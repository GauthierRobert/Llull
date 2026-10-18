/** CalculiX run bookkeeping of a nonlinear solve: the `.sta` increment table and the classification of an abnormal stop (PHY-05 §5.4). */

import type { FeConvergenceRow } from '@core/model/analysis';

const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[Ee][-+]?\\d+)?';
const ROW = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(${NUMBER})(?:\\s+${NUMBER})*\\s*$`);

/**
 * Rows of a CalculiX `.sta` file: `STEP INC ATT ITRS TOT TIME STEP TIME INC TIME ...` after the `SUMMARY OF JOB INFORMATION` header; one row per
 * increment, `attempts` > 1 means cutbacks. Lines that are not rows (headers, blank) are ignored.
 * @failure text without rows -> []
 */
export function parseSta(text: string): FeConvergenceRow[] {
  const rows: FeConvergenceRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ROW.exec(line);
    if (match === null) continue;
    const [step, increment, attempts, iterations] = [match[1], match[2], match[3], match[4]].map((cell) => Number.parseInt(cell ?? '', 10));
    const totalTime = Number.parseFloat(match[5] ?? '');
    if (step !== undefined && increment !== undefined && attempts !== undefined && iterations !== undefined && Number.isFinite(totalTime))
      rows.push({ step, increment, attempts, iterations, totalTime });
  }
  return rows;
}

export type NonlinearStopCode = 'NLS_NOT_CONVERGED' | 'NLS_INCREMENT_TOO_SMALL' | 'NLS_MAX_INCREMENTS';

/**
 * Stop code of a CalculiX log that ended in `*ERROR`: increment below the minimum, `INC` reached, or no convergence after the cutbacks; null
 * when the log shows none of them (a plain solver failure).
 */
export function classifyNonlinearStop(log: string): NonlinearStopCode | null {
  if (/increment size smaller than minimum/i.test(log)) return 'NLS_INCREMENT_TOO_SMALL';
  if (/too many increments|max\.?\s*#?\s*of increments|maximum number of increments/i.test(log)) return 'NLS_MAX_INCREMENTS';
  if (/too many attempts|no convergence|did not converge|diverg/i.test(log)) return 'NLS_NOT_CONVERGED';
  return null;
}
