import { PMI_KINDS, type PmiFeature } from '../../model/pmi';
import { pmiText } from '../../geometry/pmiText';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { pmiItems, pmiOf } from './pmiOps';
import { primaryFeature } from './refresh';

const facesOf = (feature: PmiFeature | undefined): { entityId: string; faceIndices: readonly number[]; surface: string } | null =>
  feature === undefined ? null : { entityId: feature.entityId, faceIndices: feature.faceIndices, surface: feature.surface };

/**
 * @affects nothing — read-only
 * @invariant items in creation order; each carries its text rendering, faces, review state and annotation plane (so an agent without the viewport can place and check it)
 * @failure none: no PMI gives an empty list
 */
export const listPmi = defineCommand({
  name: 'list_pmi',
  annotations: { readOnly: true, idempotent: true },
  description:
    'List the PMI items of the document (read-only): per item its id, kind, text rendering (e.g. "⌖ | Ø0.3 Ⓜ | A | B | C", "4X Ø6.6–6.9"), the ' +
    'solid and B-rep faces it is attached to (indices and surface type, as last resolved), review state (review.required true until a ' +
    'qualified engineer accepts it), unverified reason, and its annotation plane { origin, normal, xDir } and position in document units. ' +
    'Also the governing standard, general tolerance note and saved views. Filter by entityId or kind. ascii: true replaces Unicode symbols ' +
    'with plain text. Use it to inspect, plan inspection or check what an agent created; check_pmi validates the items.',
  params: z.object({
    entityId: z.string().optional().describe('Only items of this solid.'),
    kind: z.enum(PMI_KINDS).optional().describe('Only items of this kind.'),
    ascii: z.boolean().optional().describe('true = plain ASCII text instead of Unicode GD&T symbols. Default false.'),
  }),
  run: (doc, { entityId, kind, ascii = false }): CommandResult => {
    const pmi = pmiOf(doc);
    const rows = pmiItems(doc)
      .filter((item) => kind === undefined || item.kind === kind)
      .flatMap((item) => {
        const feature = primaryFeature(item, pmi.items);
        if (entityId !== undefined && feature?.entityId !== entityId) return [];
        return [
          {
            id: item.id,
            kind: item.kind,
            text: pmiText(item, ascii),
            ...(feature === undefined ? {} : { feature: facesOf(feature) }),
            review: item.review,
            ...(item.unverified === undefined ? {} : { unverified: item.unverified }),
            placement: { ...item.placement, unit: doc.units },
            ...(item.kind === 'geometric_tolerance' ? { datums: item.datums, characteristic: item.characteristic } : {}),
            ...(item.kind === 'size_dimension' ? { measured: item.feature.ofSize?.measured, count: item.count, unit: doc.units } : {}),
            ...(item.kind === 'location_dimension' ? { measured: item.measured, unit: item.measure === 'angle' ? 'deg' : doc.units } : {}),
          },
        ];
      });
    const views = pmi.savedViewOrder.map((id) => pmi.savedViews[id]).flatMap((view) => (view === undefined ? [] : [view]));
    return report(
      doc,
      `list_pmi: ${rows.length} item(s)${doc.pmi === undefined ? ' (no PMI yet)' : `, standard ${pmi.standard}, ${views.length} saved view(s)`}.`,
      {
        standard: pmi.standard,
        ...(pmi.generalToleranceNote === undefined ? {} : { generalToleranceNote: pmi.generalToleranceNote }),
        items: rows,
        savedViews: views,
        ...(pmi.activeSavedViewId === undefined ? {} : { activeSavedViewId: pmi.activeSavedViewId }),
      },
    );
  },
});
