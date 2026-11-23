/** record_cfd_grid_study: the grid-convergence study (observed order, Richardson value, GCI) of three recorded solves of one case. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import type { CfdCase, CfdGridStudy, CfdStudyQuantity } from '@aero/cfd/types';
import { gciTriplet, type ConvergenceStatus } from '@lib/convergence';
import { canonicalJson } from '@lib/canonicalJson';
import { significantNumber } from '@lib/compactNumber';
import { sha256Hex } from '@lib/sha256';
import type { CadDocument } from '@core/model/types';
import { caseHashOf, caseOf, cfdSlice, withCfd } from './caseDoc';
import { refuseCfd } from './codes';
import { resultStaleness } from './staleness';
import { studySchema } from './studySchema';
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

type Level = CfdGridStudy['levels'][number];
type Status = CfdGridStudy['status'];

const STATUSES: readonly ConvergenceStatus[] = ['monotone', 'oscillatory', 'divergent', 'converged_exactly'];

/** The GCI fields of a finest-first triplet, or null when `gciTriplet` answers a status a three-grid triplet never has. */
function convergenceOf(
  levels: readonly [Level, Level, Level],
  safetyFactor: number,
): Pick<
  CfdGridStudy,
  'status' | 'orderP' | 'extrapolated' | 'gci21Fine' | 'gci32Fine' | 'gciAbs' | 'relativeUndefined' | 'asymptoticRatio'
> | null {
  const [l1, l2, l3] = levels;
  const gci = gciTriplet(
    [
      { h: l1.cellM, value: l1.value },
      { h: l2.cellM, value: l2.value },
      { h: l3.cellM, value: l3.value },
    ],
    safetyFactor,
  );
  if ('orderNotConverged' in gci) return { status: 'order_not_converged' };
  if (!STATUSES.includes(gci.status)) return null;
  return {
    status: gci.status as Status,
    ...(gci.p !== undefined && { orderP: gci.p }),
    ...(gci.extrapolated !== undefined && { extrapolated: gci.extrapolated }),
    ...(gci.gci21Fine !== undefined && { gci21Fine: gci.gci21Fine }),
    ...(gci.gci32Fine !== undefined && { gci32Fine: gci.gci32Fine }),
    ...(gci.gciAbs !== undefined && { gciAbs: gci.gciAbs }),
    ...(gci.relativeUndefined === true && { relativeUndefined: true as const }),
    ...(gci.asymptoticRatio !== undefined && { asymptoticRatio: gci.asymptoticRatio }),
  };
}

function detailOf(study: CfdGridStudy): string {
  if (study.status === 'monotone' && study.orderP !== undefined) {
    const gci =
      study.relativeUndefined === true
        ? `fine-grid GCI ${significantNumber(study.gciAbs ?? NaN, 3)} absolute (fine value 0: relative GCI undefined)`
        : `fine-grid GCI ${significantNumber((study.gci21Fine ?? NaN) * 100, 3)} %`;
    return (
      `order p ${significantNumber(study.orderP, 3)}, extrapolated ${significantNumber(study.extrapolated ?? NaN, 5)}, ${gci}` +
      (study.asymptoticRatio === undefined ? '' : `, asymptotic ratio ${significantNumber(study.asymptoticRatio, 3)}`)
    );
  }
  if (study.status === 'converged_exactly') return 'converged_exactly: two grids give the same value, no order or GCI to compute';
  if (study.status === 'order_not_converged') return 'order_not_converged: monotone, but the observed order did not converge: no GCI';
  return `${study.status}: no GCI (the refinement does not converge monotonically)`;
}

/**
 * The echoed study to keep unverified when no result store exists, or a refusal `{ code, message }`. Rules: it parses, is of this case and
 * current, studies the same quantity with the same safety factor, its levels are exactly the three given hashes, and it never replaces a verified study.
 */
function replayRefusal(
  doc: CadDocument,
  cfdCase: CfdCase,
  caseId: string,
  resultsHashes: readonly string[],
  quantity: CfdStudyQuantity,
  safetyFactor: number,
  given: unknown,
): CfdGridStudy | { readonly code: string; readonly message: string } {
  const where =
    'no result store on this machine, and no complete study of this case and these bundles was given: run cfd_solve with gridStudy here';
  const parsed = studySchema.safeParse(given);
  if (!parsed.success || parsed.data.caseId !== caseId) return { code: 'CFD_RESULT_MISSING', message: where };
  const study = parsed.data as CfdGridStudy;
  const hashes = new Set(study.levels.map((entry) => entry.resultsHash));
  if (hashes.size !== 3 || !resultsHashes.every((hash) => hashes.has(hash)))
    return { code: 'CFD_RESULT_MISSING', message: 'the given study is not over the three given bundles' };
  if (study.quantity !== quantity || study.safetyFactor !== safetyFactor)
    return {
      code: 'CFD_PARAM_INVALID',
      message: `the given study is for ${study.quantity} with safety factor ${study.safetyFactor}, not ${quantity} / ${safetyFactor}`,
    };
  if (study.caseHash !== caseHashOf(cfdCase))
    return { code: 'CFD_INPUT_STALE', message: 'the given study was computed for another state of the case: solve again' };
  if (cfdSlice(doc).studies?.[caseId]?.verified === true)
    return {
      code: 'CFD_RESULT_MISSING',
      message: `the case already has a verified study; an unverified one would replace it (solve where the bundles are)`,
    };
  return study;
}

/**
 * @affects doc.cfd.studies[caseId] (set, replacing an earlier study; affected: [caseId])
 * @invariant every bundle is in the result store, hashes to the given hash, belongs to the case (same case id, flow surface and case apart from
 *   the grid resolution, the surface current) and is sorted finest first by its cell size; the coefficient comes from the bundle (case reference),
 *   never from the caller; the GCI is `@lib/convergence` gciTriplet (Celik 2008); a non-monotone triplet is recorded with its status and no GCI;
 *   a given `study` must equal the recomputed one; with NO result store (replay on another machine) a given `study` of this case, current,
 *   of the same quantity and safety factor, over exactly the given hashes, is kept flagged `verified: false` (never over a verified study)
 * @failure unknown case -> CFD_CASE_NOT_FOUND; a bundle absent from the store, or no store and no acceptable echoed study -> CFD_RESULT_MISSING; hash / case id / study mismatch ->
 *   CFD_RESULT_HASH_MISMATCH; other case, other surface or stale -> CFD_INPUT_STALE; repeated hashes, refinement ratio below 1.1 or an unexpected
 *   convergence status -> CFD_PARAM_INVALID (all refusals, unchanged doc)
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
    'ratio (about 1 when the grids are in the asymptotic range); a fine value of exactly 0 gives the absolute GCI. Oscillating, diverging or ' +
    'order-not-converging triplets are recorded with that status and no GCI. `study` is optional: the transport passes the study it returned so a ' +
    'replay without the result store keeps it as unverified; with the store it must equal the recomputed one. ' +
    'Refused with CFD_RESULT_MISSING (bundle not in the store and no complete study given), CFD_RESULT_HASH_MISMATCH, CFD_INPUT_STALE (other ' +
    'case or geometry), CFD_PARAM_INVALID (repeated bundle, ratio below 1.1).',
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
    study: z
      .looseObject({})
      .optional()
      .describe('Exactly the study returned by the transport (never hand-written): recomputed from the bundles and compared.'),
  }),
  run: (doc, { caseId, resultsHashes, quantity = 'cd', safetyFactor = DEFAULT_SAFETY_FACTOR, study: given }, ctx): CommandResult => {
    const fail = (code: string, message: string): CommandResult =>
      refuseCfd(doc, TOOL, code, message, [caseId, ...resultsHashes], ['resultsHashes']);
    const cfdCase = caseOf(doc, caseId);
    if (cfdCase === undefined) return refuseCfd(doc, TOOL, 'CFD_CASE_NOT_FOUND', `no case '${caseId}'`, [caseId], ['caseId']);
    if (new Set(resultsHashes).size !== 3) return fail('CFD_PARAM_INVALID', 'the three result hashes must be different');
    const keep = (study: CfdGridStudy, summary: string): CommandResult => ({
      ...changed(withCfd(doc, { studies: { ...cfdSlice(doc).studies, [caseId]: study } }), summary, [caseId]),
      data: { study },
    });
    const store = ctx?.cfdResults;
    if (store === undefined || store === null) {
      const refusal = replayRefusal(doc, cfdCase, caseId, resultsHashes, quantity, safetyFactor, given);
      if ('code' in refusal) return fail(refusal.code, refusal.message);
      return keep(
        { ...refusal, verified: false },
        `${TOOL}: ${caseId} grid study recorded UNVERIFIED (no result store on this machine): no number is trusted until cfd_solve runs here.`,
      );
    }
    const found: { hash: string; artifact: CfdResultArtifact }[] = [];
    for (const hash of resultsHashes) {
      const artifact = store.get(hash);
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
    const [l1, l2, l3] = [first, second, third].map(
      ({ hash, artifact }): Level => ({
        resultsHash: hash,
        cellM: artifact.grid.cellM,
        cells: artifact.grid.cells,
        value: cfdSummary(cfdCase, artifact, hash).forces[quantity as CfdStudyQuantity],
        converged: artifact.converged,
      }),
    );
    if (l1 === undefined || l2 === undefined || l3 === undefined) return fail('CFD_PARAM_INVALID', 'three bundles are required');
    const levels: [Level, Level, Level] = [l1, l2, l3];
    const convergence = convergenceOf(levels, safetyFactor);
    if (convergence === null) return fail('CFD_PARAM_INVALID', 'the grid triplet has no three-level convergence classification');
    const study: CfdGridStudy = {
      caseId,
      quantity,
      safetyFactor,
      caseHash: caseHashOf(cfdCase),
      geometryHash,
      levels,
      r21,
      r32,
      ...convergence,
      verified: true,
    };
    if (given !== undefined && canonicalJson(given) !== canonicalJson(study))
      return fail('CFD_RESULT_HASH_MISMATCH', 'the given study differs from the one recomputed from the bundles');
    const unconverged = levels.filter((level) => !level.converged).length;
    return keep(
      study,
      `${TOOL}: ${caseId} ${quantity} on 3 grids (h ${levels.map((level) => significantNumber(level.cellM, 4)).join(' / ')} m, ratios ` +
        `${significantNumber(r21, 3)} / ${significantNumber(r32, 3)}): ${levels.map((level) => significantNumber(level.value, 5)).join(' / ')}; ${detailOf(study)}` +
        (unconverged === 0 ? '' : `; ${unconverged} of 3 solves NOT converged (CFD_NOT_CONVERGED): treat the GCI with care`) +
        '.',
    );
  },
});
