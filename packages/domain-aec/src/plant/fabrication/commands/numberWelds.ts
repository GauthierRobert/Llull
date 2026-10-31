import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { analyseLine, isAnalysis } from '../analysis';
import { refuseIso } from '../codes';
import type { WeldRecord } from '../model';
import { getFabrication, withFabrication } from '../state';
import type { WeldEntry } from '../welds';

const row = (record: WeldRecord): Record<string, unknown> => ({
  weldId: record.id,
  lineId: record.lineId,
  number: record.number,
  kind: record.kind,
  at: record.joint.xyz,
});

/**
 * @affects plant.fabrication.welds (records of the given lines), plant.fabrication.highestWeldNumber
 * @invariant a joint found again keeps its number (same position and components, else same position, else same components); new joints take highest + 1 in depth-first order from the line start
 *   (main run before branch); a vanished joint is kept `orphaned` and its number is never reused; renumber:true is the only way numbers restart and is reported
 * @failure unknown line -> ISO_LINE_NOT_FOUND; no line given -> ISO_PARAM_INVALID; the document is unchanged
 */
export const numberWelds = defineCommand({
  name: 'number_welds',
  description:
    'Store weld numbers for the welds of one or more pipe lines (shop, site and field-fit welds; bolted flange pairs are not welds). Numbers are persistent: a weld found again after a model edit keeps its number, ' +
    'a new weld takes highest + 1 (highest includes an imported PCF HIGHEST-WELD-NUMBER), and a weld whose joint disappeared is kept as orphaned and its number is never reused (NDE traceability). ' +
    'New numbers follow the order the welds are reached walking the line from its start, the main run before each branch; the number is prefix + n (prefixes from set_fabrication_rules, default W). ' +
    'renumber true restarts at 1 and drops orphaned numbers (reported in data.dropped): use it deliberately. Give lineId or lineIds. ' +
    'Returns data = { lines: [{ lineId, highest }], assigned: [{ weldId, lineId, number, kind, at }], kept: [...], orphaned: [...], dropped: [...], highest: { <lineId>: n }, warnings }, affected = ids of the new and newly orphaned welds. ' +
    'Refusals: ISO_LINE_NOT_FOUND, ISO_PARAM_INVALID (no line). Next: weld_list shows them; add_field_weld then number_welds numbers the new weld only.',
  params: z.object({
    lineId: z.string().min(1).optional().describe('One line (routed line id, imported PCF line number or legacy line number).'),
    lineIds: z.array(z.string().min(1)).optional().describe('Several lines; combined with lineId when both are given.'),
    renumber: z
      .boolean()
      .optional()
      .describe(
        'true = discard every stored number of these lines and number again from 1 (explicit, reported). Default false: numbers are kept.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const lineIds = [...new Set([...(params.lineId === undefined ? [] : [params.lineId]), ...(params.lineIds ?? [])])];
    if (lineIds.length === 0) return refuseIso(doc, 'number_welds', 'ISO_PARAM_INVALID', 'give lineId or lineIds', [], ['lineId']);
    let fabrication = getFabrication(doc);
    const assigned: Record<string, unknown>[] = [];
    const kept: Record<string, unknown>[] = [];
    const orphaned: Record<string, unknown>[] = [];
    const dropped: Record<string, unknown>[] = [];
    const highest: Record<string, number> = {};
    const affected: string[] = [];
    const warnings: Array<{ code: string; ids: readonly string[] }> = [];
    for (const lineId of lineIds) {
      const analysis = analyseLine(doc, 'number_welds', lineId, { renumber: params.renumber === true });
      if (!isAnalysis(analysis)) return analysis;
      const plan = analysis.numbering;
      const entries: readonly WeldEntry[] = plan.entries;
      const previous = new Set(
        Object.values(fabrication.welds ?? {})
          .filter((weld) => weld.lineId === lineId && weld.status === 'orphaned')
          .map((weld) => weld.id),
      );
      const others = Object.fromEntries(Object.entries(fabrication.welds ?? {}).filter(([, weld]) => weld.lineId !== lineId));
      const mine = Object.fromEntries([...entries.map((entry) => entry.record), ...plan.orphaned].map((record) => [record.id, record]));
      fabrication = {
        ...fabrication,
        welds: { ...others, ...mine },
        highestWeldNumber: { ...fabrication.highestWeldNumber, [lineId]: plan.highest },
      };
      highest[lineId] = plan.highest;
      for (const entry of entries) (entry.status === 'assigned' ? assigned : kept).push(row(entry.record));
      for (const record of plan.orphaned) {
        orphaned.push(row(record));
        if (!previous.has(record.id)) affected.push(record.id);
      }
      for (const record of plan.dropped) dropped.push(row(record));
      affected.push(...entries.filter((entry) => entry.status === 'assigned').map((entry) => entry.record.id));
      if (analysis.read.staleWelds.length > 0) warnings.push({ code: 'ISO_FIELD_WELD_STALE', ids: analysis.read.staleWelds });
    }
    return {
      document: withFabrication(doc, fabrication),
      summary:
        `number_welds: ${lineIds.join(', ')}: ${assigned.length} new, ${kept.length} kept, ${orphaned.length} orphaned` +
        `${dropped.length === 0 ? '' : `, ${dropped.length} dropped (renumber)`}; highest ${lineIds.map((lineId) => `${lineId}=${highest[lineId]}`).join(', ')}` +
        `${params.renumber === true ? '; RENUMBERED from 1' : ''}`,
      affected,
      data: {
        lines: lineIds.map((lineId) => ({ lineId, highest: highest[lineId] })),
        assigned,
        kept,
        orphaned,
        dropped,
        highest,
        warnings,
      },
    };
  },
});
