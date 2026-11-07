/** GATE-UID: one check that a human signature of a gated act is bound to the document it was made for (VIS-ID), shared by every gated command. */

import { expect } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

const OTHER_UID = 'f'.repeat(32);

/** `doc` as it would be if the same content lived in another document (same entities, same state, another uid). */
const inAnotherDocument = (doc: CadDocument): CadDocument => ({ ...doc, uid: OTHER_UID });

/** A confirmation is accepted only when its `payload` is exactly the payload the command asks the port to verify; every payload is recorded. */
function pinnedPort(seen: string[] = []): HumanSignaturePort {
  return {
    verify: (confirmation, payload) => {
      seen.push(payload);
      return isRecord(confirmation) && confirmation['payload'] === payload ? { signer: 'alice', signatureId: `sig-${seen.length}` } : null;
    },
    spend: () => true,
  };
}

/**
 * Run `attempt` three times: unsigned (to learn the payload the command verifies), signed for `doc` (must clear), the same signature in `doc` copied into
 * another document (must be refused with the gate's own code, document unchanged).
 * @invariant fails when the signed payload does not name the document: the copy would verify
 */
export function expectBoundToDocument(
  doc: CadDocument,
  attempt: (document: CadDocument, confirmation: Record<string, unknown>, ctx: ExecutionContext) => CommandResult,
  gateCode: string,
  nonce = 'n1',
  /** Whether a replay of the signed document (`replay_history`, recorded steps carry `{ verified: true }`) still holds the act: omit for acts that keep no state a replay could lose. */
  keepsAcceptance?: (replayed: CadDocument, signed: CadDocument) => boolean,
): void {
  const seen: string[] = [];
  const ctx: ExecutionContext = { ...defaultContext(), humanSignature: pinnedPort(seen) };
  attempt(doc, { nonce, payload: 'unsigned' }, ctx);
  const payload = seen.at(-1);
  expect(payload, 'the command asked the port to verify nothing').toBeDefined();
  const confirmation = { nonce, payload: payload ?? '' };
  const signed = attempt(doc, confirmation, { ...defaultContext(), humanSignature: pinnedPort() });
  expect(signed.error, signed.summary).toBeUndefined();
  expect(signed.rejected, signed.summary).toBeUndefined();
  // the recorded step carries no signature object: it would reach the history, the command log and live sync (and fail as spent on replay)
  if (signed.document.featureHistory.length > doc.featureHistory.length) {
    const step = signed.document.featureHistory.at(-1);
    const holds = JSON.stringify(step?.params ?? null).includes(confirmation.payload);
    expect(holds, `the recorded step ${step?.name ?? ''} holds the signature`).toBe(false);
  }
  if (keepsAcceptance !== undefined) {
    const replayed = execute(signed.document, 'replay_history', {}, { ...defaultContext(), humanSignature: pinnedPort() }).document;
    expect(keepsAcceptance(replayed, signed.document), 'a replay lost the acceptance').toBe(true);
  }
  const copied = inAnotherDocument(doc);
  const refused = attempt(copied, confirmation, { ...defaultContext(), humanSignature: pinnedPort() });
  expect(refused.error?.code, refused.summary).toBe(gateCode);
  expect(refused.document).toBe(copied);
}

/**
 * A gate that re-verifies stored signatures refuses a document that has no uid (the signature would bind to nothing), but only after the signing port
 * and the signature: a caller without a port still gets the gate's own code.
 */
export function expectRefusesWithoutUid(
  doc: CadDocument,
  attempt: (document: CadDocument, confirmation: Record<string, unknown>, ctx: ExecutionContext) => CommandResult,
  unidentifiedCode: string,
  gateCode: string,
): void {
  const { uid, ...bare } = doc;
  void uid;
  const confirmation = { nonce: 'n1', payload: 'any' };
  const refused = attempt(bare, confirmation, { ...defaultContext(), humanSignature: pinnedPort() });
  expect(refused.error?.code, refused.summary).toBe(unidentifiedCode);
  expect(refused.document).toBe(bare);
  const agent = attempt(bare, confirmation, { ...defaultContext(), humanSignature: null });
  expect(agent.error?.code, agent.summary).toBe(gateCode);
}
