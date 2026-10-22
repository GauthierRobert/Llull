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

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** The whole `CfdResultSummary`: what a replay without the bundle may keep (flagged unverified), nothing less and nothing more. */
const summarySchema = z.strictObject({
  caseId: z.string(),
  resultsHash: z.string(),
  caseHash: z.string(),
  geometryHash: z.string(),
  solver: z.literal('lbm'),
  converged: z.boolean(),
  forces: z.strictObject({ totalN: vec3, momentNm: vec3, cd: z.number(), cl: z.number(), cs: z.number(), cm: vec3, cdAM2: z.number() }),
  perBody: z.array(z.strictObject({ entityId: z.string(), forceN: vec3 })),
  peaks: z.array(z.strictObject({ field: z.string(), min: z.number(), max: z.number(), minAt: vec3, maxAt: vec3, unit: z.string() })),
  grid: z.strictObject({ cells: z.number(), finestCellM: z.number(), levels: z.number() }),
  provenance: z.strictObject({
    solverVersion: z.string(),
    device: z.strictObject({ backend: z.enum(['vulkan', 'metal', 'dx12', 'cpu']), name: z.string(), driver: z.string() }),
    wallTimeS: z.number(),
    steps: z.number(),
    notModelled: z.array(z.string()),
    defaults: z.array(z.strictObject({ path: z.string(), value: z.unknown(), source: z.string() })),
  }),
  verified: z.boolean(),
});

/** Top-level keys whose canonical JSON differs between two summaries. */
const differingKeys = (given: Record<string, unknown>, expected: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(given), ...Object.keys(expected)])]
    .filter((key) => canonicalJson(given[key]) !== canonicalJson(expected[key]))
    .sort();

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

/**
 * @affects doc.cfd.results[caseId] (set; affected: [caseId])
 * @invariant the artifact exists in the store and hashes to resultsHash, was built for the current case hash and flow surface, and the stored
 *   summary is the one recomputed from it (coefficients from the artifact's forces and the CASE reference: an agent cannot supply numbers); a
 *   summary given by the caller must equal the recomputed one; WITHOUT the artifact (replay on another machine) a given summary is kept flagged
 *   `verified: false` only when it is a complete `CfdResultSummary` for this case and hash
 * @failure unknown case -> CFD_CASE_NOT_FOUND; artifact absent and no complete summary -> CFD_RESULT_MISSING; hash, case id or summary differ ->
 *   CFD_RESULT_HASH_MISMATCH; artifact built for another case hash or flow surface -> CFD_INPUT_STALE (all refusals, unchanged doc)
 */
export const recordCfdResults = defineCommand({
  name: TOOL,
  description:
    'Record the result of a flow solve run by the host (cfd_solve transport) on a case. Not for hand use: the summary is re-derived from the ' +
    'stored result bundle (forces, peaks, provenance; the coefficients from the forces and the case reference), so numbers cannot be invented. ' +
    '`summary` is optional; when given it must equal the recomputed one exactly (the transport passes it so a replay without the result store ' +
    'keeps the record as unverified — only a complete summary of this case and hash is kept). Refused with CFD_RESULT_MISSING (bundle absent), ' +
    'CFD_RESULT_HASH_MISMATCH (hash, case or summary differ), CFD_INPUT_STALE (the case or the geometry changed while solving: solve again). ' +
    'Then: cfd_report caseId=ID.',
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
      const where = ctx?.cfdResults
        ? `no result bundle ${resultsHash.slice(0, 12)} in the store`
        : 'no result store on this machine (run cfd_solve where llull-compute is installed)';
      if (summary === undefined) return fail('CFD_RESULT_MISSING', `${where}: run cfd_solve`, ids);
      const parsed = summarySchema.safeParse(summary);
      if (!parsed.success)
        return fail(
          'CFD_RESULT_MISSING',
          `${where}, and the given summary is not a complete CfdResultSummary (${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'summary'}: ${issue.message}`)
            .join('; ')}): nothing is kept`,
          ids,
        );
      if (parsed.data.resultsHash !== resultsHash || parsed.data.caseId !== caseId)
        return fail(
          'CFD_RESULT_MISSING',
          `${where}, and the given summary is for case '${parsed.data.caseId}' / bundle ${parsed.data.resultsHash.slice(0, 12)}`,
          ids,
        );
      const flagged: CfdResultSummary = { ...parsed.data, verified: false };
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
    const drag = dot(forces.totalN, artifact.forces.dragAxis);
    const peak = expected.peaks.find((entry) => entry.field === 'p');
    const convergence = artifact.converged ? 'converged' : 'NOT converged (CFD_NOT_CONVERGED: step limit reached)';
    const half = artifact.halfModel
      ? '; half model (symmetry plane): forces and moments are the whole body, side force and in-plane moments zero'
      : '';
    return changed(
      withCfd(doc, { results: { ...results, [caseId]: expected } }),
      `${TOOL}: ${caseId} ${convergence} after ${artifact.steps} steps (${artifact.solver}, ${artifact.device} ${artifact.precision}${artifact.deterministic ? ', deterministic' : ''}) — ` +
        `Cd ${significantNumber(forces.cd, 5)}, Cl ${significantNumber(forces.cl, 5)}, Cs ${significantNumber(forces.cs, 5)}, CdA ${significantNumber(forces.cdAM2, 5)} m², ` +
        `drag ${significantNumber(drag, 5)} N` +
        (peak === undefined ? '' : `, pressure ${significantNumber(peak.min, 4)}..${significantNumber(peak.max, 4)} Pa`) +
        `${half}; bundle ${resultsHash.slice(0, 12)}.`,
      [caseId],
    );
  },
});
