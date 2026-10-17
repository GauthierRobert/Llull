import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { withFoldedSolid } from '../fold';
import { bendOf, flatOf, getModel, nextNodeId, reliefNodes, ruleOfPart, withModel, withNodes, withPart } from '../graph';
import { bendEnd, notchOutline } from '../reliefGeometry';
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
    const bend = bendOf(part, params.bend);
    if (bend === undefined)
      return fail('FTR_PARAM_INVALID', `no bend "${params.bend}" in part ${part.id}`, 'Use a bend id from flat_pattern data.bends[].id.', {
        ids: [part.id],
        paths: ['bend'],
      });
    if (reliefNodes(part).some((node) => node.bend === bend.id && node.end === params.end))
      return fail(
        'FTR_RELIEF_INVALID',
        `bend ${bend.id} already has a relief at its ${params.end}`,
        'Relieve the other end or edit nothing.',
        { ids: [part.id, bend.id], paths: ['end'] },
      );
    const ruleRelief = rule.relief;
    const defaulted = params.width === undefined || params.depth === undefined;
    if (defaulted && (ruleRelief === undefined || ruleRelief.type !== 'rectangular'))
      return fail(
        'FTR_PARAM_INVALID',
        'width/depth not given and the rule defines no rectangular relief',
        'Give width and depth, or create the rule with relief { type: "rectangular", widthRatio }.',
        { paths: ['width', 'depth'] },
      );
    const width = params.width ?? (ruleRelief?.widthRatio ?? 0) * rule.thickness;
    const depth = params.depth ?? bend.insideRadius + rule.thickness + (ruleRelief?.depthExtra ?? 0);
    if (!(width > 0) || !(depth > 0))
      return fail('FTR_PARAM_INVALID', `relief width ${width} and depth ${depth} must be > 0`, 'Give positive lengths.', {
        paths: ['width', 'depth'],
      });
    const parent = flatOf(part, bend.from);
    const end = parent === undefined ? null : bendEnd(parent.outline, bend.lineInFrom, params.end);
    if (parent === undefined || end === null)
      return fail(
        'FTR_RELIEF_INVALID',
        `bend ${bend.id} does not lie on an edge of its parent flat`,
        'A relief needs the bend on an outline edge.',
        { ids: [part.id, bend.id] },
      );
    if (end.free <= 1e-6)
      return fail(
        'FTR_RELIEF_INVALID',
        `the bend ends at a corner of ${parent.id}: there is no free edge to relieve`,
        'Reliefs go where the flange stops short of the edge end.',
        { ids: [part.id, bend.id], paths: ['end'] },
      );
    const outline = notchOutline(parent.outline, end, params.end, width, depth);
    if (outline === null)
      return fail(
        'FTR_RELIEF_INVALID',
        `a ${fixed(width)} x ${fixed(depth)} notch does not fit on the free ${fixed(end.free)} of the edge`,
        'Reduce width/depth, or lengthen the free edge (widthStart / widthEnd of the flange).',
        { ids: [part.id, bend.id] },
      );
    const reliefId = nextNodeId(part, 'r');
    const nextPart = withNodes(part, [
      { ...parent, outline },
      { id: reliefId, type: 'relief', bend: bend.id, end: params.end, width, depth },
    ]);
    const next = withFoldedSolid(withModel(doc, withPart(model, nextPart)), nextPart, rule);
    return changed(
      next,
      `add_relief: part "${part.id}" relief ${reliefId} at the ${params.end} of bend ${bend.id}: ${fixed(width)} x ${fixed(depth)} notch in ${parent.id}${defaulted ? ' (defaulted from rule ' + rule.name + ' relief)' : ''}.`,
      [part.id],
    );
  },
});
