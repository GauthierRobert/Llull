/** Test helpers for the human-gated review acts: a ledger-backed scripted port (single-use signatures) and signed act builders. */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { fakePort } from '../plm/fakePort';

/** The scripted PLM port plus a spend ledger: a (signature, payload) pair verifies and spends once, then `spend` answers false. */
export function ledgerPort(): HumanSignaturePort {
  const used = new Set<string>();
  return {
    ...fakePort(),
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
  return { alg: 'Ed25519', as, nonce, signature: payload.payloadSha256 };
}

/** delete_review_issue signed by a human (fresh ledger unless `ctx` is given). */
export function deleteIssue(doc: CadDocument, id: string, ctx: ExecutionContext = humanCtx(), nonce = 'd-1'): CommandResult {
  const confirmation = confirmationOver(doc, { issueId: id, act: 'delete_review_issue' }, 'grace', nonce);
  return execute(doc, 'delete_review_issue', { id, confirmation }, ctx);
}
