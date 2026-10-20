/** set_item_identity / set_revision_scheme / set_item_marking: configuration identification (FR-PLM-01/02/25). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { PlmPolicy } from '@core/model/plm';
import { PART_NUMBER } from '../document';
import { refusePlm } from '../refusal';
import { DEFAULT_SCHEME, isKnownScheme, isValidCustomList, revisionLabel } from '../schemes';
import { DEFAULT_POLICY, NOT_MANAGED, scopeHash } from '../state';
import { humanAct } from '../gate';
import { openRevision, withPlm } from '../revisions';
import { atSchema, bySchema, confirmationSchema } from '../params';

const policySchema = z
  .object({
    requireChangeOrder: z
      .boolean()
      .optional()
      .describe('Revising and releasing a later revision needs an open ECO listing the item. Default true.'),
    requireIndependentChecker: z
      .boolean()
      .optional()
      .describe('The checker approval must come from a different user than the author. Default true.'),
    requiredApprovalRoles: z
      .array(z.string())
      .optional()
      .describe("Roles that must approve before release. Default ['design-authority','checker']."),
    humanSignatureRequired: z
      .boolean()
      .optional()
      .describe('Release needs a recorded human Ed25519 approval signature (needs a signing host). Default true.'),
    requireMarking: z
      .boolean()
      .optional()
      .describe("Submit for review is refused while the export marking regime is 'undetermined'. Default false."),
  })
  .describe('Policy overrides (human-only: an agent caller is refused).');

function mergedPolicy(base: PlmPolicy, patch: z.infer<typeof policySchema> | undefined, customLabels: readonly string[]): PlmPolicy {
  return {
    requireChangeOrder: patch?.requireChangeOrder ?? base.requireChangeOrder,
    requireIndependentChecker: patch?.requireIndependentChecker ?? base.requireIndependentChecker,
    requiredApprovalRoles: patch?.requiredApprovalRoles ?? base.requiredApprovalRoles,
    humanSignatureRequired: patch?.humanSignatureRequired ?? base.humanSignatureRequired,
    requireMarking: patch?.requireMarking ?? base.requireMarking,
    ...(customLabels.length > 0 ? { customLabels } : {}),
  };
}

/**
 * @affects doc.plm (creates or replaces the managed item; revision 1 = first label of the scheme, in_work, iteration 1 with the current content hash)
 * @invariant identity is immutable once the item has more than one revision or its revision left in_work
 * @failure invalid part number -> PLM_PN_INVALID; unknown scheme / bad custom list -> PLM_SCHEME_INVALID; after review or release -> PLM_IDENTITY_FROZEN;
 *   policy given by an agent caller -> PLM_HUMAN_GATE (all refusals, unchanged doc)
 */
export const setItemIdentity = defineCommand({
  name: 'set_item_identity',
  description:
    'Make this document a managed configuration item: part number, name, item type and revision scheme. Creates revision 1 (asme-alpha: A) in state ' +
    'in_work, iteration 1. Calling it again before review renames / re-schemes the item. After submit_for_review or a release the identity is frozen ' +
    '(PLM_IDENTITY_FROZEN). Passing `policy` is a human act. Next: edit the model, then submit_for_review.',
  annotations: { metaHistory: true },
  params: z.object({
    partNumber: z.string().describe('Part number: A-Z, 0-9, . _ - / (max 64 characters, starts with a letter or digit), e.g. LL-1001.'),
    name: z.string().min(1).describe('Item name, e.g. "Bracket, hinge fitting".'),
    itemType: z.enum(['part', 'assembly', 'drawing', 'document']).describe('Kind of managed item.'),
    revisionScheme: z
      .string()
      .optional()
      .describe(
        "Revision label scheme: 'asme-alpha' (default: A..Y without I O Q S X Z, then AA..), 'numeric-2' (01, 02, ...) or 'custom:<name>' (with customLabels).",
      ),
    customLabels: z.array(z.string()).optional().describe("Ordered revision labels of a 'custom:<name>' scheme, e.g. ['X1','X2']."),
    policy: policySchema.optional(),
    confirmation: confirmationSchema,
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { partNumber, name, itemType, customLabels = [], policy, at, by } = params;
    const existing = doc.plm;
    const scheme = params.revisionScheme ?? existing?.item.revisionScheme ?? DEFAULT_SCHEME;
    if (!PART_NUMBER.test(partNumber))
      return refusePlm(
        doc,
        'set_item_identity',
        'PLM_PN_INVALID',
        `'${partNumber}' is not a valid part number`,
        [partNumber],
        ['partNumber'],
      );
    const labels = customLabels.length > 0 ? customLabels : (existing?.policy.customLabels ?? []);
    if (!isKnownScheme(scheme) || (scheme.startsWith('custom:') && !isValidCustomList(labels)))
      return refusePlm(
        doc,
        'set_item_identity',
        'PLM_SCHEME_INVALID',
        `revision scheme '${scheme}' is unknown or its custom label list is empty or has duplicates`,
        [],
        ['revisionScheme'],
      );
    if (
      existing !== undefined &&
      (existing.item.revisionOrder.length > 1 || existing.item.revisions[existing.item.currentRevision]?.state !== 'in_work')
    )
      return refusePlm(
        doc,
        'set_item_identity',
        'PLM_IDENTITY_FROZEN',
        `${existing.item.partNumber} identity is frozen: its revision is no longer a fresh in_work revision`,
        [existing.item.partNumber],
      );
    if (policy !== undefined) {
      const gate = humanAct(doc, 'set_item_identity', params, ctx);
      if ('refusal' in gate) return gate.refusal;
    }
    const label = revisionLabel(scheme, 1, labels);
    if (label === null)
      return refusePlm(doc, 'set_item_identity', 'PLM_SCHEME_INVALID', `scheme '${scheme}' has no first label`, [], ['revisionScheme']);
    const revision = openRevision(label, scopeHash(doc, ctx), at, by);
    const item = {
      partNumber,
      name,
      itemType,
      revisionScheme: scheme,
      currentRevision: label,
      revisions: { [label]: revision },
      revisionOrder: [label],
      marking: existing?.item.marking ?? { regime: 'undetermined' as const },
    };
    const next = withPlm(doc, {
      schema: 1,
      item,
      changes: existing?.changes ?? {},
      changeOrder: existing?.changeOrder ?? [],
      policy: mergedPolicy(existing?.policy ?? DEFAULT_POLICY, policy, labels),
    });
    return changed(
      next,
      `Managed item ${partNumber} '${name}' (${itemType}): revision ${label} in_work, iteration 1, scheme ${scheme}.`,
      [],
    );
  },
});

/**
 * @affects doc.plm.item.revisionScheme (labels of FUTURE revisions only)
 * @failure not managed -> PLM_NOT_MANAGED; unknown scheme / bad custom list -> PLM_SCHEME_INVALID
 */
export const setRevisionScheme = defineCommand({
  name: 'set_revision_scheme',
  description:
    'Change the revision label scheme of the managed item for FUTURE revisions (asme-alpha, numeric-2 or custom:<name> with customLabels). Existing ' +
    'revision labels never change.',
  annotations: { idempotent: true, metaHistory: true },
  params: z.object({
    scheme: z.string().describe("'asme-alpha', 'numeric-2' or 'custom:<name>'."),
    customLabels: z
      .array(z.string())
      .optional()
      .describe("Ordered labels for a 'custom:<name>' scheme: the label of revision n is customLabels[n-1]."),
  }),
  run: (doc, { scheme, customLabels = [] }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'set_revision_scheme', 'PLM_NOT_MANAGED', NOT_MANAGED);
    if (!isKnownScheme(scheme) || (scheme.startsWith('custom:') && !isValidCustomList(customLabels)))
      return refusePlm(
        doc,
        'set_revision_scheme',
        'PLM_SCHEME_INVALID',
        `scheme '${scheme}' is unknown or its custom label list is empty or has duplicates`,
        [],
        ['scheme'],
      );
    const policy = scheme.startsWith('custom:') ? { ...plm.policy, customLabels } : plm.policy;
    return changed(
      withPlm(doc, { ...plm, item: { ...plm.item, revisionScheme: scheme }, policy }),
      `${plm.item.partNumber}: future revisions use scheme ${scheme}; existing labels (${plm.item.revisionOrder.join(', ')}) are unchanged.`,
      [],
    );
  },
});
