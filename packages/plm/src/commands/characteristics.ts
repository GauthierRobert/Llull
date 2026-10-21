/** assign_characteristic_ids (FR-PLM-26): stable characteristic numbers (balloons) over the 03 GD&T / PMI items; the register lives in doc.plm. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import { pmiText } from '@core/geometry/pmiText';
import type { PmiItem } from '@core/model/pmi';
import type { Characteristic } from '@plm/types';
import type { CadDocument } from '@core/model/types';
import { refusePlm } from '../refusal';
import { withPlm } from '../revisions';
import { NOT_MANAGED } from '../state';

type SourceKind = Characteristic['sourceRef']['kind'];

/** Datum features and targets are references, not characteristics; everything else on a drawing is inspected. */
function characteristicKind(item: PmiItem): SourceKind | null {
  switch (item.kind) {
    case 'size_dimension':
    case 'location_dimension':
      return 'dimension';
    case 'geometric_tolerance':
    case 'surface_texture':
      return 'gdt';
    case 'note':
      return 'note';
    default:
      return null;
  }
}

/** The sheet that places the PMI item through an explicit `view.pmiIds` (automatic sheets cannot be resolved without projecting). */
function explicitSheet(doc: CadDocument, pmiId: string): string | undefined {
  const sheets = doc.drawings?.sheets ?? {};
  return (doc.drawings?.order ?? []).find((id) => sheets[id]?.views.some((view) => view.pmiIds?.includes(pmiId) === true));
}

/**
 * @affects doc.plm.characteristics (adds a number for each new characteristic PMI item; refreshes the stored requirement text; retires numbers whose PMI item is gone)
 * @invariant existing numbers never change; a retired number is never reused (new numbers continue after the highest ever issued); a retired item that
 *   reappears under its id takes its number back; datum features and targets are not characteristics
 * @failure not managed -> PLM_NOT_MANAGED; unknown sheet or unknown PMI id in `designators` -> PLM_PARAM_INVALID; no PMI -> unchanged document with a
 *   summary that says why (nothing to number)
 */
export const assignCharacteristicIds = defineCommand({
  name: 'assign_characteristic_ids',
  description:
    'Number the characteristics (balloons) of the drawing for AS9102 Form 3: every size / location dimension, geometric tolerance (feature control frame), ' +
    'surface texture and, with includeNotes, note among the PMI items (03 GD&T) gets a stable characteristic number in doc.plm.characteristics, keyed by ' +
    'its PMI id. Existing numbers never change, retired numbers are never reused, so regenerating the model keeps every balloon. Datums are references ' +
    'and are not numbered. The stored requirement text is what the drawing prints. export_sheet_svg then draws the number in a balloon next to the ' +
    'callout. sheetId limits the numbering to items an explicit view of that sheet shows (or any item for an automatic-PMI sheet) and records that sheet; ' +
    'designators sets a customer key / critical flag per PMI id. Changes only the PLM record, never the definition.',
  annotations: { idempotent: true, metaHistory: true },
  params: z.object({
    sheetId: z
      .string()
      .optional()
      .describe('Only number the PMI of this sheet (explicit view.pmiIds, or every item when the sheet draws PMI automatically).'),
    scheme: z.literal('sequential').optional().describe('Numbering scheme; only "sequential" (1, 2, 3, ...) exists.'),
    includeNotes: z.boolean().optional().describe('Also number drawing notes (default false).'),
    designators: z
      .record(z.string(), z.string())
      .optional()
      .describe('Characteristic designator per PMI id, e.g. { "pmi-3.1": "KEY" } (customer-specific key / critical symbol).'),
  }),
  run: (doc, { sheetId, includeNotes = false, designators = {} }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'assign_characteristic_ids', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const pmi = doc.pmi;
    if (pmi === undefined || pmi.order.length === 0)
      return report(doc, 'assign_characteristic_ids: the document has no PMI items (03 GD&T); nothing to number.');
    const sheet = sheetId === undefined ? undefined : doc.drawings?.sheets[sheetId];
    if (sheetId !== undefined && sheet === undefined)
      return refusePlm(doc, 'assign_characteristic_ids', 'PLM_PARAM_INVALID', `no sheet '${sheetId}'`, [sheetId], ['sheetId']);
    const unknown = Object.keys(designators).filter((id) => pmi.items[id] === undefined);
    if (unknown.length > 0)
      return refusePlm(
        doc,
        'assign_characteristic_ids',
        'PLM_PARAM_INVALID',
        `unknown PMI id(s) in designators: ${unknown.join(', ')}`,
        unknown,
        ['designators'],
      );
    const existing = plm.characteristics ?? {};
    const revision = plm.item.currentRevision;
    const next: Record<string, Characteristic> = { ...existing };
    let counter = Math.max(0, ...Object.values(existing).map((c) => c.charNo));
    const added: number[] = [];
    for (const id of pmi.order) {
      const item = pmi.items[id];
      const kind = item === undefined ? null : characteristicKind(item);
      if (item === undefined || kind === null || (kind === 'note' && !includeNotes)) continue;
      const placed =
        sheet === undefined
          ? explicitSheet(doc, id)
          : sheet.pmiMode === 'auto' || sheet.views.some((v) => v.pmiIds?.includes(id) === true)
            ? sheetId
            : undefined;
      if (sheet !== undefined && placed === undefined) continue;
      const known = existing[id];
      const designator = designators[id] ?? known?.designator;
      const sheetOf = placed ?? known?.sheetId;
      const charNo = known?.charNo ?? (counter += 1);
      if (known === undefined) added.push(charNo);
      next[id] = {
        charNo,
        sourceRef: { kind, id },
        ...(sheetOf !== undefined ? { sheetId: sheetOf } : {}),
        ...(designator !== undefined ? { designator } : {}),
        requirementText: pmiText(item),
        introducedIn: known?.introducedIn ?? revision,
      };
    }
    const retired: number[] = [];
    for (const [id, characteristic] of Object.entries(next)) {
      if (pmi.items[id] === undefined && characteristic.retiredIn === undefined) {
        next[id] = { ...characteristic, retiredIn: revision };
        retired.push(characteristic.charNo);
      }
    }
    if (JSON.stringify(next) === JSON.stringify(existing))
      return report(doc, `assign_characteristic_ids: ${Object.keys(existing).length} characteristic(s) already numbered; nothing new.`);
    return changed(
      withPlm(doc, { ...plm, characteristics: next }),
      `${plm.item.partNumber}: numbered ${added.length} new characteristic(s)${added.length > 0 ? ` (${added[0]}-${added.at(-1)})` : ''}` +
        `${retired.length > 0 ? `; retired ${retired.join(', ')} (numbers are never reused)` : ''}; ${Object.values(next).filter((c) => c.retiredIn === undefined).length} active.`,
      [],
    );
  },
});
