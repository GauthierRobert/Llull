/** cfd_report: the recorded result of a case with its trust (re-verified against the result store) and staleness (read-only). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { canonicalJson } from '@lib/canonicalJson';
import { significantNumber } from '@lib/compactNumber';
import { roundDeep } from '@lib/significant';
import { caseOf, cfdSlice } from './caseDoc';
import { CFD_REMEDIATION, refuseCfd } from './codes';
import { resultStaleness } from './staleness';
import { cfdSummary } from './summary';

const SECTIONS = ['forces', 'peaks', 'convergence', 'probes', 'provenance'] as const;
type Section = (typeof SECTIONS)[number];

interface Warning {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

const warning = (code: string, message: string): Warning => ({ code, message, remediation: CFD_REMEDIATION[code] ?? '' });

/**
 * @affects none; data = { caseId, resultsHash, stale, staleReasons, verified, trusted, converged, solver, forces?, peaks?, convergence?,
 *   probes?, provenance?, warnings[], reviewRequired }
 * @invariant numbers shown are the recorded summary only when it equals the one recomputed from the stored bundle (`trusted`); a stale result
 *   is reported with the warning CFD_RESULT_STALE, never hidden
 * @failure unknown case -> CFD_CASE_NOT_FOUND; no recorded result -> CFD_NO_RESULT
 */
export const cfdReport = defineCommand({
  name: 'cfd_report',
  description:
    'Read-only report of the recorded flow result of a case: forces and coefficients (Cd, Cl, Cs, Cm, CdA), per-body forces, pressure and ' +
    'speed peaks with positions, convergence (steps, averaging, drag history), probe values and provenance (solver, device, precision, wall ' +
    'time, what is not modelled, named defaults). `stale: true` with the warning CFD_RESULT_STALE when the case or the geometry changed since the ' +
    'solve; `trusted: false` when the recorded summary cannot be re-verified against the stored bundle on this machine. `include` picks the ' +
    'sections (default all). Refused with CFD_NO_RESULT before any cfd_solve.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    caseId: z.string().describe('Id of the case.'),
    include: z.array(z.enum(SECTIONS)).optional().describe('Sections to include (default every one).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const cfdCase = caseOf(doc, params.caseId);
    if (cfdCase === undefined)
      return refuseCfd(doc, 'cfd_report', 'CFD_CASE_NOT_FOUND', `no case '${params.caseId}'`, [params.caseId], ['caseId']);
    const recorded = cfdSlice(doc).results[params.caseId];
    if (recorded === undefined)
      return refuseCfd(doc, 'cfd_report', 'CFD_NO_RESULT', `case '${params.caseId}' has no recorded result`, [params.caseId], ['caseId']);
    const include = new Set<Section>(params.include ?? SECTIONS);
    const staleness = resultStaleness(doc, cfdCase, recorded, ctx?.kernel ?? null);
    const warnings: Warning[] = [];
    if (staleness.stale) warnings.push(warning('CFD_RESULT_STALE', staleness.reasons.join('; ')));
    const artifact: CfdResultArtifact | null = ctx?.cfdResults?.get(recorded.resultsHash) ?? null;
    let trusted = false;
    if (recorded.verified === false)
      warnings.push(warning('CFD_RESULT_MISSING', 'the summary was recorded without its bundle on this machine'));
    else if (artifact === null)
      warnings.push(warning('CFD_RESULT_MISSING', `bundle ${recorded.resultsHash.slice(0, 12)} is not in the result store`));
    else if (canonicalJson(cfdSummary(cfdCase, artifact, recorded.resultsHash)) !== canonicalJson(recorded))
      warnings.push(warning('CFD_RESULT_HASH_MISMATCH', 'the recorded summary differs from the one recomputed from the bundle'));
    else trusted = true;
    const { forces } = recorded;
    const data = {
      caseId: params.caseId,
      resultsHash: recorded.resultsHash,
      stale: staleness.stale,
      staleReasons: staleness.reasons,
      verified: recorded.verified,
      trusted,
      converged: recorded.converged,
      solver: recorded.solver,
      ...(include.has('forces') ? { forces, perBody: recorded.perBody } : {}),
      ...(include.has('peaks') ? { peaks: recorded.peaks } : {}),
      ...(include.has('convergence')
        ? {
            convergence: {
              converged: recorded.converged,
              steps: recorded.provenance.steps,
              averagedSteps: artifact?.averagedSteps ?? null,
              history: artifact?.history ?? [],
              warnings: artifact?.warnings ?? [],
            },
          }
        : {}),
      ...(include.has('probes') ? { probes: artifact?.probes ?? [] } : {}),
      ...(include.has('provenance') ? { provenance: recorded.provenance, grid: recorded.grid } : {}),
      warnings,
      reviewRequired: false,
    };
    const flags = [
      ...(recorded.converged ? [] : ['not converged']),
      ...(staleness.stale ? ['STALE'] : []),
      ...(trusted ? [] : ['unverified']),
    ];
    const summary =
      `cfd_report ${params.caseId}: Cd ${significantNumber(forces.cd, 5)}, Cl ${significantNumber(forces.cl, 5)}, Cs ${significantNumber(forces.cs, 5)}, ` +
      `CdA ${significantNumber(forces.cdAM2, 5)} m² (${recorded.solver}, ${recorded.provenance.device.name}, ${recorded.provenance.steps} steps)` +
      (flags.length > 0 ? ` [${flags.join(', ')}]` : '') +
      '.';
    return report(doc, summary, roundDeep(data, 10));
  },
});
