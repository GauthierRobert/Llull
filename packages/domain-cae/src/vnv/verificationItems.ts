/** The per-study part of check_verification: state, report data and check items of one convergence study. */

import type { AnalysisCase, FeArtifactPort, HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { vnvRemediation } from './studyCodes';
import { exceptionVerdict } from './studyException';
import { analyseStudy, feedsMargin, staleReasons, unverifiedReasons, type CaseStudy } from './studyState';
import { verifyStudy } from './studyVerify';

export interface VerificationItem {
  readonly code: string;
  readonly severity: 'error' | 'fail' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
  /** A qualified reviewer accepted this finding (signature re-verified now): it no longer raises the status. */
  readonly accepted?: { readonly signer: string; readonly signatureId: string; readonly justification: string };
}

type StudyState = 'current' | 'stale' | 'unverifiable' | 'untrusted';

export interface StudyEntry {
  readonly id: string;
  readonly quantity: CaseStudy['quantity'];
  readonly unit: string;
  readonly state: StudyState;
  readonly levels: number;
  readonly codes: readonly string[];
  readonly reviewRequired: boolean;
  readonly reviewReasons: readonly string[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  /** Numbers of a CURRENT study only (a stale, unverifiable or untrusted study withholds them). */
  readonly report?: Readonly<Record<string, unknown>>;
}

const item = (code: string, severity: VerificationItem['severity'], message: string, ids: readonly string[]): VerificationItem => ({
  code,
  severity,
  ids,
  message,
  remediation: vnvRemediation(code),
});

export interface StudyContext {
  readonly doc: CadDocument;
  readonly analysisCase: AnalysisCase;
  readonly artifacts: FeArtifactPort | null;
  readonly signatures: HumanSignaturePort | null;
  readonly gciTarget: number | undefined;
}

/**
 * State, numbers and items of one study.
 * @invariant a study is `stale` from hashes alone (no artifact read); `current` only when every level re-derives from the store; numbers are
 *   reported only for a current study; VNV_INPUT_UNVERIFIED is never suppressed by an exception
 */
export function studyEntry(
  context: StudyContext,
  study: CaseStudy,
): { readonly entry: StudyEntry; readonly items: readonly VerificationItem[] } {
  const { doc, analysisCase, artifacts, signatures, gciTarget } = context;
  const items: VerificationItem[] = [];
  const reasons = unverifiedReasons(doc, analysisCase);
  if (reasons.length > 0)
    items.push(item('VNV_INPUT_UNVERIFIED', 'warning', `the results rest on unverified material data: ${reasons.join('; ')}`, [study.id]));
  const reviewReasons = [
    ...(feedsMargin(analysisCase, study) ? ['the quantity feeds a margin of safety'] : []),
    ...(reasons.length > 0 ? ['the material data is unverified'] : []),
  ];
  const base = {
    id: study.id,
    quantity: study.quantity,
    unit: study.unit,
    levels: study.levels.length,
    reviewRequired: reviewReasons.length > 0,
    reviewReasons,
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
  };
  const withheld = (state: StudyState, found: VerificationItem): { entry: StudyEntry; items: VerificationItem[] } => ({
    entry: { ...base, state, codes: [...items, found].map((entry) => entry.code) },
    items: [...items, found],
  });
  const stale = staleReasons(doc, analysisCase, study);
  if (stale.length > 0) return withheld('stale', item('VNV_STUDY_STALE', 'error', `${study.id} is stale: ${stale.join('; ')}`, [study.id]));
  if (study.verified === false || artifacts === null)
    return withheld(
      'unverifiable',
      item(
        'VNV_STUDY_UNVERIFIED',
        'error',
        `${study.id} cannot be verified here: ${study.verified === false ? 'it was recorded without its artifacts' : 'no artifact store'}`,
        [study.id],
      ),
    );
  const problem = verifyStudy(doc, analysisCase, study, artifacts, true);
  if (problem !== null)
    return withheld(
      problem.code === 'VNV_SUMMARY_MISMATCH' ? 'untrusted' : 'unverifiable',
      item(problem.code, 'error', `${study.id}: ${problem.message}`, problem.ids),
    );
  const outcome = analyseStudy(study, gciTarget);
  if (!outcome.ok) return withheld('untrusted', item(outcome.code, 'error', `${study.id}: ${outcome.message}`, [study.id]));
  const { analysis } = outcome;
  const { verdict, signed } = signatures === null ? { verdict: 'absent' as const, signed: null } : exceptionVerdict(signatures, doc, study);
  const exception =
    verdict === 'ok' && signed !== null && study.exception !== undefined
      ? { code: study.exception.code, justification: study.exception.justification, signer: signed.signer, signatureId: signed.signatureId }
      : undefined;
  if (study.exception !== undefined && exception === undefined)
    items.push(
      item('VNV_HUMAN_GATE', 'error', `the exception recorded on ${study.id} does not verify now (${verdict}); it is ignored`, [study.id]),
    );
  for (const finding of analysis.findings) {
    const accepted = exception !== undefined && exception.code === finding.code;
    items.push({
      ...item(finding.code, finding.severity, `${study.id}: ${finding.message}`, [study.id]),
      remediation: finding.remediation,
      ...(accepted
        ? { accepted: { signer: exception.signer, signatureId: exception.signatureId, justification: exception.justification } }
        : {}),
    });
  }
  const { summaryReport: report } = analysis;
  const extrapolates = report.status === 'monotone' || report.status === 'two_level';
  return {
    entry: {
      ...base,
      state: 'current',
      codes: items.map((entry) => entry.code),
      report: {
        status: report.status,
        ...(extrapolates && report.p !== undefined ? { p: report.p } : {}),
        ...(extrapolates && report.extrapolated !== undefined ? { extrapolated: report.extrapolated } : {}),
        ...(extrapolates && report.gci21Fine !== undefined
          ? { gci21: { fine: report.gci21Fine, coarse: report.gci21Coarse ?? report.gci21Fine } }
          : {}),
        ...(extrapolates && report.gciAbs !== undefined ? { gciAbs: report.gciAbs } : {}),
        ...(report.gci32Fine !== undefined ? { gci32Fine: report.gci32Fine } : {}),
        ...(report.asymptoticRatio !== undefined ? { asymptoticRatio: report.asymptoticRatio } : {}),
        ...(analysis.required !== undefined ? { requiredSpacing: analysis.required } : {}),
        safetyFactor: analysis.safetyFactor,
        ...(analysis.formalOrder !== undefined ? { formalOrder: analysis.formalOrder } : {}),
        triplets: analysis.triplets,
        fractionUnit: 'fraction (gci21, gci32Fine, ea21; 0.01 = 1 %)',
        provenance: {
          procedure: 'celik2008-gci',
          samples: study.levels.map((level) => ({ h: level.h, value: level.value, elements: level.elements })),
          safetyFactor: analysis.safetyFactor.value,
        },
        ...(exception !== undefined
          ? { exception: { code: exception.code, signer: exception.signer, justification: exception.justification } }
          : {}),
      },
    },
    items,
  };
}
