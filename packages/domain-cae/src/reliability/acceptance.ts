/** accept_reliability_result (PHY-18 TR-PRB-12): a qualified reviewer's signed acceptance of the reliability RESULT of one limit state (human gate, AF-34). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { DOCUMENT_UNIDENTIFIED_TEXT, boundVerdict, documentIdentity } from '@core/model/documentUid';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { isStudyFailure } from './context';
import { refuseReliability } from './codes';
import { limitStateOf, reliabilityOf, withReliability } from './model';
import { DEFAULT_STUDY, isSampledStudy, normalizeStudy, reliabilityResult, sameStudy } from './resultHash';
import { isValidResultStudy, maxIterationsSchema, resultMethodsSchema, samplingSchema, toleranceSchema } from './studySchema';
import type { Acceptance, AcceptanceLedgerEntry, ResultStudy } from '@cae/reliability/types';

const DEFAULT_SAMPLES = 10_000;

/** SHA-256 the human signs: the acceptance of one result (its hash, seed and sample count) of one limit state in the document `documentUid`. */
export const acceptancePayload = (
  limitState: string,
  resultHash: string,
  seed: number,
  samples: number,
  justification: string,
  documentUid: string,
): string =>
  sha256Hex(canonicalJson({ kind: 'reliability_acceptance', documentUid, limitState, resultHash, seed, samples, justification }));

export type AcceptanceCheck = { readonly valid: true } | { readonly valid: false; readonly code: string; readonly reason: string };

/**
 * Whether a stored acceptance still stands: its signature verifies through the port for its own document uid and payload, the signer matches, the
 * document is the one it was signed for, and RE-RUNNING the stated study (seed, samples) on the current document gives the signed result hash.
 * @invariant pure; valid only with a port; PRB_RESULT_STALE when the model, anything a response reads, or the study changed since; PRB_HUMAN_GATE otherwise
 */
export function verifyAcceptance(
  port: HumanSignaturePort | null | undefined,
  doc: CadDocument,
  limitState: string,
  recorded: Acceptance,
  ctx: ExecutionContext | undefined,
): AcceptanceCheck {
  const gate = (reason: string): AcceptanceCheck => ({ valid: false, code: 'PRB_HUMAN_GATE', reason });
  if (port === null || port === undefined) return gate('no signing port on this machine: the signature cannot be re-verified');
  const { verdict, signed } = boundVerdict(port, recorded.signature, recorded.documentUid, documentIdentity(doc), (uid) =>
    acceptancePayload(limitState, recorded.resultHash, recorded.seed, recorded.samples, recorded.justification, uid),
  );
  if (verdict === 'unbound') return gate('the acceptance records no document uid');
  if (verdict === 'foreign') return gate('the acceptance was signed for another document (copied in)');
  if (signed === null || signed.signer !== recorded.signer || signed.signatureId !== recorded.signatureId)
    return gate('the signature does not verify for this acceptance');
  const study = recordedStudy(recorded);
  if (study === null)
    return { valid: false, code: 'PRB_RESULT_STALE', reason: 'the recorded study has options out of range: it is not re-run' };
  const now = reliabilityResult(doc, limitState, study, recorded.seed, recorded.samples, ctx);
  return !isStudyFailure(now) && now.resultHash === recorded.resultHash
    ? { valid: true }
    : {
        valid: false,
        code: 'PRB_RESULT_STALE',
        reason: 'the result of the accepted study is no longer the one signed (model, inputs of a response or study changed)',
      };
}

/** The normalised study of a stored acceptance (one recorded before PRB-b carries none: the default study); null when its options are out of range. */
const recordedStudy = (recorded: Acceptance): ResultStudy | null => {
  const study = recorded.study ?? DEFAULT_STUDY;
  return isValidResultStudy(study) ? normalizeStudy(study) : null;
};

const isSameRecordedStudy = (entry: Acceptance, wanted: ResultStudy): boolean => {
  const study = recordedStudy(entry);
  return study !== null && sameStudy(study, wanted);
};

interface Wanted {
  readonly limitState: string;
  readonly resultHash: string;
  readonly seed: number;
  readonly samples: number;
  readonly study: ResultStudy;
  readonly justification: string;
}

/** The ledger entry a REPLAYED step re-applies: same limit state, result, study and justification and this document's uid; never outside a replay. */
function keptAcceptance(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  confirmation: unknown,
  wanted: Wanted,
): AcceptanceLedgerEntry | undefined {
  if (ctx?.replaying !== true || !isRecordedConfirmation(confirmation)) return undefined;
  return (reliabilityOf(doc).acceptanceLedger ?? []).find(
    (entry) =>
      entry.limitState === wanted.limitState &&
      entry.resultHash === wanted.resultHash &&
      entry.seed === wanted.seed &&
      entry.samples === wanted.samples &&
      isSameRecordedStudy(entry, wanted.study) &&
      entry.justification === wanted.justification &&
      entry.documentUid === documentIdentity(doc),
  );
}

/** The signer of this act: a replayed ledger entry re-verified (or kept as recorded without a port), else the fresh confirmation verified; null when neither verifies. */
function verifiedSigner(
  port: HumanSignaturePort | null,
  kept: AcceptanceLedgerEntry | undefined,
  confirmation: unknown,
  payloadFor: (documentUid: string) => string,
  uid: string,
): { signer: string; signatureId: string } | null {
  if (kept === undefined) return port === null ? null : port.verify(confirmation, payloadFor(uid));
  const again =
    port === null ? { signer: kept.signer, signatureId: kept.signatureId } : port.verify(kept.signature, payloadFor(kept.documentUid));
  return again !== null && again.signer === kept.signer && again.signatureId === kept.signatureId ? again : null;
}

/**
 * @affects doc.probabilistic.acceptances[limitState] and doc.probabilistic.acceptanceLedger (resultHash, seed, samples, study, modelHash, justification, signer, signatureId, verified signature, documentUid)
 * @invariant the param is `confirmation` (never reaches the history); accepted only with a signature verified by `ctx.humanSignature` over the payload sha256 of
 *   (documentUid, limitState, resultHash, seed, samples, justification), spent LAST (a refusal never burns it); the result hash is recomputed by re-running the study
 *   on the current document, so it binds the model, everything a response reads and the numbers; a replay honours a recorded step only from `probabilistic.acceptanceLedger`
 *   (kept by replaySeed), spends nothing
 * @failure no port / no confirmation / one that does not verify (an agent always lands here) -> PRB_HUMAN_GATE; unknown limit state -> PRB_LIMIT_STATE_NOT_FOUND;
 *   empty justification / mc or is without a seed -> PRB_PARAMS_INVALID; no document uid -> PRB_DOCUMENT_UNIDENTIFIED; limit state not studiable -> its PRB_* code; resultHash differs from the recomputed one -> PRB_RESULT_STALE (all unchanged doc)
 */
export const acceptReliabilityResult = defineCommand({
  name: 'accept_reliability_result',
  description:
    "Record a qualified reviewer's acceptance of the reliability RESULT of one limit state (any run_reliability_study methods and options; default FORM + Latin hypercube Monte Carlo with a seed). HUMAN GATE. Only a human-held signature over the acceptance payload verifies " +
    '(09 PLM signing port): an agent has none and gets PRB_HUMAN_GATE with the document unchanged. Do not work around it: hand the result over to the reviewer, who accepts it in the desktop app. ' +
    '`resultHash` is the one reported by check_probabilistic (with the same seed and samples; default methods) or run_reliability_study (pass its data.resultStudy: methods, sampling, maxIterations, tolerance, seed, samples); ' +
    'it is recomputed by re-running that study, so an acceptance of another method set or option, another seed, another model, or a changed material / entity behind a response is refused (PRB_RESULT_STALE) and ends (PRB_RESULT_STALE in check_probabilistic) when anything it depends on changes.',
  params: z.object({
    limitState: z.string().describe('Name of the limit state whose result is accepted.'),
    resultHash: z
      .string()
      .describe('The result hash reported by check_probabilistic / run_reliability_study (what the reviewer was shown).'),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .optional()
      .describe('Seed of the study the hash was computed with; required when the methods include mc or is, ignored otherwise.'),
    samples: z
      .number()
      .int()
      .min(2)
      .max(2_000_000)
      .optional()
      .describe(`Samples of that study (default ${DEFAULT_SAMPLES}); read only by mc and is.`),
    methods: resultMethodsSchema
      .optional()
      .describe(
        'Methods of the study (data.resultStudy.methods of run_reliability_study). Default ["form", "mc"] (the check_probabilistic study).',
      ),
    sampling: samplingSchema.optional().describe('Sampling scheme of the mc method of that study (default "lhs").'),
    maxIterations: maxIterationsSchema.optional().describe('HL-RF iteration limit of that study (default 100).'),
    tolerance: toleranceSchema.optional().describe('FORM tolerance of that study (default 1e-8).'),
    justification: z.string().describe('Mandatory engineering justification.'),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object from the signing port over the acceptance payload. Agents cannot produce one. Never written to the history.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { limitState, resultHash, justification, confirmation } = params;
    const study = normalizeStudy(params);
    const seed = params.seed ?? 0;
    const samples = params.samples ?? DEFAULT_SAMPLES;
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseReliability(doc, 'accept_reliability_result', code, message, [limitState], paths);
    const port = ctx?.humanSignature ?? null;
    const replayed = ctx?.replaying === true && isRecordedConfirmation(confirmation);
    if (!replayed && (port === null || confirmation === undefined))
      return fail('PRB_HUMAN_GATE', 'acceptance needs a human-held signature: hand over to the qualified reviewer, do not retry');
    if (limitStateOf(doc, limitState) === undefined)
      return fail('PRB_LIMIT_STATE_NOT_FOUND', `no limit state '${limitState}'`, ['limitState']);
    if (justification.trim() === '') return fail('PRB_PARAMS_INVALID', 'an acceptance needs a justification', ['justification']);
    if (isSampledStudy(study) && params.seed === undefined)
      return fail('PRB_PARAMS_INVALID', 'a study with mc or is needs the seed it was run with', ['seed']);
    if (doc.uid === undefined) return fail('PRB_DOCUMENT_UNIDENTIFIED', DOCUMENT_UNIDENTIFIED_TEXT);
    // a replay (history regeneration included) never re-runs the study: it would regenerate the history it is part of; the ledger entry is its only authority
    const current = ctx?.replaying === true ? null : reliabilityResult(doc, limitState, study, seed, samples, ctx);
    if (current !== null && isStudyFailure(current)) return fail(current.code, current.message, ['limitState']);
    if (current !== null && current.resultHash !== resultHash)
      return fail(
        'PRB_RESULT_STALE',
        'resultHash is not the result of this study on the current document: re-run it and hand the new result over',
        ['resultHash'],
      );
    const uid = documentIdentity(doc);
    const payloadFor = (documentUid: string): string =>
      acceptancePayload(limitState, resultHash, seed, samples, justification, documentUid);
    const kept = keptAcceptance(doc, ctx, confirmation, { limitState, resultHash, seed, samples, study, justification });
    const signed = verifiedSigner(port, kept, confirmation, payloadFor, uid);
    if (signed === null)
      return fail('PRB_HUMAN_GATE', 'the signature does not verify for this acceptance: hand over to the qualified reviewer');
    if (kept === undefined && port?.spend?.(confirmation, payloadFor(uid)) === false)
      return fail(
        'PRB_HUMAN_GATE',
        'the signature does not verify for this acceptance (already used): hand over to the qualified reviewer',
      );
    const acceptance: Acceptance = {
      modelHash: current?.modelHash ?? kept?.modelHash ?? '',
      resultHash,
      seed,
      samples,
      study,
      justification,
      signer: signed.signer,
      signatureId: signed.signatureId,
      signature: kept === undefined ? confirmation : kept.signature,
      documentUid: uid,
    };
    const model = reliabilityOf(doc);
    const next = withReliability(doc, {
      ...model,
      acceptances: { ...model.acceptances, [limitState]: acceptance },
      ...(kept === undefined ? { acceptanceLedger: [...(model.acceptanceLedger ?? []), { ...acceptance, limitState }] } : {}),
    });
    return changed(
      next,
      `accept_reliability_result: '${limitState}' accepted by ${signed.signer} (signature ${signed.signatureId}) on result ${resultHash.slice(0, 12)} (seed ${seed}, ${samples} samples).`,
      [limitState],
    );
  },
});
