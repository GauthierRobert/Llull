/** accept_reliability_result (PHY-18 TR-PRB-12): a qualified reviewer's signed acceptance of the reliability result of one limit state (human gate, AF-34). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { DOCUMENT_UNIDENTIFIED_TEXT, boundVerdict, documentIdentity } from '@core/model/documentUid';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { refuseReliability } from './codes';
import { limitStateModelHash } from './modelHash';
import { limitStateOf, reliabilityOf, withReliability } from './model';
import type { Acceptance, AcceptanceLedgerEntry } from '@cae/reliability/types';

/** SHA-256 the human signs: the acceptance of one limit state's model in the document `documentUid`. */
export const acceptancePayload = (limitState: string, modelHash: string, justification: string, documentUid: string): string =>
  sha256Hex(canonicalJson({ kind: 'reliability_acceptance', documentUid, limitState, modelHash, justification }));

export type AcceptanceCheck = { readonly valid: true } | { readonly valid: false; readonly code: string; readonly reason: string };

/**
 * Whether a stored acceptance still stands: its signature verifies through the port for its own document uid and payload, the signer matches, the
 * document is the one it was signed for, and the limit state's model hash is unchanged.
 * @invariant pure; valid only with a port; PRB_RESULT_STALE when the model changed since, PRB_HUMAN_GATE otherwise
 */
export function verifyAcceptance(
  port: HumanSignaturePort | null | undefined,
  doc: CadDocument,
  limitState: string,
  recorded: Acceptance,
): AcceptanceCheck {
  const gate = (reason: string): AcceptanceCheck => ({ valid: false, code: 'PRB_HUMAN_GATE', reason });
  if (port === null || port === undefined) return gate('no signing port on this machine: the signature cannot be re-verified');
  const { verdict, signed } = boundVerdict(port, recorded.signature, recorded.documentUid, documentIdentity(doc), (uid) =>
    acceptancePayload(limitState, recorded.modelHash, recorded.justification, uid),
  );
  if (verdict === 'unbound') return gate('the acceptance records no document uid');
  if (verdict === 'foreign') return gate('the acceptance was signed for another document (copied in)');
  if (signed === null || signed.signer !== recorded.signer || signed.signatureId !== recorded.signatureId)
    return gate('the signature does not verify for this acceptance');
  return limitStateModelHash(doc, limitState) === recorded.modelHash
    ? { valid: true }
    : { valid: false, code: 'PRB_RESULT_STALE', reason: 'the model changed after the acceptance was signed' };
}

/** The ledger entry a REPLAYED step re-applies: same limit state, model hash, justification and this document's uid; never outside a replay. */
function keptAcceptance(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  confirmation: unknown,
  wanted: { limitState: string; modelHash: string; justification: string },
): AcceptanceLedgerEntry | undefined {
  if (ctx?.replaying !== true || !isRecordedConfirmation(confirmation)) return undefined;
  return (reliabilityOf(doc).acceptanceLedger ?? []).find(
    (entry) =>
      entry.limitState === wanted.limitState &&
      entry.modelHash === wanted.modelHash &&
      entry.justification === wanted.justification &&
      entry.documentUid === documentIdentity(doc),
  );
}

/**
 * @affects doc.probabilistic.acceptances[limitState] and doc.probabilistic.acceptanceLedger (justification, modelHash, signer, signatureId, verified signature, documentUid)
 * @invariant the param is `confirmation` (never reaches the history); accepted only with a signature verified by `ctx.humanSignature` over the payload sha256 of
 *   (documentUid, limitState, modelHash, justification), spent LAST (a refusal never burns it); bound to the current model hash and to this document's uid;
 *   a replay honours a recorded step only from `probabilistic.acceptanceLedger` (kept by replaySeed), spends nothing
 * @failure no port / no confirmation / one that does not verify (an agent always lands here) -> PRB_HUMAN_GATE; unknown limit state -> PRB_LIMIT_STATE_NOT_FOUND;
 *   empty justification -> PRB_PARAMS_INVALID; no document uid -> PRB_DOCUMENT_UNIDENTIFIED; modelHash differs from the current one -> PRB_RESULT_STALE (all unchanged doc)
 */
export const acceptReliabilityResult = defineCommand({
  name: 'accept_reliability_result',
  description:
    "Record a qualified reviewer's acceptance of the reliability result of one limit state. HUMAN GATE. Only a human-held signature over the acceptance payload verifies " +
    '(09 PLM signing port): an agent has none and gets PRB_HUMAN_GATE with the document unchanged. Do not work around it: hand the result (run_reliability_study, check_probabilistic) ' +
    'over to the reviewer, who accepts it in the desktop app. `modelHash` is the one reported by describe_probabilistic_model for the limit state; the acceptance ends (PRB_RESULT_STALE in ' +
    'check_probabilistic) when the model changes.',
  params: z.object({
    limitState: z.string().describe('Name of the limit state whose result is accepted.'),
    modelHash: z.string().describe('The limit state modelHash from describe_probabilistic_model (what the reviewer was shown).'),
    justification: z.string().describe('Mandatory engineering justification.'),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object from the signing port over the acceptance payload. Agents cannot produce one. Never written to the history.',
      ),
  }),
  run: (doc, { limitState, modelHash, justification, confirmation }, ctx): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseReliability(doc, 'accept_reliability_result', code, message, [limitState], paths);
    const port = ctx?.humanSignature ?? null;
    const replayed = ctx?.replaying === true && isRecordedConfirmation(confirmation);
    if (!replayed && (port === null || confirmation === undefined))
      return fail('PRB_HUMAN_GATE', 'acceptance needs a human-held signature: hand over to the qualified reviewer, do not retry');
    if (limitStateOf(doc, limitState) === undefined)
      return fail('PRB_LIMIT_STATE_NOT_FOUND', `no limit state '${limitState}'`, ['limitState']);
    if (justification.trim() === '') return fail('PRB_PARAMS_INVALID', 'an acceptance needs a justification', ['justification']);
    if (doc.uid === undefined) return fail('PRB_DOCUMENT_UNIDENTIFIED', DOCUMENT_UNIDENTIFIED_TEXT);
    if (limitStateModelHash(doc, limitState) !== modelHash)
      return fail(
        'PRB_RESULT_STALE',
        'modelHash is not the current model of this limit state: re-run the study and hand the new result over',
        ['modelHash'],
      );
    const uid = documentIdentity(doc);
    const payloadFor = (documentUid: string): string => acceptancePayload(limitState, modelHash, justification, documentUid);
    const kept = keptAcceptance(doc, ctx, confirmation, { limitState, modelHash, justification });
    let signed: { signer: string; signatureId: string } | null;
    if (kept !== undefined) {
      const again =
        port === null ? { signer: kept.signer, signatureId: kept.signatureId } : port.verify(kept.signature, payloadFor(kept.documentUid));
      signed = again !== null && again.signer === kept.signer && again.signatureId === kept.signatureId ? again : null;
    } else signed = port === null ? null : port.verify(confirmation, payloadFor(uid));
    if (signed === null)
      return fail('PRB_HUMAN_GATE', 'the signature does not verify for this acceptance: hand over to the qualified reviewer');
    if (kept === undefined && port?.spend?.(confirmation, payloadFor(uid)) === false)
      return fail(
        'PRB_HUMAN_GATE',
        'the signature does not verify for this acceptance (already used): hand over to the qualified reviewer',
      );
    const acceptance: Acceptance = {
      modelHash,
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
      `accept_reliability_result: '${limitState}' accepted by ${signed.signer} (signature ${signed.signatureId}) on model ${modelHash.slice(0, 12)}.`,
      [limitState],
    );
  },
});
