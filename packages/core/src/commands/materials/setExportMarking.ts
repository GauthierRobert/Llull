/** set_export_marking (TR-MAT-30 / 51, VC-MAT-25): raise freely, lower only with a human signature. */

import { markingRank } from '../../model/materialLibrary';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { humanGate } from '../../model/humanGate';
import { markingInput, markingOf, markingText } from './marking';
import { refuseMaterial } from './refusal';

const COMMAND = 'set_export_marking';

/**
 * @affects CadDocument.materials[material].record.exportMarking
 * @invariant a marking can be raised (none < EAR99 < EAR < ITAR) or kept by any caller; lowering needs a signature verified by ctx.humanSignature
 * @failure unknown material / no record MAT_RECORD_NOT_FOUND; lowering without a verified signature MAT_HUMAN_GATE (document unchanged)
 */
export const setExportMarking = defineCommand({
  name: COMMAND,
  description:
    'Set the export-control marking (none, EAR99, EAR + eccn, ITAR) of a material record. Raising a marking is always allowed. Lowering it ' +
    '(for example ITAR → none) is a human act: it needs `confirmation`, a signature produced in the desktop app; an agent gets MAT_HUMAN_GATE. ' +
    'Export commands refuse documents that use EAR or ITAR records (MAT_EXPORT_CONTROLLED).',
  params: z.object({
    material: z.string().describe('Material id of a record (define_material_record or a library record).'),
    marking: markingInput.describe('The new marking.'),
    confirmation: z.record(z.string(), z.unknown()).optional().describe('Human signature object, required only to lower the marking.'),
  }),
  run: (doc, { material: name, marking: input, confirmation }, ctx): CommandResult => {
    const material = Object.hasOwn(doc.materials, name) ? doc.materials[name] : undefined;
    const record = material?.record;
    if (material === undefined || record === undefined)
      return refuseMaterial(doc, COMMAND, 'MAT_RECORD_NOT_FOUND', `no material record '${name}'`, { ids: [name], path: 'material' });
    const marking = markingOf(input);
    if (typeof marking === 'string')
      return refuseMaterial(doc, COMMAND, 'PROP_FORM_INVALID', marking, { ids: [name], path: 'marking.eccn' });
    if (markingRank(marking) < markingRank(record.exportMarking)) {
      const gate = humanGate(ctx?.humanSignature ?? null, 'lowering an export marking', [name], confirmation, {
        lowered: [{ id: name, from: record.exportMarking, to: marking }],
      });
      if (!gate.cleared)
        return refuseMaterial(
          doc,
          COMMAND,
          'MAT_HUMAN_GATE',
          `${gate.reason} (${markingText(record.exportMarking)} → ${markingText(marking)})`,
          { ids: [name], path: 'confirmation' },
        );
    }
    return changed(
      { ...doc, materials: { ...doc.materials, [name]: { ...material, record: { ...record, exportMarking: marking } } } },
      `set_export_marking '${name}': ${markingText(record.exportMarking)} → ${markingText(marking)}.`,
      [],
    );
  },
});
