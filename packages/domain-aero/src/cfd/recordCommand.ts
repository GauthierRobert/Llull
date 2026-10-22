/** record_cfd_results: store the summary of a host-produced flow solve, validated against the result store (05 §4.1 trust model). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CfdResultSummary } from '@aero/cfd/types';
import { canonicalJson } from '@lib/canonicalJson';
import { significantNumber } from '@lib/compactNumber';
import { sha256Hex } from '@lib/sha256';
import { caseOf, cfdSlice, withCfd } from './caseDoc';
import { refuseCfd } from './codes';
import { resultStaleness } from './staleness';
import { cfdSummary } from './summary';

const TOOL = 'record_cfd_results';

/** Top-level keys whose canonical JSON differs between two summaries. */
const differingKeys = (given: Record<string, unknown>, expected: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(given), ...Object.keys(expected)])]
    .filter((key) => canonicalJson(given[key]) !== canonicalJson(expected[key]))
    .sort();

/**
 * @affects doc.cfd.results[caseId] (set; affected: [caseId])
 * @invariant the artifact exists in the store and hashes to resultsHash, was built for the current case hash and flow surface, and the stored
 *   summary is the one recomputed from it (coefficients from the artifact's forces and the CASE reference: an agent cannot supply numbers); a
 *   summary given by the caller must equal the recomputed one; WITHOUT the artifact (replay on another machine) a given summary is kept flagged
 *   `verified: false`
 * @failure unknown case -> CFD_CASE_NOT_FOUND; artifact absent and no usable summary -> CFD_RESULT_MISSING; hash, case id or summary differ ->
 *   CFD_RESULT_HASH_MISMATCH; artifact built for another case hash or flow surface -> CFD_INPUT_STALE (all refusals, unchanged doc)
 */
export const recordCfdResults = defineCommand({
  name: TOOL,
  description:
    'Record the result of a flow solve run by the host (cfd_solve transport) on a case. Not for hand use: the summary is re-derived from the ' +
    'stored result bundle (forces, peaks, provenance; the coefficients from the forces and the case reference), so numbers cannot be invented. ' +
    '`summary` is optional; when given it must equal the recomputed one exactly (the transport passes it so a replay without the result store ' +
    'keeps the record as unverified). Refused with CFD_RESULT_MISSING (bundle absent), CFD_RESULT_HASH_MISMATCH (hash, case or summary differ), ' +
    'CFD_INPUT_STALE (the case or the geometry changed while solving: solve again). Then: cfd_report caseId=ID.',
  params: z.object({
    caseId: z.string().describe('Id of the case (create_cfd_case).'),
    resultsHash: z.string().describe('sha256 of the canonical result bundle JSON, as returned by the cfd_solve transport.'),
    summary: z
      .looseObject({ resultsHash: z.string().describe('Same as resultsHash.') })
      .optional()
      .describe('Exactly the summary returned by the transport (never hand-written): it is recomputed from the bundle and compared.'),
  }),
  run: (doc, { caseId, resultsHash, summary }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [caseId]): CommandResult =>
      refuseCfd(doc, TOOL, code, message, ids, ['resultsHash']);
    const cfdCase = caseOf(doc, caseId);
    if (cfdCase === undefined) return refuseCfd(doc, TOOL, 'CFD_CASE_NOT_FOUND', `no case '${caseId}'`, [caseId], ['caseId']);
    const ids = [caseId, resultsHash];
    const artifact = ctx?.cfdResults?.get(resultsHash) ?? null;
    const results = cfdSlice(doc).results;
    if (artifact === null) {
      const keepable = summary !== undefined && summary.resultsHash === resultsHash && typeof summary['caseHash'] === 'string';
      if (!keepable)
        return fail(
          'CFD_RESULT_MISSING',
          ctx?.cfdResults
            ? `no result bundle ${resultsHash.slice(0, 12)} in the store: run cfd_solve`
            : 'no result store on this machine: run cfd_solve where llull-compute is installed',
          ids,
        );
      const flagged = { ...summary, caseId, verified: false } as unknown as CfdResultSummary;
      return changed(
        withCfd(doc, { results: { ...results, [caseId]: flagged } }),
        `${TOOL}: ${caseId} result ${resultsHash.slice(0, 12)} recorded UNVERIFIED (bundle not available on this machine): no number is trusted until cfd_solve runs here.`,
        [caseId],
      );
    }
    if (sha256Hex(canonicalJson(artifact)) !== resultsHash)
      return fail('CFD_RESULT_HASH_MISMATCH', `the stored bundle does not hash to ${resultsHash}`, ids);
    if (artifact.caseId !== caseId)
      return fail('CFD_RESULT_HASH_MISMATCH', `bundle ${resultsHash.slice(0, 12)} belongs to case '${artifact.caseId}'`, ids);
    const staleness = resultStaleness(doc, cfdCase, artifact, ctx?.kernel ?? null);
    if (staleness.stale) return fail('CFD_INPUT_STALE', `${staleness.reasons.join('; ')}: solve again`, ids);
    const expected = cfdSummary(cfdCase, artifact, resultsHash);
    if (summary !== undefined) {
      const differing = differingKeys(summary, expected as unknown as Record<string, unknown>);
      if (differing.length > 0)
        return fail(
          'CFD_RESULT_HASH_MISMATCH',
          `the summary differs from the one recomputed from the bundle in: ${differing.join(', ')}`,
          ids,
        );
    }
    const { forces } = expected;
    const peak = expected.peaks.find((entry) => entry.field === 'p');
    const convergence = artifact.converged ? 'converged' : 'NOT converged (CFD_NOT_CONVERGED: step limit reached)';
    return changed(
      withCfd(doc, { results: { ...results, [caseId]: expected } }),
      `${TOOL}: ${caseId} ${convergence} after ${artifact.steps} steps (${artifact.solver}, ${artifact.device} ${artifact.precision}${artifact.deterministic ? ', deterministic' : ''}) — ` +
        `Cd ${significantNumber(forces.cd, 5)}, Cl ${significantNumber(forces.cl, 5)}, Cs ${significantNumber(forces.cs, 5)}, CdA ${significantNumber(forces.cdAM2, 5)} m², ` +
        `drag ${significantNumber(forces.totalN[0], 5)} N` +
        (peak === undefined ? '' : `, pressure ${significantNumber(peak.min, 4)}..${significantNumber(peak.max, 4)} Pa`) +
        `; bundle ${resultsHash.slice(0, 12)}.`,
      [caseId],
    );
  },
});
