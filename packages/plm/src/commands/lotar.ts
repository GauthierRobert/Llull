/** lotar_validation_properties (M6): the validation properties a LOTAR archive package stores with a revision. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { documentOfSnapshot, validationPropertiesOf } from '../lotar/validation';
import { refusePlm } from '../refusal';
import { snapshotText, unreadableSnapshot } from '../snapshot';
import { NOT_MANAGED, revisionText, scopeHash } from '../state';

/**
 * @affects nothing (read-only)
 * @invariant a frozen revision is measured from its snapshot (what was released), the open current revision from the live definition; the same function builds the figures `llull lotar pack` stores
 *   and `llull lotar verify` re-derives
 * @failure not managed -> PLM_NOT_MANAGED; unknown revision -> PLM_REVISION_UNKNOWN; snapshot unreadable -> PLM_VAULT_OBJECT_MISSING or PLM_NO_SNAPSHOT (refusals)
 */
export const lotarValidationProperties = defineCommand({
  name: 'lotar_validation_properties',
  description:
    'The validation properties of one revision as a LOTAR (EN 9300) archive stores them: per 3D entity the volume, area and centroid with the method that computed them (mass_properties), and ' +
    'counts of entities, solids, components, drawing sheets and PMI items. A frozen revision (released, superseded, obsolete) is measured from its release snapshot, the open current ' +
    'revision from the live definition. An archive keeps these figures so a later re-derivation from the archived content can be compared (llull lotar verify). Returns data ' +
    '{ revision, definitionHash, source, validation }. Read-only.',
  annotations: { readOnly: true },
  params: z.object({ revision: z.string().optional().describe('Revision label; default = the current revision.') }),
  run: (doc, { revision: requested }, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'lotar_validation_properties', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const label = requested ?? plm.item.currentRevision;
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(
        doc,
        'lotar_validation_properties',
        'PLM_REVISION_UNKNOWN',
        `${plm.item.partNumber} has no revision '${label}'`,
        [label],
        ['revision'],
      );
    if (revision.snapshot === undefined) {
      if (label !== plm.item.currentRevision)
        return refusePlm(
          doc,
          'lotar_validation_properties',
          'PLM_NO_SNAPSHOT',
          `${revisionText(plm, label)} has no snapshot and is not the current revision`,
          [label],
        );
      const validation = validationPropertiesOf(doc);
      return report(doc, `${revisionText(plm, label)} (live definition): ${validation.counts.solids} solid(s) measured.`, {
        revision: label,
        definitionHash: scopeHash(doc, ctx),
        source: 'live definition',
        validation,
      });
    }
    const text = snapshotText(revision, ctx);
    if (text === null)
      return refusePlm(
        doc,
        'lotar_validation_properties',
        'PLM_VAULT_OBJECT_MISSING',
        `${revisionText(plm, label)}: ${unreadableSnapshot(revision)}`,
        [label],
      );
    const frozen = documentOfSnapshot(text);
    if (frozen === null)
      return refusePlm(
        doc,
        'lotar_validation_properties',
        'PLM_INTEGRITY_MISMATCH',
        `${revisionText(plm, label)}: the snapshot does not load as a document`,
        [label],
      );
    const validation = validationPropertiesOf(frozen);
    return report(doc, `${revisionText(plm, label)} (release snapshot): ${validation.counts.solids} solid(s) measured.`, {
      revision: label,
      definitionHash: revision.contentHash ?? null,
      source: 'release snapshot',
      validation,
    });
  },
});
