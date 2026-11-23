/** record_cfd_grid_study: the grid-convergence study (observed order, Richardson value, GCI) of three recorded solves of one case. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import type { CfdCase, CfdGridStudy, CfdStudyQuantity } from '@aero/cfd/types';
import { gciTriplet } from '@lib/convergence';
import { canonicalJson } from '@lib/canonicalJson';
import { significantNumber } from '@lib/compactNumber';
import { sha256Hex } from '@lib/sha256';
import { caseHashOf, caseOf, cfdSlice, withCfd } from './caseDoc';
import { refuseCfd } from './codes';
import { resultStaleness } from './staleness';
import { cfdSummary } from './summary';

const TOOL = 'record_cfd_grid_study';
/** Celik et al. 2008 recommend a refinement ratio of at least 1.3; below 1.1 the three solves cannot be told apart from noise. */
const MIN_RATIO = 1.1;
const DEFAULT_SAFETY_FACTOR = 1.25;

/**
 * A bundle belongs to the case when its case hash is the case's own or the case with only `cellsPerReferenceLength` set to the bundle's
 * grid (a study varies the resolution and nothing else).
 */
function builtForCase(cfdCase: CfdCase, artifact: CfdResultArtifact): boolean {
  if (artifact.caseHash === caseHashOf(cfdCase)) return true;
  const cells = Math.round(cfdCase.reference.lengthM / artifact.grid.cellM);
  return artifact.caseHash === caseHashOf({ ...cfdCase, cellsPerReferenceLength: cells });
}

/**
 * @affects doc.cfd.studies[caseId] (set; affected: [caseId])
 * @invariant every bundle is in the result store, hashes to the given hash, belongs to the case (same case id, flow surface and case apart from
 *   the grid resolution, the surface current) and is sorted finest first by its cell size; the coefficient comes from the bundle (case reference),
 *   never from the caller; the GCI is `@lib/convergence` gciTriplet (Celik 2008); a non-monotone triplet is recorded with its status and no GCI
 * @failure unknown case -> CFD_CASE_NOT_FOUND; a bundle absent -> CFD_RESULT_MISSING; hash / case id mismatch -> CFD_RESULT_HASH_MISMATCH; other
 *   case, other surface or stale -> CFD_INPUT_STALE; repeated hashes or refinement ratio below 1.1 -> CFD_PARAM_INVALID (all refusals, unchanged doc)
 * @invariant kernel-optional: surface staleness re-prepares the case through the kernel when present
 */
export const recordCfdGridStudy = defineCommand({
  name: TOOL,
  annotations: { kernelOptional: true },
  description:
    'Record the grid-convergence study of a flow case from three recorded solves at different cell sizes (the cfd_solve gridStudy transport ' +
    'runs them; refinement ratio 2 is the default, at least 1.1 between neighbours). Not for hand numbers: each bundle is looked up in the result ' +
    'store and its coefficient recomputed from its forces and the case reference. Computes the observed order p, the Richardson extrapolated ' +
    'value and the fine-grid GCI of the chosen coefficient (Celik et al. 2008, safety factor 1.25 for three grids) with the asymptotic-range ' +
    'ratio (about 1 when the grids are in the asymptotic range). Oscillating or diverging triplets are recorded with that status and no GCI. ' +
    'Refused with CFD_RESULT_MISSING (bundle not in the store: needs this machine), CFD_RESULT_HASH_MISMATCH, CFD_INPUT_STALE (other case or ' +
    'geometry), CFD_PARAM_INVALID (repeated bundle, ratio below 1.1).',
  params: z.object({
    caseId: z.string().describe('Id of the case (create_cfd_case).'),
    resultsHashes: z
      .array(z.string())
      .length(3)
      .describe('The three result-bundle hashes as returned by cfd_solve, in any order (they are sorted finest cell first).'),
    quantity: z
      .enum(['cd', 'cl', 'cdAM2'])
      .optional()
      .describe('Coefficient studied: cd (drag, default), cl (lift) or cdAM2 (drag area in m²).'),
    safetyFactor: z.number().min(1).max(10).optional().describe('GCI safety factor Fs (default 1.25 for three grids).'),
  }),
  run: (doc, { caseId, resultsHashes, quantity = 'cd', safetyFactor = DEFAULT_SAFETY_FACTOR }, ctx): CommandResult => {
    const fail = (code: string, message: string): CommandResult =>
      refuseCfd(doc, TOOL, code, message, [caseId, ...resultsHashes], ['resultsHashes']);
    const cfdCase = caseOf(doc, caseId);
    if (cfdCase === undefined) return refuseCfd(doc, TOOL, 'CFD_CASE_NOT_FOUND', `no case '${caseId}'`, [caseId], ['caseId']);
    if (new Set(resultsHashes).size !== 3) return fail('CFD_PARAM_INVALID', 'the three result hashes must be different');
    const found: { hash: string; artifact: CfdResultArtifact }[] = [];
    for (const hash of resultsHashes) {
      const artifact = ctx?.cfdResults?.get(hash) ?? null;
      if (artifact === null)
        return fail(
          'CFD_RESULT_MISSING',
          `no result bundle ${hash.slice(0, 12)} in the store: run cfd_solve with gridStudy on this machine`,
        );
      if (sha256Hex(canonicalJson(artifact)) !== hash)
        return fail('CFD_RESULT_HASH_MISMATCH', `the stored bundle does not hash to ${hash}`);
      if (artifact.caseId !== caseId)
        return fail('CFD_RESULT_HASH_MISMATCH', `bundle ${hash.slice(0, 12)} belongs to case '${artifact.caseId}'`);
      if (!builtForCase(cfdCase, artifact))
        return fail(
          'CFD_INPUT_STALE',
          `bundle ${hash.slice(0, 12)} was built for another case (only the grid resolution may differ): solve again`,
        );
      found.push({ hash, artifact });
    }
    const [first, second, third] = [...found].sort((a, b) => a.artifact.grid.cellM - b.artifact.grid.cellM);
    if (first === undefined || second === undefined || third === undefined) return fail('CFD_PARAM_INVALID', 'three bundles are required');
    const geometryHash = first.artifact.geometryHash;
    if (found.some((entry) => entry.artifact.geometryHash !== geometryHash))
      return fail('CFD_INPUT_STALE', 'the bundles were built for different flow surfaces: solve again');
    const staleness = resultStaleness(doc, cfdCase, { caseHash: caseHashOf(cfdCase), geometryHash }, ctx?.kernel ?? null);
    if (staleness.stale) return fail('CFD_INPUT_STALE', `${staleness.reasons.join('; ')}: solve again`);
    const r21 = second.artifact.grid.cellM / first.artifact.grid.cellM;
    const r32 = third.artifact.grid.cellM / second.artifact.grid.cellM;
    if (!(r21 >= MIN_RATIO && r32 >= MIN_RATIO))
      return fail(
        'CFD_PARAM_INVALID',
        `refinement ratios ${r21.toPrecision(4)} and ${r32.toPrecision(4)}: each must be at least ${MIN_RATIO}`,
      );
    const levels = [first, second, third].map(({ hash, artifact }) => ({
      resultsHash: hash,
      cellM: artifact.grid.cellM,
      cells: artifact.grid.cells,
      value: cfdSummary(cfdCase, artifact, hash).forces[quantity as CfdStudyQuantity],
      converged: artifact.converged,
    }));
    const [l1, l2, l3] = levels;
    if (l1 === undefined || l2 === undefined || l3 === undefined) return fail('CFD_PARAM_INVALID', 'three bundles are required');
    const gci = gciTriplet(
      [
        { h: l1.cellM, value: l1.value },
        { h: l2.cellM, value: l2.value },
        { h: l3.cellM, value: l3.value },
      ],
      safetyFactor,
    );
    const study: CfdGridStudy = {
      caseId,
      quantity,
      safetyFactor,
      caseHash: caseHashOf(cfdCase),
      geometryHash,
      levels,
      r21,
      r32,
      ...('orderNotConverged' in gci
        ? { status: 'order_not_converged' as const }
        : {
            status:
              gci.status === 'two_level' || gci.status === 'order_pair' || gci.status === 'no_fit' ? ('divergent' as const) : gci.status,
            ...(gci.p !== undefined && { orderP: gci.p }),
            ...(gci.extrapolated !== undefined && { extrapolated: gci.extrapolated }),
            ...(gci.gci21Fine !== undefined && { gci21Fine: gci.gci21Fine }),
            ...(gci.gci32Fine !== undefined && { gci32Fine: gci.gci32Fine }),
            ...(gci.asymptoticRatio !== undefined && { asymptoticRatio: gci.asymptoticRatio }),
          }),
    };
    const unconverged = levels.filter((level) => !level.converged).length;
    const studies = { ...cfdSlice(doc).studies, [caseId]: study };
    const detail =
      study.status === 'monotone' && study.orderP !== undefined
        ? `order p ${significantNumber(study.orderP, 3)}, extrapolated ${significantNumber(study.extrapolated ?? NaN, 5)}, fine-grid GCI ` +
          `${significantNumber((study.gci21Fine ?? NaN) * 100, 3)} %` +
          (study.asymptoticRatio === undefined ? '' : `, asymptotic ratio ${significantNumber(study.asymptoticRatio, 3)}`)
        : `${study.status}: no GCI (the refinement does not converge monotonically)`;
    return {
      ...changed(
        withCfd(doc, { studies }),
        `${TOOL}: ${caseId} ${quantity} on 3 grids (h ${levels.map((level) => significantNumber(level.cellM, 4)).join(' / ')} m, ratios ` +
          `${significantNumber(r21, 3)} / ${significantNumber(r32, 3)}): ${levels.map((level) => significantNumber(level.value, 5)).join(' / ')}; ${detail}` +
          (unconverged === 0 ? '' : `; ${unconverged} of 3 solves NOT converged (CFD_NOT_CONVERGED): treat the GCI with care`) +
          '.',
        [caseId],
      ),
      data: { study },
    };
  },
});
