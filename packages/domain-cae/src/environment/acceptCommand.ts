/** approve_environment_deviation (PHY-14 FR-ENV-13, TR-ENV-10, AF-34): the human gate on one finding of check_space_environment. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { documentIdentity } from '@core/model/documentUid';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { refuseEnv } from './codes';
import { DEVIATION_ACT, acceptanceDetails, nonceOf } from './gate';
import type { ReviewedItem } from './deviations';
import { spaceEnvironmentOf } from './model';
import type { Deviation } from './types';

const COMMAND = 'approve_environment_deviation';

/**
 * @affects doc.spaceEnvironment.deviations[itemKey] (decision, justification, fingerprint of the finding, signer, signatureId, the verified signature, document uid; affected: [itemKey]); never changes an item's status or any number
 * @invariant the param is `confirmation` (never reaches the history: execute records { verified: true }); recorded only with a signature verified (and spent last) by `ctx.humanSignature` over sha256 of (act, item key, decision,
 *   justification, finding fingerprint, document uid, nonce); it applies only while the finding is unchanged and in this document; every check_space_environment re-verifies it (no port, foreign uid, junk signature: the item stays in the status);
 *   a replay honours a recorded step only from a deviation already in the slice (kept by replaySeed) with the same decision, justification, fingerprint and uid
 * @failure no signing port, no signature or one that does not verify (an agent always) -> ENV_HUMAN_GATE; unknown key -> ENV_ITEM_NOT_FOUND; a pass item -> ENV_ITEM_NOT_ACCEPTABLE; blank justification -> ENV_PARAM_INVALID; a document without uid -> ENV_DOCUMENT_UNIDENTIFIED; no profile / unknown profile -> the check's refusal (all refusals, unchanged doc)
 */
export const approveEnvironmentDeviation = defineCommand({
  name: COMMAND,
  description:
    'Record a qualified reviewer decision (accepted | rejected) on ONE finding of check_space_environment (item key e.g. "outgassing:syn_water|TML", status fail or unknown). HUMAN GATE. ' +
    'Only a human-held signature over this exact finding verifies (09 PLM signing port): an agent has none and always gets ENV_HUMAN_GATE with the document unchanged. Do not retry or work around it: ' +
    "hand the item to the reviewer, who decides it in the desktop app. The decision never changes the item's status or any number; it ends when the finding changes (a different fingerprint) and is void in a copy of the document. " +
    'Pass the same entityIds / profile as the check so the key resolves.',
  params: z.object({
    itemKey: z.string().describe('Item key from check_space_environment, e.g. "outgassing:syn_water|TML".'),
    decision: z.enum(['accepted', 'rejected']).describe("The reviewer's decision."),
    justification: z.string().describe('Mandatory engineering justification (non-empty), e.g. the program deviation reference.'),
    entityIds: z.array(z.string()).optional().describe('Same scope as the check that reported the item.'),
    profile: z.string().optional().describe('Same profile as the check that reported the item.'),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object (with a nonce field) from the signing port. Agents cannot produce one. Never written to the history.',
      ),
  }),
  run: (doc, { itemKey, decision, justification, entityIds, profile, confirmation }, ctx): CommandResult => {
    const fail = (code: string, message: string): CommandResult => refuseEnv(doc, COMMAND, code, message, [itemKey], ['itemKey']);
    const port = ctx?.humanSignature ?? null;
    const replayed = ctx?.replaying === true && isRecordedConfirmation(confirmation);
    if (!replayed && (port === null || confirmation === undefined || typeof confirmation !== 'object' || confirmation === null))
      return fail(
        'ENV_HUMAN_GATE',
        'approving an environment deviation needs a human-held signature: hand it to the qualified reviewer, do not retry',
      );
    if (justification.trim() === '') return fail('ENV_PARAM_INVALID', 'a decision needs a justification');
    const checked = execute(
      doc,
      'check_space_environment',
      { ...(entityIds === undefined ? {} : { entityIds }), ...(profile === undefined ? {} : { profile }) },
      ctx,
    );
    if (checked.error !== undefined) return { ...checked, summary: `${COMMAND}: ${checked.summary}` };
    const items = (checked.data as { items: readonly ReviewedItem[] }).items;
    const item = items.find((candidate) => candidate.key === itemKey);
    if (item === undefined) return fail('ENV_ITEM_NOT_FOUND', `no item '${itemKey}' among the ${items.length} reported`);
    if (item.status === 'pass') return fail('ENV_ITEM_NOT_ACCEPTABLE', `'${itemKey}' is pass: nothing to decide`);
    const uid = documentIdentity(doc);
    const stored = spaceEnvironmentOf(doc).deviations ?? {};
    const kept: Deviation | undefined = replayed && Object.hasOwn(stored, itemKey) ? stored[itemKey] : undefined;
    const keptMatches =
      kept !== undefined &&
      kept.decision === decision &&
      kept.justification === justification &&
      kept.fingerprint === item.fingerprint &&
      kept.documentUid === uid;
    if (replayed && !keptMatches)
      return fail('ENV_HUMAN_GATE', 'a replayed deviation is honoured only from the one a human signed in this document');
    if (doc.uid === undefined) return fail('ENV_DOCUMENT_UNIDENTIFIED', 'the document has no uid yet');
    if (kept !== undefined && keptMatches) {
      const signed = port?.verify(
        kept.signature,
        humanGatePayload(
          DEVIATION_ACT,
          [itemKey],
          acceptanceDetails(decision, justification, item.fingerprint, uid),
          nonceOf(kept.signature),
        ),
      );
      if (port !== null && (signed === null || signed === undefined || signed.signer !== kept.signer))
        return fail('ENV_HUMAN_GATE', 'the kept signature of this deviation does not verify');
      return changed(doc, `${COMMAND}: '${itemKey}' ${decision} by ${kept.signer} (replayed).`, [itemKey]);
    }
    const gate = humanGate(port, DEVIATION_ACT, [itemKey], confirmation, acceptanceDetails(decision, justification, item.fingerprint, uid));
    if (!gate.cleared) return fail('ENV_HUMAN_GATE', gate.reason);
    const deviation: Deviation = {
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
      { ...doc, spaceEnvironment: { ...spaceEnvironmentOf(doc), deviations: { ...stored, [itemKey]: deviation } } },
      `${COMMAND}: '${itemKey}' (${item.status} ${item.code ?? ''}) ${decision} by ${gate.signer} (signature ${gate.signatureId}); the finding itself is unchanged.`,
      [itemKey],
    );
  },
});
