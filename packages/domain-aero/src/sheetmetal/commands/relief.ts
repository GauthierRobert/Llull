import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { withFoldedSolid } from '../fold';
import { getModel, ruleOfPart, withModel, withPart } from '../graph';
import { applyRelief, isReliefFailure, reliefData } from '../reliefOps';
import { fixed, refuse } from '../result';

/**
 * @affects cuts a rectangular notch into the parent flat of the bend (outline edit), records a relief node, re-derives the folded solid
 * @invariant width/depth default from the rule relief (width = widthRatio*T, depth = R + T + depthExtra) and the summary names them as defaulted (AF-31)
 * @failure unknown part/bend (FTR_PART_NOT_FOUND), bend end not on a free stretch of an edge, relief already there, no width/depth and no rule relief, notch not fitting (FTR_RELIEF_INVALID) -> rejected with error.code
 */
export const addRelief = defineCommand({
  name: 'add_relief',
  description:
    'Add a rectangular bend relief to a sheet-metal part: a notch cut into the parent flat beside one end of a bend, so the bend can form without tearing. ' +
    "bend is the bend node id (listed in flat_pattern data.bends[].id), end 'start' or 'end' is the end of the bend line (the end the flange stops short of the edge end). " +
    "width (along the bend line, beyond its end) and depth (into the parent flat from the bend tangent line) are in the document length unit; when omitted they come from the rule's relief " +
    '(width = widthRatio x thickness, depth = inside radius + thickness + depthExtra) and the summary says so. The notch must fit on the free stretch of the edge. ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_PARAM_INVALID, FTR_RELIEF_INVALID. Next: check_sheet_metal (FTR_RELIEF_MISSING), flat_pattern.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    bend: z.string().describe('Bend node id inside the part (e.g. "b1"), see flat_pattern data.bends[].id.'),
    end: z
      .enum(['start', 'end'])
      .describe("Which end of the bend line gets the relief: 'start' or 'end' (the flange is narrower than the edge at that end)."),
    width: z
      .number()
      .optional()
      .describe(
        'Relief width along the bend line in the document length unit; > 0. Default from the rule relief (widthRatio x thickness).',
      ),
    depth: z
      .number()
      .optional()
      .describe(
        'Relief depth into the parent flat in the document length unit; > 0. Default inside radius + thickness + depthExtra from the rule relief.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: Parameters<typeof refuse>[2], why: string, fix: string, where: Parameters<typeof refuse>[5] = {}): CommandResult =>
      refuse(doc, 'add_relief', code, why, fix, where);
    const model = getModel(doc);
    const part = model.parts[params.id];
    if (part === undefined)
      return fail('FTR_PART_NOT_FOUND', `no sheet-metal part "${params.id}"`, 'Create one with add_sheet_metal_base.', { paths: ['id'] });
    const rule = ruleOfPart(model, part);
    if (rule === undefined) return fail('FTR_RULE_NOT_FOUND', `rule "${part.rule}" is missing`, 'Recreate the rule.', { ids: [part.id] });
    const applied = applyRelief(part, rule, params.bend, params.end, { width: params.width, depth: params.depth });
    if (isReliefFailure(applied))
      return fail(applied.code, applied.why, applied.fix, { ids: applied.ids ?? [], paths: applied.paths ?? [] });
    const next = withFoldedSolid(withModel(doc, withPart(model, applied.part)), applied.part, rule);
    return {
      ...changed(
        next,
        `add_relief: part "${part.id}" relief ${applied.id} at the ${params.end} of bend ${params.bend}: ${fixed(applied.width)} x ${fixed(applied.depth)} notch in ${applied.flat}${applied.defaulted ? ' (defaulted from rule ' + rule.name + ' relief)' : ''}.`,
        [part.id],
      ),
      data: reliefData(applied, rule.name),
    };
  },
});
