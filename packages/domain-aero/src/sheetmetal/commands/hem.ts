import { defineCommand, z, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { hemQuantities } from '../sheetMath';
import { getModel, nextNodeId, ruleOfPart } from '../graph';
import { HEM_SOURCE } from '../provenance';
import { fixed, refuse } from '../result';
import { resolveK } from '../rules';
import { applyFlange } from './flange';

/**
 * @affects adds a 180 degree bend + return flat (a flange with insideRadius gap/2) to the part, records a hem node, re-derives the folded solid
 * @invariant closed hem: inside radius 0 (return leg against the flat); open hem: inside radius gap/2; developed hem length = pi*(gap/2+K*T) + leg (UNVERIFIED model, flagged in flat_pattern)
 * @failure unknown part, hemType open without gap > 0 or closed with gap (FTR_PARAM_INVALID), length <= 0 (FTR_PARAM_INVALID), edge not found / occupied -> rejected with error.code
 */
export const addHem = defineCommand({
  name: 'add_hem',
  description:
    'Add a 180-degree hem (a flat folded back over itself along a straight edge) to a sheet-metal part: a 180-degree bend followed by a straight return leg. ' +
    "The edge is picked by the world point `edge.near` (within one thickness of the edge) and is the bend tangent line. hemType 'closed' = no gap (inside radius 0, the return leg lies against the flat; allowed even when the rule forbids sharp bends); " +
    "'open' = a gap between the flat and the return leg (inside radius = gap/2, gap required). length is the straight return leg after the bend, from the bend tangent line to the free edge. " +
    'All lengths are in the document length unit. The developed length of the hem (flat_pattern data.hems[]) is pi*(gap/2 + K*T) + length with the rule K at that radius: the neutral-surface model extended to 180 degrees, flagged UNVERIFIED (not checked against a published hem table). ' +
    'The teardrop hem is not supported. Refusals: FTR_PART_NOT_FOUND, FTR_PARAM_INVALID, FTR_FLANGE_TOO_SHORT, FTR_EDGE_NOT_STRAIGHT, FTR_EDGE_OCCUPIED. Next: flat_pattern, check_sheet_metal.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    edge: z
      .object({
        near: vec3('World point [x, y, z] on or within one thickness of the straight edge that gets the hem (document length unit).'),
      })
      .describe('Edge selector (the bend tangent line).'),
    hemType: z.enum(['closed', 'open']).describe("'closed' = zero gap (inside radius 0); 'open' = gap between flat and return leg."),
    length: z.number().describe('Straight return leg length after the bend in the document length unit; > 0.'),
    gap: z
      .number()
      .optional()
      .describe(
        'Clear gap between the flat and the return leg in the document length unit; required and > 0 for an open hem, omitted for a closed hem. Inside radius = gap/2.',
      ),
    direction: z
      .enum(['up', 'down'])
      .optional()
      .describe("Fold towards the flat's +normal face ('up', default) or the -normal face ('down')."),
    widthStart: z.number().optional().describe('Inset of the hem from the edge start, in the document length unit (>= 0, default 0).'),
    widthEnd: z.number().optional().describe('Inset of the hem from the edge end, in the document length unit (>= 0, default 0).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: Parameters<typeof refuse>[2], why: string, fix: string, paths: string[]): CommandResult =>
      refuse(doc, 'add_hem', code, why, fix, { paths });
    const closed = params.hemType === 'closed';
    if (closed ? params.gap !== undefined && params.gap !== 0 : !(params.gap !== undefined && params.gap > 0))
      return fail(
        'FTR_PARAM_INVALID',
        closed ? 'a closed hem has no gap' : 'an open hem needs gap > 0',
        closed ? "Omit gap, or use hemType 'open'." : 'Give the gap between flat and return leg.',
        ['gap'],
      );
    const gap = closed ? 0 : (params.gap as number);
    const model = getModel(doc);
    const part = Object.hasOwn(model.parts, params.id) ? model.parts[params.id] : undefined;
    const rule = part === undefined ? undefined : ruleOfPart(model, part);
    const hemId = part === undefined ? 'h1' : nextNodeId(part, 'h');
    const outcome = applyFlange(
      doc,
      'add_hem',
      {
        id: params.id,
        edge: params.edge,
        angle: 180,
        length: params.length,
        lengthReference: 'tangent',
        position: 'material_outside',
        insideRadius: gap / 2,
        ...(params.direction !== undefined ? { direction: params.direction } : {}),
        ...(params.widthStart !== undefined ? { widthStart: params.widthStart } : {}),
        ...(params.widthEnd !== undefined ? { widthEnd: params.widthEnd } : {}),
      },
      {
        allowZeroRadius: closed,
        extraNodes: ({ flatId, bendId }) => [
          { id: hemId, type: 'hem', bend: bendId, flat: flatId, hemType: params.hemType, gap, length: params.length },
        ],
      },
    );
    if (outcome.result.rejected === true || rule === undefined) return outcome.result;
    const k = resolveK(rule, gap / 2);
    const quantities = hemQuantities({ thickness: rule.thickness, gap, k: k.value, leg: params.length });
    return {
      ...outcome.result,
      summary: `${outcome.result.summary} Hem ${hemId} (${params.hemType}, gap ${fixed(gap)}): developed length ${fixed(quantities?.developed.value ?? NaN)} (UNVERIFIED model).`,
      data: {
        hemId,
        bend: outcome.bendId,
        flat: outcome.flatId,
        bendAllowance: quantities?.bendAllowance.value,
        developedLength: { value: quantities?.developed.value, source: HEM_SOURCE, defaulted: false, verification: 'unverified' },
        kFactor: { value: k.value, source: k.source, defaulted: false, verification: k.verification },
      },
    };
  },
});
