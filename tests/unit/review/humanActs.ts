/** Test helpers for the human-gated review acts: a ledger-backed scripted port (single-use signatures) and signed act builders. */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

/**
 * A scripted port with a spend ledger: a confirmation verifies when its `signature` IS the payload and its key is trusted (the signer is `keyId`), and
 * spends once. `trust` scripts the key: 'untrusted' = unknown to the store (an agent's own pair), 'revoked' = a revoked record of user `revokedUser`.
 * Both still carry cryptographically valid signatures; only 'revoked' lets `revokedSignerOf` name the record's user.
 */
export function ledgerPort(trust: 'trusted' | 'untrusted' | 'revoked' = 'trusted', revokedUser = 'grace'): HumanSignaturePort {
  const used = new Set<string>();
  const valid = (confirmation: unknown, payload: string): confirmation is Record<string, string> =>
    isRecord(confirmation) && confirmation['signature'] === payload && typeof confirmation['keyId'] === 'string';
  return {
    verify: (confirmation, payload) =>
      trust === 'trusted' && valid(confirmation, payload)
        ? { signer: confirmation['keyId'] ?? '', signatureId: `fake:${confirmation['keyId']}` }
        : null,
    revokedSignerOf: (confirmation, payload) => (trust === 'revoked' && valid(confirmation, payload) ? revokedUser : null),
    keyTrust: () => (trust === 'trusted' ? 'trusted' : 'untrusted'),
    spend: (signature, payload) => {
      const key = `${JSON.stringify(signature)}|${payload}`;
      if (used.has(key)) return false;
      used.add(key);
      return true;
    },
  };
}

export const humanCtx = (port: HumanSignaturePort = ledgerPort()): ExecutionContext => ({ ...defaultContext(), humanSignature: port });

/** A confirmation over exactly the payload that review_act_payload reports for `params` in `doc`. */
export function confirmationOver(doc: CadDocument, params: Record<string, unknown>, as = 'grace', nonce = 'n-1'): Record<string, unknown> {
  const payload = execute(doc, 'review_act_payload', { ...params, nonce }).data as { payloadSha256: string };
  return { alg: 'Ed25519', keyId: as, publicKey: 'ab'.repeat(32), nonce, signature: payload.payloadSha256 };
}

/** delete_review_issue signed by a human (fresh ledger unless `ctx` is given). */
export function deleteIssue(doc: CadDocument, id: string, ctx: ExecutionContext = humanCtx(), nonce = 'd-1'): CommandResult {
  const confirmation = confirmationOver(doc, { issueId: id, act: 'delete_review_issue' }, 'grace', nonce);
  return execute(doc, 'delete_review_issue', { id, confirmation }, ctx);
}
