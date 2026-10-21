/** set_item_marking: the managed item's export-control marking (FR-PLM-25); a human decision, never derived. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { ExportMarking } from '@core/model/plm';
import { refusePlm } from '../refusal';
import { NOT_MANAGED } from '../state';
import { humanAct } from '../gate';
import { withPlm } from '../revisions';
import { atSchema, confirmationSchema } from '../params';

const CONTROLLED = new Set(['ITAR', 'EAR', 'EU-dual-use', 'national', 'other']);

/**
 * @affects doc.plm.item.marking (sheets and the release manifest print it)
 * @invariant never derived or inferred: only this human act sets it; a controlled regime must carry the notice text
 * @failure agent caller -> PLM_HUMAN_GATE; not managed -> PLM_NOT_MANAGED; controlled regime without statement -> PLM_PARAM_INVALID (all refusals, unchanged doc)
 */
export const setItemMarking = defineCommand({
  name: 'set_item_marking',
  description:
    "Record the managed item's export-control marking: regime (none, undetermined, ITAR, EAR, EU-dual-use, national, other), the user's own " +
    'classification text (e.g. ECCN or USML category) and the notice to print. HUMAN GATE. llull never classifies: the export-control officer decides. A controlled ' +
    'regime needs a statement. With policy.requireMarking, submit_for_review is refused while the regime is undetermined. Not the material-record ' +
    'marking (set_export_marking). An agent caller gets PLM_HUMAN_GATE.',
  annotations: { idempotent: true, metaHistory: true },
  params: z.object({
    regime: z
      .enum(['none', 'undetermined', 'ITAR', 'EAR', 'EU-dual-use', 'national', 'other'])
      .describe('Export-control regime decided by the officer.'),
    classification: z
      .string()
      .optional()
      .describe('The decided classification text, e.g. ECCN 9A610 or USML VIII(h). Free text, never validated.'),
    statement: z
      .string()
      .optional()
      .describe('Notice printed on every sheet and in the release manifest. Required for a controlled regime.'),
    decidedBy: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Ignored: the decision is recorded under the signer of the confirmation (the trusted key record), never a name given here.',
      ),
    confirmation: confirmationSchema,
    at: atSchema.optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { regime, classification, statement, at } = params;
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'set_item_marking', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanAct(doc, 'set_item_marking', params, ctx);
    if ('refusal' in gate) return gate.refusal;
    const decidedBy = gate.signer;
    if (CONTROLLED.has(regime) && (statement === undefined || statement.trim() === ''))
      return refusePlm(
        doc,
        'set_item_marking',
        'PLM_PARAM_INVALID',
        `regime ${regime} needs a non-empty statement (the notice to print)`,
        [plm.item.partNumber],
        ['statement'],
      );
    const marking: ExportMarking = {
      regime,
      ...(classification !== undefined ? { classification } : {}),
      ...(statement !== undefined ? { statement } : {}),
      decidedBy,
      ...(at !== undefined ? { decidedAt: at } : {}),
    };
    return changed(
      withPlm(doc, { ...plm, item: { ...plm.item, marking } }),
      `${plm.item.partNumber}: export marking ${regime} recorded by ${decidedBy}.`,
      [],
    );
  },
});
