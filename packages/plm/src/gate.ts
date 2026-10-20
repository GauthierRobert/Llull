/**
 * The human gate of PLM acts (AF-34, TR-PLM-16): a human-only act needs `confirmation`, a verified Ed25519 signature by a TRUSTED key over a payload bound to
 * this act, this document's PLM state and these params (`humanGate`). Nothing a caller says about itself counts; the signer is the key record's user.
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { refusePlm } from './refusal';
import { scopeOf } from './state';

/** Params that are host-filled or the proof itself: not part of what a human signs. */
const UNSIGNED = new Set(['confirmation', 'at', 'by']);

/** Acts that also bind the document definition (its release-scope hash): the human signs what they saw, not just the PLM record. */
const BINDS_CONTENT = new Set(['release_item', 'record_approval', 'set_item_marking']);

/** The act, ids and details a human signs for `command` with `params` on `doc` (the state hash binds the signature to this exact PLM state). */
export function actParts(
  doc: CadDocument,
  command: string,
  params: Readonly<Record<string, unknown>>,
  ctx?: ExecutionContext,
): { readonly act: string; readonly ids: readonly string[]; readonly details: Readonly<Record<string, unknown>> } {
  const signed = Object.fromEntries(Object.entries(params).filter(([key]) => !UNSIGNED.has(key)));
  const partNumber = doc.plm?.item.partNumber ?? '';
  return {
    act: `plm:${command}`,
    ids: [partNumber],
    details: {
      stateHash: sha256Hex(jcsJson(doc.plm ?? null)),
      ...(BINDS_CONTENT.has(command) ? { contentHash: scopeOf(doc, ctx).sha256 } : {}),
      params: signed,
    },
  };
}

/** The SHA-256 a human signs (with the nonce they choose) to authorize `command` with `params` on `doc`. */
export function actPayload(
  doc: CadDocument,
  command: string,
  params: Readonly<Record<string, unknown>>,
  nonce: string,
  ctx?: ExecutionContext,
): string {
  const { act, ids, details } = actParts(doc, command, params, ctx);
  return humanGatePayload(act, ids, details, nonce);
}

export type ActGate = { readonly refusal: CommandResult } | { readonly signer: string };

/** Clear a human-only act: the verified signer, or the `PLM_HUMAN_GATE` refusal (no port, no / bad / foreign signature, untrusted key). */
export function humanAct(
  doc: CadDocument,
  command: string,
  params: Readonly<Record<string, unknown>>,
  ctx: ExecutionContext | undefined,
): ActGate {
  const { act, ids, details } = actParts(doc, command, params, ctx);
  const outcome = humanGate(ctx?.humanSignature ?? null, act, ids, params['confirmation'], details);
  if (outcome.cleared) return { signer: outcome.signer };
  return { refusal: refusePlm(doc, command, 'PLM_HUMAN_GATE', `${command} is a human act: ${outcome.reason}`, ids) };
}
