/** accept_corrosion_item (PHY-13 FR-COR-17, TR-COR-15, AF-34): the human gate on one finding of check_material_compatibility. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { documentIdentity } from '@core/model/documentUid';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { refuseCor } from './codes';
import type { CompatibilityItem } from './items';
import { corrosionOf, withCorrosion } from './model';
import type { Acceptance } from './types';

const COMMAND = 'accept_corrosion_item';
const ACT = 'accept or reject a corrosion compatibility item';

const nonceOf = (signature: unknown): string =>
  typeof signature === 'object' && signature !== null && typeof (signature as { nonce?: unknown }).nonce === 'string'
    ? (signature as { nonce: string }).nonce
    : '';

const detailsOf = (decision: string, justification: string, fingerprint: string, documentUid: string): Record<string, unknown> => ({
  decision,
  justification,
  fingerprint,
  documentUid,
});

/**
 * @affects doc.corrosion.acceptances[itemKey] (decision, justification, fingerprint of the finding, signer, signatureId, the verified signature, document uid; affected: [itemKey]); never changes an item's status or number
 * @invariant the param is `confirmation` (never reaches the history: execute records { verified: true }); recorded only with a signature verified (and spent last) by `ctx.humanSignature` over sha256 of
 *   (act, item key, decision, justification, finding fingerprint, document uid, nonce); it applies only while the finding is unchanged (the check compares the fingerprint) and in this document; a replay honours a
 *   recorded step only from an acceptance already in the slice (kept by replaySeed) with the same decision, justification, fingerprint and uid, its signature re-verified when a port is installed
 * @failure no signing port, no signature or one that does not verify (an agent always) -> COR_HUMAN_GATE; no environment -> COR_ENVIRONMENT_UNSET; unknown key -> COR_ITEM_NOT_FOUND; a pass / pass_isolated item ->
 *   COR_ITEM_NOT_ACCEPTABLE; blank justification -> COR_PARAMS_INVALID; a document without uid -> COR_DOCUMENT_UNIDENTIFIED (all refusals, unchanged doc)
 */
export const acceptCorrosionItem = defineCommand({
  name: COMMAND,
  description:
    'Record a qualified reviewer\'s decision (accepted | rejected) on ONE finding of check_material_compatibility (item key e.g. "galvanic:box-1.1|box-2.1", status warn, fail or unknown). HUMAN GATE. ' +
    'Only a human-held signature over this exact finding verifies (09 PLM signing port): an agent has none and always gets COR_HUMAN_GATE with the document unchanged. Do not retry or work around it: ' +
    "hand the item to the reviewer, who decides it in the desktop app. The decision never changes the item's status or any number; it ends when the finding changes (a different fingerprint) and is void in a copy of the document. " +
    'Pass the same entityIds / tolerance as the check so the key resolves.',
  params: z.object({
    itemKey: z.string().describe('Item key from check_material_compatibility, e.g. "galvanic:box-1.1|box-2.1".'),
    decision: z.enum(['accepted', 'rejected']).describe("The reviewer's decision."),
    justification: z.string().describe('Mandatory engineering justification (non-empty).'),
    entityIds: z.array(z.string()).optional().describe('Same scope as the check that reported the item.'),
    tolerance: z
      .object({ value: z.number().describe('Positive, finite.'), unit: z.enum(['mm', 'cm', 'm', 'in', 'ft']).describe('Length unit.') })
      .optional()
      .describe('Same contact tolerance as the check that reported the item.'),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object (with a nonce field) from the signing port. Agents cannot produce one. Never written to the history.',
      ),
  }),
  run: (doc, { itemKey, decision, justification, entityIds, tolerance, confirmation }, ctx): CommandResult => {
    const fail = (code: string, message: string): CommandResult => refuseCor(doc, COMMAND, code, message, [itemKey], ['itemKey']);
    const port = ctx?.humanSignature ?? null;
    const replayed = ctx?.replaying === true && isRecordedConfirmation(confirmation);
    if (!replayed && (port === null || confirmation === undefined || typeof confirmation !== 'object' || confirmation === null))
      return fail(
        'COR_HUMAN_GATE',
        'accepting a corrosion item needs a human-held signature: hand it to the qualified reviewer, do not retry',
      );
    if (justification.trim() === '') return fail('COR_PARAMS_INVALID', 'a decision needs a justification');
    const checked = execute(
      doc,
      'check_material_compatibility',
      { ...(entityIds === undefined ? {} : { entityIds }), ...(tolerance === undefined ? {} : { tolerance }) },
      ctx,
    );
    if (checked.error !== undefined) return { ...checked, summary: `${COMMAND}: ${checked.summary}` };
    const items = (checked.data as { items: readonly CompatibilityItem[] }).items;
    const item = items.find((candidate) => candidate.key === itemKey);
    if (item === undefined) return fail('COR_ITEM_NOT_FOUND', `no item '${itemKey}' among the ${items.length} reported`);
    if (item.status === 'pass' || item.status === 'pass_isolated')
      return fail('COR_ITEM_NOT_ACCEPTABLE', `'${itemKey}' is ${item.status}: nothing to decide`);
    const uid = documentIdentity(doc);
    const stored = corrosionOf(doc).acceptances;
    const kept: Acceptance | undefined = replayed && Object.hasOwn(stored, itemKey) ? stored[itemKey] : undefined;
    const keptMatches =
      kept !== undefined &&
      kept.decision === decision &&
      kept.justification === justification &&
      kept.fingerprint === item.fingerprint &&
      kept.documentUid === uid;
    if (replayed && !keptMatches)
      return fail('COR_HUMAN_GATE', 'a replayed acceptance is honoured only from the one a human signed in this document');
    if (doc.uid === undefined) return fail('COR_DOCUMENT_UNIDENTIFIED', 'the document has no uid yet');
    if (kept !== undefined && keptMatches) {
      const signed = port?.verify(
        kept.signature,
        humanGatePayload(ACT, [itemKey], detailsOf(decision, justification, item.fingerprint, uid), nonceOf(kept.signature)),
      );
      if (port !== null && (signed === null || signed === undefined || signed.signer !== kept.signer))
        return fail('COR_HUMAN_GATE', 'the kept signature of this acceptance does not verify');
      return changed(doc, `${COMMAND}: '${itemKey}' ${decision} by ${kept.signer} (replayed).`, [itemKey]);
    }
    const gate = humanGate(port, ACT, [itemKey], confirmation, detailsOf(decision, justification, item.fingerprint, uid));
    if (!gate.cleared) return fail('COR_HUMAN_GATE', gate.reason);
    const acceptance: Acceptance = {
      itemKey,
      decision,
      justification,
      fingerprint: item.fingerprint,
      signer: gate.signer,
      signatureId: gate.signatureId,
      signature: confirmation,
      documentUid: uid,
    };
    return changed(
      withCorrosion(doc, { acceptances: { ...stored, [itemKey]: acceptance } }),
      `${COMMAND}: '${itemKey}' (${item.status} ${item.code}) ${decision} by ${gate.signer} (signature ${gate.signatureId}); the finding itself is unchanged.`,
      [itemKey],
    );
  },
});
