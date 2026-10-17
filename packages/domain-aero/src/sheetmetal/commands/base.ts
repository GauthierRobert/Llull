import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { nextId } from '@lib/id';
import type { SheetMetalPart } from '@core/model/sheetMetal';
import { withFoldedSolid } from '../fold';
import { getModel, withModel, withPart } from '../graph';
import { readProfile } from '../profile';
import { fixed, refuse } from '../result';

/**
 * @affects creates 1 sheet-metal part and its derived folded solid (a mesh entity with the part id); the profile stays
 * @invariant the base flat is the part root; its outline is the profile counter-clockwise in the profile's own plane coordinates
 * @failure unknown rule (FTR_RULE_NOT_FOUND), missing / open / self-intersecting / circular profile (FTR_PROFILE_NOT_CLOSED, FTR_PARAM_INVALID) -> rejected with error.code
 */
export const addSheetMetalBase = defineCommand({
  name: 'add_sheet_metal_base',
  description:
    'Create a sheet-metal part from a closed 2D profile (rectangle or closed polyline drawn with draw_rectangle / draw_polyline) and a rule from create_sheet_metal_rule. ' +
    "The profile becomes the base flat of the rule's thickness on its work plane (side up = material on the +normal side, down = on the -normal side, mid = centred). " +
    'Returns the part id (also the id of the derived, read-only folded solid). Lengths are in the document length unit. ' +
    'Refusals: FTR_RULE_NOT_FOUND, FTR_PROFILE_NOT_CLOSED (open, self-intersecting, or not a rectangle/closed polyline). Next: add_flange, add_sheet_cutout, flat_pattern, check_sheet_metal.',
  params: z.object({
    profileId: z.string().describe('Id of a closed 2D profile entity (rectangle or closed polyline). It stays in the document.'),
    rule: z.string().describe('Name of a rule created with create_sheet_metal_rule; it supplies thickness, radius and K-factor.'),
    side: z
      .enum(['up', 'down', 'mid'])
      .describe("Where the material lies relative to the profile plane: 'up' (+normal), 'down' (-normal) or 'mid' (centred)."),
  }),
  run: (doc, { profileId, rule, side }): CommandResult => {
    const model = getModel(doc);
    const ruleData = model.rules[rule];
    if (ruleData === undefined)
      return refuse(
        doc,
        'add_sheet_metal_base',
        'FTR_RULE_NOT_FOUND',
        `no rule "${rule}"`,
        'Create it with create_sheet_metal_rule first.',
        { paths: ['rule'] },
      );
    const entity = doc.entities[profileId];
    if (entity === undefined)
      return refuse(
        doc,
        'add_sheet_metal_base',
        'FTR_PARAM_INVALID',
        `no entity "${profileId}"`,
        'Draw the profile first (draw_rectangle / draw_polyline).',
        { paths: ['profileId'] },
      );
    const loop = readProfile(entity);
    if (typeof loop === 'string' || loop.circle !== undefined)
      return refuse(
        doc,
        'add_sheet_metal_base',
        'FTR_PROFILE_NOT_CLOSED',
        typeof loop === 'string' ? loop : `circle ${profileId} is not supported as a base profile`,
        'Pass a closed, simple 2D profile: a rectangle or a closed polyline.',
        { ids: [profileId], paths: ['profileId'] },
      );
    const id = nextId('sm');
    const part: SheetMetalPart = {
      id,
      rule,
      root: 'f1',
      side,
      nodes: { f1: { id: 'f1', type: 'flat', outline: loop.points, frame: loop.frame, cutouts: [] } },
      order: ['f1'],
    };
    const next = withFoldedSolid(withModel(doc, withPart(model, part)), part, ruleData);
    return changed(
      next,
      `add_sheet_metal_base: part "${id}" from ${entity.kind} ${profileId} (${loop.points.length} vertices), rule "${rule}" T=${fixed(ruleData.thickness)}, side ${side}. Folded solid "${id}" derived (read-only).`,
      [id],
    );
  },
});
