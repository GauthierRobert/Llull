/** cfd_prepare: the §5.1 geometry-preparation report of a case (read-only). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { roundDeep } from '@lib/significant';
import { caseOf } from './caseDoc';
import { refuseCfd } from './codes';
import { prepareCase } from './prepare';

/**
 * @affects none; data = the §5.1 report (checks[], surface, smallFeatures[], domain, frontalAreaM2, blockageRatio, grid, estimate, geometryHash, caseHash, defaults, warnings)
 * @invariant deterministic for a given document, kernel and params; the hash `geometryHash` is that of the oriented welded flow surface
 * @failure unknown case -> CFD_CASE_NOT_FOUND; every geometry problem is a check row (status fail / warn), not a refusal
 */
export const cfdPrepare = defineCommand({
  name: 'cfd_prepare',
  description:
    'Read-only preparation report of a flow case, before any solve. Unions the bodies into one surface (through the kernel when installed), ' +
    'checks it is watertight and not self-intersecting (open / non-manifold edge counts with positions), finds features smaller than two cells of ' +
    'the target grid (thin walls, gaps, small holes and bosses), sizes the flow domain (buildings: COST 732 / AIJ; external aero: named llull ' +
    'defaults) and the blockage, estimates cells, device memory and run time, and picks the solver from the Mach number. `data.checks` is a ' +
    'pass / warn / fail / not_run list with stable CFD_* codes; `data.status` is the worst of them. Nothing is changed or solved. Pass ' +
    '`deviceMemoryBytes` to also check the memory against a device.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    caseId: z.string().describe('Id of the case (cfd_create_case).'),
    quality: z
      .enum(['draft', 'standard', 'fine'])
      .optional()
      .describe('Check at this grid quality (64 / 128 / 256 cells per reference length) instead of the case value.'),
    deviceMemoryBytes: z
      .number()
      .optional()
      .describe('Device memory in bytes (> 0) to check the estimate against, e.g. 8e9. Absent: the memory check is not run.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const cfdCase = caseOf(doc, params.caseId);
    if (cfdCase === undefined)
      return refuseCfd(doc, 'cfd_prepare', 'CFD_CASE_NOT_FOUND', `no case '${params.caseId}'`, [params.caseId], ['caseId']);
    if (params.deviceMemoryBytes !== undefined && !(params.deviceMemoryBytes > 0))
      return refuseCfd(doc, 'cfd_prepare', 'CFD_PARAM_INVALID', 'deviceMemoryBytes must be > 0', [params.caseId], ['deviceMemoryBytes']);
    const prepared = prepareCase(doc, cfdCase, ctx?.kernel ?? null, {
      quality: params.quality,
      deviceMemoryBytes: params.deviceMemoryBytes,
    });
    const counts = (status: string): number => prepared.checks.filter((check) => check.status === status).length;
    const worst = prepared.checks.filter((check) => check.status === 'fail').map((check) => check.code);
    const summary =
      `cfd_prepare ${params.caseId}: ${prepared.status} — ${counts('pass')} pass, ${counts('warn')} warn, ${counts('fail')} fail, ${counts('not_run')} not run` +
      (worst.length > 0 ? ` (${worst.join(', ')})` : '') +
      (prepared.estimate !== null ? `; ${prepared.estimate.cells.toExponential(2)} cells, solver ${prepared.solver}` : '') +
      '.';
    return report(doc, summary, roundDeep(prepared, 10));
  },
});
