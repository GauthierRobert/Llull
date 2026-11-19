/** dispose_acoustic_export (PHY-20 TR-VAC-30, AF-34): the qualified reviewer's signed disposition of the acoustic load package of one exposure. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { documentIdentity } from '@core/model/documentUid';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { is3D } from '@core/model/types';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { nonceOf } from '../shared/signedGate';
import { refuseVac } from './codes';
import { MAX_JUSTIFICATION, exposureOf, reviewOf, spectrumOf, withReview } from './model';
import { REVIEW_ACT, exposureFingerprint, reviewDetails } from './review';
import { REVIEW_DECISIONS, type AcousticReview } from './types';

const COMMAND = 'dispose_acoustic_export';

/**
 * @affects doc.vibroacoustics.reviews[exposure] (decision, justification, fingerprint of the exposure as reviewed, signer, signatureId, the verified signature, document uid; affected: [exposure]); never changes the exposure, its spectrum or a number of the package
 * @invariant the param is `confirmation` (never reaches the history: execute records { verified: true }); recorded only with a signature verified (and spent last) by `ctx.humanSignature` over sha256 of
 *   (act, exposure, decision, justification, fingerprint, document uid, nonce); it applies only while the fingerprint is unchanged (export_acoustic_load compares it) and in this document; every export re-verifies it
 *   (no port, foreign uid, junk signature: VAC_REVIEW_PENDING stays); a replay honours a recorded step only from a review already in the slice (kept by replaySeed) with the same decision, justification,
 *   fingerprint and uid, its signature re-verified when a port is installed
 * @failure no signing port, no signature or one that does not verify (an agent always) -> VAC_HUMAN_GATE; blank justification -> VAC_PARAMS_INVALID; unknown exposure / spectrum -> VAC_EXPOSURE_UNKNOWN / VAC_SPECTRUM_UNKNOWN;
 *   target not a 3D solid -> VAC_EXPOSURE_UNRESOLVED; a document without uid -> VAC_DOCUMENT_UNIDENTIFIED (all refusals, unchanged doc)
 */
export const disposeAcousticExport = defineCommand({
  name: COMMAND,
  description:
    "Record a qualified reviewer's disposition (accepted | rejected) of the acoustic load package of ONE exposure (export_acoustic_load). HUMAN GATE. " +
    'Only a human-held signature over this exact exposure verifies (09 PLM signing port): an agent has none and always gets VAC_HUMAN_GATE with the document unchanged. Do not retry or work around it: ' +
    'hand the package to the reviewer, who decides in the desktop app. An accepted, re-verified disposition removes VAC_REVIEW_PENDING from the package; a rejected one adds VAC_REVIEW_REJECTED. ' +
    'It never changes a number of the package; it ends when the exposure, its spectrum or the target solid changes (a different review.fingerprint in the package) and is void in a copy of the document.',
  params: z.object({
    exposure: z.string().describe('Name of the exposure whose package is disposed (define_acoustic_exposure).'),
    decision: z.enum(REVIEW_DECISIONS).describe("The reviewer's decision."),
    justification: z
      .string()
      .max(MAX_JUSTIFICATION)
      .describe(
        `Mandatory engineering justification (non-empty, at most ${MAX_JUSTIFICATION} characters), e.g. the review record reference.`,
      ),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object (with a nonce field) from the signing port. Agents cannot produce one. Never written to the history.',
      ),
  }),
  run: (doc, { exposure: name, decision, justification, confirmation }, ctx): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = ['exposure']): CommandResult =>
      refuseVac(doc, COMMAND, code, message, [name], paths);
    const port = ctx?.humanSignature ?? null;
    const replayed = ctx?.replaying === true && isRecordedConfirmation(confirmation);
    if (!replayed && (port === null || confirmation === undefined || typeof confirmation !== 'object' || confirmation === null))
      return fail(
        'VAC_HUMAN_GATE',
        'disposing an acoustic load package needs a human-held signature: hand it to the qualified reviewer, do not retry',
        ['confirmation'],
      );
    if (justification.trim() === '') return fail('VAC_PARAMS_INVALID', 'a disposition needs a justification', ['justification']);
    const exposure = exposureOf(doc, name);
    if (exposure === undefined) return fail('VAC_EXPOSURE_UNKNOWN', `no exposure '${name}'`);
    const spectrum = spectrumOf(doc, exposure.spectrum);
    if (spectrum === undefined) return fail('VAC_SPECTRUM_UNKNOWN', `exposure '${name}' names no spectrum '${exposure.spectrum}'`);
    const entityId = exposure.target.entityId;
    const target = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (target === undefined || !is3D(target))
      return fail('VAC_EXPOSURE_UNRESOLVED', `target '${entityId}' is not a 3D solid of the document`);
    const fingerprint = exposureFingerprint(doc, exposure, spectrum, target);
    const uid = documentIdentity(doc);
    const kept = replayed ? reviewOf(doc, name) : undefined;
    const keptMatches =
      kept !== undefined &&
      kept.decision === decision &&
      kept.justification === justification &&
      kept.fingerprint === fingerprint &&
      kept.documentUid === uid;
    if (replayed && !keptMatches)
      return fail('VAC_HUMAN_GATE', 'a replayed disposition is honoured only from the one a human signed in this document', [
        'confirmation',
      ]);
    if (doc.uid === undefined) return fail('VAC_DOCUMENT_UNIDENTIFIED', 'the document has no uid yet', []);
    if (kept !== undefined && keptMatches) {
      const signed = port?.verify(
        kept.signature,
        humanGatePayload(REVIEW_ACT, [name], reviewDetails(decision, justification, fingerprint, uid), nonceOf(kept.signature)),
      );
      if (port !== null && (signed === null || signed === undefined || signed.signer !== kept.signer))
        return fail('VAC_HUMAN_GATE', 'the kept signature of this disposition does not verify', ['confirmation']);
      return changed(doc, `${COMMAND}: '${name}' ${decision} by ${kept.signer} (replayed).`, [name]);
    }
    const gate = humanGate(port, REVIEW_ACT, [name], confirmation, reviewDetails(decision, justification, fingerprint, uid));
    if (!gate.cleared) return fail('VAC_HUMAN_GATE', gate.reason, ['confirmation']);
    const review: AcousticReview = {
      exposure: name,
      decision,
      justification,
      fingerprint,
      signer: gate.signer,
      signatureId: gate.signatureId,
      signature: confirmation,
      documentUid: uid,
    };
    return changed(
      withReview(doc, review),
      `${COMMAND}: package of '${name}' ${decision} by ${gate.signer} (signature ${gate.signatureId}, fingerprint ${fingerprint.slice(0, 12)}); the exposure and its spectrum are unchanged.`,
      [name],
    );
  },
});
