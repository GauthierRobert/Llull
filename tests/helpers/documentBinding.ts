/** GATE-UID: one check that a human signature of a gated act is bound to the document it was made for (VIS-ID), shared by every gated command. */

import { expect } from 'vitest';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

export const OTHER_UID = 'f'.repeat(32);

/** `doc` as it would be if the same content lived in another document (same entities, same state, another uid). */
export const inAnotherDocument = (doc: CadDocument): CadDocument => ({ ...doc, uid: OTHER_UID });

/** A confirmation is accepted only when its `payload` is exactly the payload the command asks the port to verify; every payload is recorded. */
export function pinnedPort(seen: string[] = []): HumanSignaturePort {
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
  const copied = inAnotherDocument(doc);
  const refused = attempt(copied, confirmation, { ...defaultContext(), humanSignature: pinnedPort() });
  expect(refused.error?.code, refused.summary).toBe(gateCode);
  expect(refused.document).toBe(copied);
}
