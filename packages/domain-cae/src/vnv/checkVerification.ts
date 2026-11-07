/** check_verification: the readiness check of the solution verification of an analysis (PHY-00 FR-VNV-09, AF-20). */

import { canonicalJson } from '@lib/canonicalJson';
import type { StudyQuantity } from '@core/model/convergenceStudy';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { isQuantityProblem, studyQuantityShape, toStudyQuantity } from './studyQuantity';
import { refuseVnv, vnvRemediation } from './studyCodes';
import { studiesOf } from './studyState';
import { studyEntry, type VerificationItem } from './verificationItems';

const NAME = 'check_verification';
/** Named guard: most governing quantities one call checks. */
const MAX_QUANTITIES = 50;

const raises = (found: VerificationItem): boolean => found.accepted === undefined;

/**
 * @affects nothing — read-only; data { analysisId, status, items[], studies[], reviewRequired, unverified, gciTarget? }
 * @invariant every number comes from a study RE-DERIVED from the artifact store now; a stale / unverifiable / untrusted study reports a code and no
 *   numbers; status fail when any error / fail item stands, warn when only warnings stand, else pass; no GCI target is assumed (unset -> warning);
 *   an accepted exception lowers nothing but the status, VNV_INPUT_UNVERIFIED is never accepted away
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; a quantity whose fields do not fit its kind -> VNV_PARAM_INVALID (refusals, unchanged doc)
 */
export const checkVerification = defineCommand({
  name: NAME,
  annotations: { readOnly: true },
  description:
    'Readiness check of the SOLUTION VERIFICATION (mesh, time-step and element-order convergence) of an analysis: run it at the end of every analysis job. Reads the convergence ' +
    'studies recorded by run_convergence_study, re-derives each from the artifact store, and returns status pass | warn | fail with items ' +
    '[{ code, severity, ids, message, remediation }] and studies [{ id, refinement h | dt | p, state current | stale | unverifiable | untrusted, report { p, extrapolated, ' +
    'gci21 { fine, coarse } as a FRACTION (0.01 = 1 %), asymptoticRatio, safetyFactor, triplets, provenance.procedure }, reviewRequired }]. A study of 4 or more levels is FITTED by ' +
    'least squares (procedure eca-hoekstra-lsq; report.lsq { p, f0, standardError, residual, uncertainty { absolute, relative } }; the uncertainty form Fs |f1 - f0| + s is an llull implementation choice, not confirmed against Eca & Hoekstra; VNV_LSQ_FEW_DOF warns at 4 levels (1 degree of freedom), VNV_LSQ_NO_FIT when the order falls outside [0.05, 8]: no extrapolation), exactly 3 levels use the Celik GCI triplet, ' +
    'a dt study follows the transient time step, a p study (orders 2 and 1) gives only an order-difference indicator (report.orderPair), never an order or extrapolation. Codes: VNV_NO_CONVERGENCE_STUDY ' +
    '(no study for a governing quantity), VNV_STUDY_STALE (the analysis changed after the study: re-run it), VNV_GCI_ABOVE_TARGET, VNV_GCI_TARGET_UNSET ' +
    '(no target given: ask the owner, there is no default), VNV_OSCILLATORY / VNV_DIVERGENT / VNV_ORDER_MISMATCH / VNV_NOT_ASYMPTOTIC / ' +
    'VNV_RATIO_TOO_SMALL / VNV_LSQ_POOR_FIT / VNV_P_TWO_LEVEL / VNV_P_DIFFERENCE_ABOVE_TARGET, VNV_INPUT_UNVERIFIED (unverified material data), VNV_ARTIFACT_NOT_FOUND / VNV_SUMMARY_MISMATCH. A study that feeds a margin or ' +
    'rests on unverified data is reviewRequired. A finding a qualified reviewer accepted (accept_verification_exception) is listed as accepted. ' +
    'Read-only; next: run_convergence_study to add or refresh a study.',
  params: z.object({
    analysisId: analysisIdSchema,
    gciTarget: z
      .number()
      .positive()
      .optional()
      .describe(
        'Required GCI21 of the finest level as a fraction (0.02 = 2 %), set by the owner or the company rule. No default: unset -> VNV_GCI_TARGET_UNSET.',
      ),
    quantities: z
      .array(studyQuantityShape)
      .max(MAX_QUANTITIES)
      .optional()
      .describe(
        'The governing quantities of the design (e.g. the max von Mises of the margin load case): each needs an h or dt study (an order study is only an indicator and does not count), else VNV_NO_CONVERGENCE_STUDY.',
      ),
  }),
  run: (doc, { analysisId, gciTarget, quantities }, ctx): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return refuseFe(doc, NAME, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const governing: StudyQuantity[] = [];
    for (const [index, input] of (quantities ?? []).entries()) {
      const quantity = toStudyQuantity(input);
      if (isQuantityProblem(quantity)) return refuseVnv(doc, NAME, quantity.code, quantity.message, [analysisId], [`quantities.${index}`]);
      governing.push(quantity);
    }
    const studies = studiesOf(analysisCase);
    const context = { doc, analysisCase, artifacts: ctx?.feaArtifacts ?? null, signatures: ctx?.humanSignature ?? null, gciTarget };
    const entries = studies.map((study) => studyEntry(context, study));
    const items: VerificationItem[] = entries.flatMap((entry) => [...entry.items]);
    const missing =
      governing.length > 0
        ? governing.filter(
            (quantity) => !studies.some((study) => study.refinement !== 'p' && canonicalJson(study.quantity) === canonicalJson(quantity)),
          )
        : studies.every((study) => study.refinement === 'p')
          ? [null]
          : [];
    for (const quantity of missing)
      items.push({
        code: 'VNV_NO_CONVERGENCE_STUDY',
        severity: 'warning',
        ids: [analysisId],
        message:
          quantity === null
            ? `'${analysisId}' has no convergence study`
            : `no convergence study of ${canonicalJson(quantity)} in '${analysisId}'`,
        remediation: vnvRemediation('VNV_NO_CONVERGENCE_STUDY'),
      });
    if (gciTarget === undefined)
      items.push({
        code: 'VNV_GCI_TARGET_UNSET',
        severity: 'warning',
        ids: [analysisId],
        message: 'no gciTarget was given: the GCI is reported but not judged',
        remediation: vnvRemediation('VNV_GCI_TARGET_UNSET'),
      });
    const standing = items.filter(raises);
    const status = standing.some((found) => found.severity !== 'warning') ? 'fail' : standing.length > 0 ? 'warn' : 'pass';
    const studyEntries = entries.map((entry) => entry.entry);
    const reviewRequired = studyEntries.some((entry) => entry.reviewRequired);
    const unverified = studyEntries.some((entry) => entry.unverified);
    const data = {
      analysisId,
      status,
      items,
      studies: studyEntries,
      reviewRequired,
      unverified,
      ...(gciTarget !== undefined ? { gciTarget } : {}),
    };
    const current = studyEntries.filter((entry) => entry.state === 'current').length;
    const first = studyEntries.find((entry) => entry.state === 'current');
    const numbers = first?.report;
    const gci = (numbers?.['gci21'] as { fine?: number } | undefined)?.fine;
    const lsq = numbers?.['lsq'] as { p: number; residual: { degreesOfFreedom: number }; uncertainty: { relative?: number } } | undefined;
    const lead =
      lsq?.uncertainty.relative !== undefined
        ? ` ${first?.id}: least-squares observed order ${lsq.p.toPrecision(4)} (${lsq.residual.degreesOfFreedom} degree(s) of freedom), estimated uncertainty ${(lsq.uncertainty.relative * 100).toPrecision(3)} % of the finest value.`
        : numbers !== undefined && typeof numbers['p'] === 'number' && gci !== undefined
          ? ` ${first?.id}: observed order ${numbers['p'].toPrecision(4)}, estimated discretisation error (GCI) ${(gci * 100).toPrecision(3)} % of the finest value.`
          : '';
    return report(
      doc,
      `check_verification '${analysisId}': ${status} — ${studies.length} study(ies), ${current} current; ${standing.length} item(s) standing${standing.length > 0 ? ` (${[...new Set(standing.map((found) => found.code))].join(', ')})` : ''}.${lead}${reviewRequired ? ' Human review required (computed by llull, not approved).' : ''}`,
      data,
    );
  },
});
