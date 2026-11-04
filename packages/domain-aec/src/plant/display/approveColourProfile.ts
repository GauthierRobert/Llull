/**
 * approve_colour_profile (plant 09 VIS §5.1, §12.7): the human act that clears `reviewRequired` of a hazard / service colour profile. A qualified reviewer signs the exact mapping
 * (rules, default colour, palette); the signer and the signature id are stored with the profile. An agent can never approve: it gets VIS_HUMAN_GATE.
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, tableRejection } from '@core/commands/noop';
import { findProfile, type ColourProfile } from '@core/model/display';
import { humanGate } from '@core/model/humanGate';
import { withDocumentUid } from '@core/model/documentUid';
import { awaitsApproval, profileSha256 as hashOf } from '@core/geometry/colourRules';

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_PROFILE_NOT_FOUND: 'list the profiles with check_display or colour_by_rule_report; apply_service_colour_scheme builds one',
  VIS_HUMAN_GATE:
    'approving a colour mapping is a human act: ask the qualified reviewer to sign in the desktop app and pass the signature object (with a nonce) as confirmation',
};
const reject = tableRejection(REMEDIATION);

/**
 * @affects sets reviewRequired false and the approval record of doc.display.colourProfiles[profileId] (affected: []); metaHistory
 * @invariant the signed payload binds the profile id, the sha256 of its name / rules / default colour / palette and the document uid; editing or replacing the profile afterwards leaves no approval; the signature is checked and spent only after every other check
 * @failure unknown profile -> VIS_PROFILE_NOT_FOUND; no valid human signature -> VIS_HUMAN_GATE; a profile that is not reviewRequired -> no-op (nothing spent)
 */
export const approveColourProfile = defineCommand({
  name: 'approve_colour_profile',
  description:
    'Approve a colour profile that awaits review (apply_service_colour_scheme flags every hazard / service profile reviewRequired): a HUMAN act. confirmation must be a signature object ' +
    '(with a nonce) a qualified reviewer produced in the desktop app over this act; it binds the profile id, a hash of its name, rules, default colour and palette, and this document, so it ' +
    'cannot be moved to another profile, an edited mapping or another document, and it is spent once. On success reviewRequired becomes false and the signer and signature id are stored with the ' +
    'profile (data.approval). An agent has no such signature: it gets VIS_HUMAN_GATE. A profile that is not awaiting review is left as it is (nothing is signed). Re-applying or redefining the ' +
    'profile removes the approval. Errors: VIS_PROFILE_NOT_FOUND, VIS_HUMAN_GATE.',
  annotations: { metaHistory: true },
  params: z.object({
    profileId: z.string().describe('Id of the profile to approve.'),
    confirmation: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'HUMAN signature { alg: "Ed25519", keyId, publicKey, signature, nonce } over this act, produced in the desktop app. An agent has none: true or a missing value is refused with VIS_HUMAN_GATE.',
      ),
  }),
  run: (doc, { profileId, confirmation }, ctx): CommandResult => {
    const profile = doc.display === undefined ? undefined : findProfile(doc.display, profileId);
    if (doc.display === undefined || profile === undefined)
      return reject(doc, 'approve_colour_profile', 'VIS_PROFILE_NOT_FOUND', `no colour profile '${profileId}'`, [], ['profileId']);
    if (!awaitsApproval(profile))
      return { document: doc, summary: `Colour profile '${profileId}' is not awaiting review; nothing approved.`, affected: [] };
    const profileSha256 = hashOf(profile);
    const outcome = humanGate(
      ctx?.humanSignature ?? null,
      'display:approve_colour_profile',
      [profileId],
      confirmation,
      withDocumentUid({ profileSha256 }, doc),
    );
    if (!outcome.cleared)
      return reject(
        doc,
        'approve_colour_profile',
        'VIS_HUMAN_GATE',
        `approving '${profileId}' is a human act: ${outcome.reason}`,
        [],
        ['confirmation'],
      );
    const approved: ColourProfile = {
      ...profile,
      reviewRequired: false,
      approval: { signer: outcome.signer, signatureId: outcome.signatureId, profileSha256 },
    };
    const display = { ...doc.display, colourProfiles: { ...doc.display.colourProfiles, [profileId]: approved } };
    return {
      ...changed({ ...doc, display }, `Approved colour profile '${profileId}' (signed by ${outcome.signer}); reviewRequired cleared.`, []),
      data: { profileId, approval: approved.approval },
    };
  },
});
