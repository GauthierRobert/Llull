/** check_cfd: pass / warn / fail list over the flow cases (AF-20). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { roundDeep } from '@lib/significant';
import { caseIds, caseOf, cfdSlice } from './caseDoc';
import { refuseCfd } from './codes';
import { isUnverified, prepareCase, type CheckRow } from './prepare';

type Status = 'pass' | 'warn' | 'fail';

interface CaseCheck {
  readonly caseId: string;
  readonly status: Status;
  readonly solver: string | null;
  readonly failing: readonly string[];
  readonly warning: readonly string[];
  readonly result: 'none' | 'current' | 'stale';
  readonly checks: readonly Pick<CheckRow, 'code' | 'status' | 'message'>[];
}

/**
 * @affects none; data = { status, counts, cases: [{ caseId, status, solver, failing[], warning[], result, checks[] }] }
 * @invariant a case is `fail` when any preparation check fails, `warn` on warnings or a stale result, else `pass`; a case without result is not a warning
 * @failure unknown id in caseIds -> CFD_CASE_NOT_FOUND
 */
export const checkCfd = defineCommand({
  name: 'check_cfd',
  description:
    'Read-only pass / warn / fail list over the flow (CFD) cases: runs the cfd_prepare checks of every case (watertight, self-intersection, small ' +
    'features, blockage, memory when known, regime) and says whether its recorded result is stale (case or geometry changed since the solve). ' +
    'Use it as the one-call health check of the Flow setup; use cfd_prepare for the full report of one case.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({ caseIds: z.array(z.string()).optional().describe('Cases to check; default every case of the document.') }),
  run: (doc, params, ctx): CommandResult => {
    const ids = params.caseIds ?? caseIds(doc);
    const unknown = ids.filter((id) => caseOf(doc, id) === undefined);
    if (unknown.length > 0) return refuseCfd(doc, 'check_cfd', 'CFD_CASE_NOT_FOUND', `no case ${unknown.join(', ')}`, unknown, ['caseIds']);
    const cases: CaseCheck[] = ids.flatMap((id): CaseCheck[] => {
      const cfdCase = caseOf(doc, id);
      if (cfdCase === undefined) return [];
      const prepared = prepareCase(doc, cfdCase, ctx?.kernel ?? null);
      const slice = cfdSlice(doc);
      const recorded = Object.hasOwn(slice.results, id) ? slice.results[id] : undefined;
      const stale = recorded !== undefined && (recorded.caseHash !== prepared.caseHash || recorded.geometryHash !== prepared.geometryHash);
      const failing = prepared.checks.filter((check) => check.status === 'fail').map((check) => check.code);
      const warning = [
        ...prepared.checks.filter((check) => check.status === 'warn' || isUnverified(check)).map((check) => check.code),
        ...(stale ? ['CFD_RESULT_STALE'] : []),
      ];
      return [
        {
          caseId: id,
          status: failing.length > 0 ? 'fail' : warning.length > 0 ? 'warn' : 'pass',
          solver: prepared.solver,
          failing,
          warning,
          result: recorded === undefined ? 'none' : stale ? 'stale' : 'current',
          checks: prepared.checks.map(({ code, status, message }) => ({ code, status, message })),
        },
      ];
    });
    const count = (status: Status): number => cases.filter((entry) => entry.status === status).length;
    const status: Status = count('fail') > 0 ? 'fail' : count('warn') > 0 ? 'warn' : 'pass';
    const counts = { pass: count('pass'), warn: count('warn'), fail: count('fail') };
    const detail = cases
      .filter((entry) => entry.status !== 'pass')
      .map((entry) => `${entry.caseId}: ${[...entry.failing, ...entry.warning].join(', ')}`)
      .join('; ');
    const summary =
      cases.length === 0
        ? 'check_cfd: no flow case in the document.'
        : `check_cfd: ${status} — ${cases.length} case(s): ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail${detail !== '' ? ` (${detail})` : ''}.`;
    return report(doc, summary, roundDeep({ status, counts, cases }, 10));
  },
});
