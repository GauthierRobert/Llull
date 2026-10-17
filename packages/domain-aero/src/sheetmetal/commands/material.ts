import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { withFoldedSolid } from '../fold';
import { getModel, ruleOfPart, withModel, withPart } from '../graph';
import { refuse } from '../result';

/**
 * @affects sets materialId (and optionally layerId) on the sheet-metal part and re-derives its folded solid with them
 * @invariant the attributes live on the part: every later derivation and every load re-applies them to the folded solid
 * @failure unknown / converted part (FTR_PART_NOT_FOUND), unknown material or layer, nothing to set (FTR_PARAM_INVALID) -> rejected with error.code
 */
export const setSheetMetalMaterial = defineCommand({
  name: 'set_sheet_metal_material',
  description:
    'Give a sheet-metal part its material and, optionally, its layer. The folded solid of a part is derived and read-only, so assign_material ' +
    'is refused on it; this command stores the material on the part itself, so mass_properties, the bill of materials and the export gate see it, ' +
    'and it survives every later edit of the part and save / load. The material must exist (create_material, define_material_record or an ' +
    'imported library record: use its name). Converted parts (convert_to_sheet_metal) describe an ordinary solid: use assign_material on it. ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_PARAM_INVALID. Next: mass_properties, check_sheet_metal.',
  annotations: { idempotent: true },
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    materialName: z.string().describe('Name of an existing material in the document (case-sensitive), e.g. "al2024".'),
    layerId: z
      .string()
      .optional()
      .describe('Optional id of an existing layer to put the folded solid on. Omit to leave the layer as it is.'),
  }),
  run: (doc, { id, materialName, layerId }): CommandResult => {
    const model = getModel(doc);
    const part = model.parts[id];
    if (part === undefined || part.sourceEntity !== undefined || ruleOfPart(model, part) === undefined)
      return refuse(
        doc,
        'set_sheet_metal_material',
        'FTR_PART_NOT_FOUND',
        `no native sheet-metal part "${id}"`,
        'Create one with add_sheet_metal_base.',
        { ids: [id], paths: ['id'] },
      );
    if (doc.materials[materialName] === undefined)
      return refuse(
        doc,
        'set_sheet_metal_material',
        'FTR_PARAM_INVALID',
        `material "${materialName}" not found`,
        `Create it first with create_material. Available: ${Object.keys(doc.materials).join(', ') || 'none'}.`,
        { ids: [id], paths: ['materialName'] },
      );
    if (layerId !== undefined && doc.layers[layerId] === undefined)
      return refuse(doc, 'set_sheet_metal_material', 'FTR_PARAM_INVALID', `layer "${layerId}" not found`, 'Create it with add_layer.', {
        ids: [id],
        paths: ['layerId'],
      });
    const updated = { ...part, materialId: materialName, ...(layerId === undefined ? {} : { layerId }) };
    const rule = ruleOfPart(model, updated);
    if (rule === undefined)
      return refuse(doc, 'set_sheet_metal_material', 'FTR_RULE_NOT_FOUND', `rule "${part.rule}" is missing`, 'Recreate the rule.', {
        ids: [id],
      });
    const next = withFoldedSolid(withModel(doc, withPart(model, updated)), updated, rule);
    return changed(
      next,
      `set_sheet_metal_material: part "${id}" now has material "${materialName}"${layerId === undefined ? '' : ` on layer ${layerId}`}; its folded solid carries it through edits and save / load.`,
      [id],
    );
  },
});
