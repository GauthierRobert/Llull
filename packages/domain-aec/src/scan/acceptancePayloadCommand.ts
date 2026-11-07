/** scan_acceptance_payload: the SHA-256 a human signs to accept a registration or an extraction (read-only twin of the accept_* gates). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { DOCUMENT_UNIDENTIFIED_TEXT } from '@core/model/documentUid';
import { refuseScan } from './codes';
import { extractionPayload } from './extractionCommands';
import { scanOf } from './model';
import { registrationPayload } from './registrationCommands';

/**
 * @affects nothing — read-only; data { payloadSha256, act, id, nonce }
 * @invariant the hash is exactly what the matching accept_* command verifies the signature against for the same id, nonce and document
 * @failure unknown id -> SCN_REG_NOT_FOUND / SCN_EXTRACTION_NOT_FOUND; a document without uid -> SCN_DOCUMENT_UNIDENTIFIED (refusals, unchanged doc)
 */
export const scanAcceptancePayload = defineCommand({
  name: 'scan_acceptance_payload',
  annotations: { readOnly: true },
  description:
    'The SHA-256 a human signs to authorize accept_registration (act accept_registration, id = registration id) or accept_asbuilt_extraction (act ' +
    'accept_asbuilt_extraction, id = extraction id). Choose a fresh nonce: it is part of the payload and must be inside the signature object given to ' +
    'the accept command as confirmation (signing kind payload with the same nonce). Bound to this document (its uid) and the record as it is now. An agent cannot sign. Read-only.',
  params: z.object({
    act: z.enum(['accept_registration', 'accept_asbuilt_extraction']).describe('Which acceptance is signed.'),
    id: z
      .string()
      .describe('Registration id (affected[0] of apply_registration) or extraction id (affected[0] of commit_asbuilt_extraction).'),
    nonce: z.string().min(1).describe('Signer-chosen nonce; a new nonce makes a new signature, so an act undone can be signed again.'),
  }),
  run: (doc, { act, id, nonce }): CommandResult => {
    const scan = scanOf(doc);
    const registration = act === 'accept_registration' && Object.hasOwn(scan.registrations, id) ? scan.registrations[id] : undefined;
    const extraction = act === 'accept_asbuilt_extraction' && Object.hasOwn(scan.extractions, id) ? scan.extractions[id] : undefined;
    if (registration === undefined && extraction === undefined)
      return refuseScan(
        doc,
        'scan_acceptance_payload',
        act === 'accept_registration' ? 'SCN_REG_NOT_FOUND' : 'SCN_EXTRACTION_NOT_FOUND',
        `no ${act === 'accept_registration' ? 'registration' : 'extraction'} '${id}'`,
        [id],
        ['id'],
      );
    if (doc.uid === undefined)
      return refuseScan(doc, 'scan_acceptance_payload', 'SCN_DOCUMENT_UNIDENTIFIED', DOCUMENT_UNIDENTIFIED_TEXT, [id]);
    const payloadSha256 =
      registration !== undefined
        ? registrationPayload(registration, doc.uid, nonce)
        : extractionPayload(extraction as NonNullable<typeof extraction>, doc.uid, nonce);
    return report(doc, `scan_acceptance_payload: ${act} ${id}: ${payloadSha256}`, { payloadSha256, act, id, nonce });
  },
});
