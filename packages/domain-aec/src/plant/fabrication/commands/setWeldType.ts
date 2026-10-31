import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { MM_PER_UNIT } from '@core/model/units';
import { distance3 } from '@lib/vec3';
import { refuseIso } from '../codes';
import type { WeldRecord } from '../model';
import { getFabrication, withFabrication } from '../state';
import { weldPrefix } from '../welds';

/**
 * @affects plant.fabrication.welds[weldId] (kind, kindSet, number prefix)
 * @invariant the weld keeps its sequence number n; the number is re-prefixed for the new kind; the kind then wins over what is detected (a spool break follows it)
 * @failure no numbered weld with that id / at that point -> ISO_WELD_NOT_FOUND; neither weldId nor lineId + at -> ISO_PARAM_INVALID; the document is unchanged
 */
export const setWeldType = defineCommand({
  name: 'set_weld_type',
  description:
    'Change the type of a numbered weld: shop (welded in the shop, inside a spool), site (welded on site, ends a spool) or field_fit (site weld with a cut-to-length allowance). The weld is found by weldId ' +
    '(from weld_list / number_welds, "<lineId>#<n>") or by lineId + a point `at` within 1 mm of it (document units, world coordinates). The weld keeps its sequence number, the prefix follows the new type ' +
    '(set_fabrication_rules weldPrefixFabrication / weldPrefixErection), and the type is remembered over what is detected from the line. spool_list, cut_list and piping_bom follow it. ' +
    'Returns data = { weldId, number, previous, type } and affected = [weldId]. Refusals: ISO_WELD_NOT_FOUND (number the welds first with number_welds), ISO_PARAM_INVALID.',
  params: z.object({
    type: z.enum(['shop', 'site', 'field_fit']).describe('shop = shop weld, site = welded on site, field_fit = site weld with allowance.'),
    weldId: z.string().min(1).optional().describe('The weld id from weld_list ("<lineId>#<n>"). Give this, or lineId + at.'),
    lineId: z.string().min(1).optional().describe('The line of the weld when finding it by point.'),
    at: vec3(
      'Point of the weld [x, y, z] in document units, world coordinates; finds the numbered weld within 1 mm. Needs lineId.',
    ).optional(),
  }),
  run: (doc, params): CommandResult => {
    const fabrication = getFabrication(doc);
    if (params.weldId === undefined && (params.lineId === undefined || params.at === undefined))
      return refuseIso(doc, 'set_weld_type', 'ISO_PARAM_INVALID', 'give weldId, or lineId and at', [], ['weldId', 'lineId', 'at']);
    const scale = MM_PER_UNIT[doc.units];
    const wanted = params.at === undefined ? undefined : ([params.at[0] * scale, params.at[1] * scale, params.at[2] * scale] as const);
    const welds = Object.values(fabrication.welds ?? {});
    const found: WeldRecord | undefined =
      params.weldId !== undefined
        ? fabrication.welds?.[params.weldId]
        : welds.find(
            (weld) =>
              weld.lineId === params.lineId &&
              weld.status === 'active' &&
              wanted !== undefined &&
              distance3([weld.joint.xyz[0], weld.joint.xyz[1], weld.joint.xyz[2]], [wanted[0], wanted[1], wanted[2]]) <= 1,
          );
    if (found === undefined)
      return refuseIso(
        doc,
        'set_weld_type',
        'ISO_WELD_NOT_FOUND',
        params.weldId === undefined ? `no numbered weld of line ${params.lineId} at the point` : `no weld "${params.weldId}"`,
        [params.weldId ?? params.lineId ?? ''],
        [params.weldId === undefined ? 'at' : 'weldId'],
      );
    const next: WeldRecord = {
      ...found,
      kind: params.type,
      kindSet: true,
      number: `${weldPrefix(fabrication.rules, params.type)}${found.n}`,
    };
    return {
      document: withFabrication(doc, { ...fabrication, welds: { ...fabrication.welds, [found.id]: next } }),
      summary: `set_weld_type: weld ${found.id} (${found.number}) ${found.kind} -> ${params.type}${next.number === found.number ? '' : `, now ${next.number}`}`,
      affected: [found.id],
      data: { weldId: found.id, number: next.number, previous: found.kind, type: params.type },
    };
  },
});
