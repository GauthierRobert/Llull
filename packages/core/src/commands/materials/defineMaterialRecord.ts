/** define_material_record (08 MAT M2): the identification of an aerospace material; values follow with set_material_property. */

import { isHexColor } from '../../lib/isHexColor';
import { isReservedKey } from '../../lib/reservedKey';
import { LICENCE_FLAGS, markingRank, type MaterialRecordInfo } from '../../model/materialLibrary';
import type { Material } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { withoutUndefined } from '../document/propertyModelSchema';
import { humanGate } from './humanGate';
import { specsSchema, supersededSchema } from './libraryFormat';
import { markingInput, markingOf, markingText } from './marking';
import { refuseMaterial } from './refusal';

const COMMAND = 'define_material_record';

/**
 * @affects CadDocument.materials[id] (a material with a `record`; density 0 until a density value is set)
 * @invariant an existing material is replaced only with replace: true and keeps its values; the export marking is never lowered here
 * @failure blank / reserved id, bad colour, EAR without eccn -> no-op; existing id without replace MAT_RECORD_EXISTS; library record
 *   MAT_RECORD_READONLY; lowering the marking MAT_HUMAN_GATE (use set_export_marking)
 */
export const defineMaterialRecord = defineCommand({
  name: COMMAND,
  description:
    'Define an aerospace material record: id (also its material name), designation (e.g. "7075"), temper, productForm, the specifications it is ' +
    'bought to (body + id, e.g. SAE AMS 4045), licence of its data, export-control marking and whether a source superseded it (MIL-HDBK-5J → MMPDS). ' +
    'The record has no values yet: add density, moduli and allowables with set_material_property, then assign it with assign_material. ' +
    'It behaves like any material (mass_properties, viewport colour). Redefining an id needs replace: true and keeps its values.',
  params: z.object({
    id: z.string().describe('Record id and material name, e.g. "aa7075_t6_sheet". Case-sensitive, unique in the document.'),
    designation: z.string().describe('Alloy / material designation, e.g. "7075", "Ti-6Al-4V".'),
    temper: z.string().optional().describe('Temper or condition, e.g. "T6", "annealed".'),
    productForm: z.string().optional().describe('Product form, e.g. "sheet", "plate", "extrusion".'),
    specs: specsSchema.describe('Specifications: [{ body: "SAE", id: "AMS 4045", revision?: "H" }, …]. May be empty.'),
    licence: z
      .enum(LICENCE_FLAGS)
      .describe('Licence of the data: public-domain-us-gov, licensed-no-redistribution, company-proprietary, vendor-catalogue, legacy.'),
    exportMarking: markingInput.describe('Export-control marking of the material data.'),
    superseded: supersededSchema
      .optional()
      .describe('Set when the source is superseded: { by: "MMPDS", note }. Certification queries refuse it.'),
    color: z.string().optional().describe('Viewport colour #rrggbb (default #b0b0b0).'),
    replace: z.boolean().optional().describe('Replace an existing material with this id, keeping its values (default false).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id } = params;
    const refuse = (code: string, message: string, path: string): CommandResult =>
      refuseMaterial(doc, COMMAND, code, message, { ids: [id], path });
    if (id.trim() === '' || isReservedKey(id)) return refuse('MAT_RECORD_NOT_FOUND', `'${id}' is not a usable material id`, 'id');
    if (params.color !== undefined && !isHexColor(params.color))
      return refuse('PROP_FORM_INVALID', `color must be #rrggbb, got '${params.color}'`, 'color');
    const marking = markingOf(params.exportMarking);
    if (typeof marking === 'string') return refuse('PROP_FORM_INVALID', marking, 'exportMarking.eccn');
    const previous = Object.hasOwn(doc.materials, id) ? doc.materials[id] : undefined;
    if (previous !== undefined) {
      if (params.replace !== true) return refuse('MAT_RECORD_EXISTS', `material '${id}' already exists`, 'id');
      if (previous.record?.libraryRef !== undefined)
        return refuse('MAT_RECORD_READONLY', `'${id}' comes from library '${previous.record.libraryRef.libraryId}'`, 'id');
      const before = previous.record?.exportMarking;
      if (before !== undefined && markingRank(marking) < markingRank(before)) {
        const gate = humanGate(ctx, 'lowering an export marking', [id], undefined);
        return refuse(
          'MAT_HUMAN_GATE',
          `${gate.cleared ? '' : gate.reason} (${markingText(before)} → ${markingText(marking)}; use set_export_marking with a human signature)`,
          'exportMarking',
        );
      }
    }
    const record: MaterialRecordInfo = {
      id,
      designation: params.designation,
      ...(params.temper !== undefined ? { temper: params.temper } : {}),
      ...(params.productForm !== undefined ? { productForm: params.productForm } : {}),
      specs: withoutUndefined<MaterialRecordInfo['specs']>(params.specs),
      licence: params.licence,
      exportMarking: marking,
      ...(params.superseded !== undefined ? { superseded: params.superseded } : {}),
    };
    const material: Material = {
      ...(previous ?? { density: 0, color: '#b0b0b0', metalness: 0.8, roughness: 0.4 }),
      name: id,
      ...(params.color !== undefined ? { color: params.color } : {}),
      record,
    };
    return changed(
      { ...doc, materials: { ...doc.materials, [id]: material } },
      `define_material_record '${id}': ${previous === undefined ? 'created' : 'replaced'} (${params.designation}${params.temper !== undefined ? ` ${params.temper}` : ''}, licence ${params.licence}, marking ${markingText(marking)}${params.superseded !== undefined ? `, superseded by ${params.superseded.by}` : ''}). Next: set_material_property.`,
      [],
    );
  },
});
