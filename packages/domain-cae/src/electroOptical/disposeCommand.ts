/** dispose_bond_check (PHY-15 FR-EOP-07, TR-EOP-22, AF-34): the human gate on a failed or unknown bond path. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { documentIdentity } from '@core/model/documentUid';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { checkedRows } from './checkBonding';
import { refuseEop } from './codes';
import { DISPOSE_ACT, dispositionDetails } from './gate';
import { nonceOf } from '../shared/signedGate';
import { dispositionOf, electroOpticalOf, withElectroOptical } from './model';
import { DISPOSITIONS, type BondDisposition } from './types';

const COMMAND = 'dispose_bond_check';

/**
 * @affects doc.electroOptical.dispositions[pathId] (decision, justification, inputsHash of the path as checked, signer, signatureId, the verified signature, document uid; affected: [pathId]); never changes a row's status or number
 * @invariant the param is `confirmation` (never reaches the history: execute records { verified: true }); recorded only with a signature verified (and spent last) by `ctx.humanSignature` over sha256 of
 *   (act, path id, decision, justification, inputsHash, document uid, nonce); it applies only while the path is unchanged (check_bonding compares inputsHash) and in this document; with no signing port a replay trusts the kept record only for the replay itself: every later check_bonding re-verifies it and, with no port, reports it unconfirmed (never accepted); a replay honours a recorded step only from a
 *   disposition already in the slice (kept by replaySeed) with the same decision, justification, inputsHash and uid
 * @failure no signing port, no signature or one that does not verify (an agent always) -> EOP_HUMAN_GATE; unknown path -> EOP_PATH_NOT_FOUND; a passing path -> EOP_NOTHING_TO_DISPOSE; blank justification -> EOP_PARAMS_INVALID;
 *   a document without uid -> EOP_DOCUMENT_UNIDENTIFIED (all refusals, unchanged doc)
 */
export const disposeBondCheck = defineCommand({
  name: COMMAND,
  description:
    "Record a qualified reviewer's disposition (accepted | rejected | redesign) of ONE bond path that check_bonding reports as fail or unknown. HUMAN GATE. " +
    'Only a human-held signature over this exact path verifies (09 PLM signing port): an agent has none and always gets EOP_HUMAN_GATE with the document unchanged. Do not retry or work around it: ' +
    'hand the path to the reviewer, who decides in the desktop app. The decision never changes a status or a number; it ends when the path changes (a different inputsHash) and is void in a copy of the document.',
  params: z.object({
    pathId: z.string().describe('Bond path id from check_bonding.'),
    decision: z.enum(DISPOSITIONS).describe("The reviewer's decision."),
    justification: z.string().describe('Mandatory engineering justification (non-empty).'),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object (with a nonce field) from the signing port. Agents cannot produce one. Never written to the history.',
      ),
  }),
  run: (doc, { pathId, decision, justification, confirmation }, ctx): CommandResult => {
    const fail = (code: string, message: string): CommandResult => refuseEop(doc, COMMAND, code, message, [pathId], ['pathId']);
    const port = ctx?.humanSignature ?? null;
    const replayed = ctx?.replaying === true && isRecordedConfirmation(confirmation);
    if (!replayed && (port === null || confirmation === undefined || typeof confirmation !== 'object' || confirmation === null))
      return fail('EOP_HUMAN_GATE', 'disposing a bond check needs a human-held signature: hand it to the qualified reviewer, do not retry');
    if (justification.trim() === '') return fail('EOP_PARAMS_INVALID', 'a disposition needs a justification');
    const rows = checkedRows(doc, [pathId], ctx);
    if (!Array.isArray(rows)) return rows;
    const row = rows[0];
    if (row === undefined) return fail('EOP_PATH_NOT_FOUND', `no bond path '${pathId}'`);
    if (row.status === 'pass') return fail('EOP_NOTHING_TO_DISPOSE', `'${pathId}' passes: nothing to decide`);
    const uid = documentIdentity(doc);
    const kept: BondDisposition | undefined = replayed ? dispositionOf(doc, pathId) : undefined;
    const keptMatches =
      kept !== undefined &&
      kept.decision === decision &&
      kept.justification === justification &&
      kept.inputsHash === row.inputsHash &&
      kept.documentUid === uid;
    if (replayed && !keptMatches)
      return fail('EOP_HUMAN_GATE', 'a replayed disposition is honoured only from the one a human signed in this document');
    if (doc.uid === undefined) return fail('EOP_DOCUMENT_UNIDENTIFIED', 'the document has no uid yet');
    if (kept !== undefined && keptMatches) {
      const signed = port?.verify(
        kept.signature,
        humanGatePayload(DISPOSE_ACT, [pathId], dispositionDetails(decision, justification, row.inputsHash, uid), nonceOf(kept.signature)),
      );
      if (port !== null && (signed === null || signed === undefined || signed.signer !== kept.signer))
        return fail('EOP_HUMAN_GATE', 'the kept signature of this disposition does not verify');
      return changed(doc, `${COMMAND}: '${pathId}' ${decision} by ${kept.signer} (replayed).`, [pathId]);
    }
    const gate = humanGate(port, DISPOSE_ACT, [pathId], confirmation, dispositionDetails(decision, justification, row.inputsHash, uid));
    if (!gate.cleared) return fail('EOP_HUMAN_GATE', gate.reason);
    const disposition: BondDisposition = {
      pathId,
      decision,
      justification,
      inputsHash: row.inputsHash,
      signer: gate.signer,
      signatureId: gate.signatureId,
      signature: confirmation,
      documentUid: uid,
    };
    return changed(
      withElectroOptical(doc, { dispositions: { ...electroOpticalOf(doc).dispositions, [pathId]: disposition } }),
      `${COMMAND}: '${pathId}' (${row.status} ${row.code ?? ''}) ${decision} by ${gate.signer} (signature ${gate.signatureId}); the path itself is unchanged.`,
      [pathId],
    );
  },
});
