import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analyseLine, isAnalysis, type LineAnalysis } from '../analysis';
import { refuseIso } from '../codes';
import type { FieldWeldRecord, SpoolBreak } from '../model';
import { getFabrication, withFabrication } from '../state';
import { suggestSplit, violationsOf } from '../spools';
import { spoolRow } from './spoolOutput';

const MAX_PASSES = 200;
const round1 = (value: number): number => Math.round(value * 10) / 10 + 0;

const violating = (analysis: LineAnalysis): ReturnType<typeof violationsOf> =>
  analysis.spools.spools.flatMap((spool) => violationsOf(spool, analysis.fabrication.rules?.maxSpool));

/**
 * @affects plant.fabrication.spoolBreaks[lineId]; with autoBreak also plant.fabrication.fieldWelds (the inserted site welds)
 * @invariant spools are derived (union over shop welds, flow-order names <line>-SP<nn>), the stored part is only the break choice and the inserted welds; autoBreak is deterministic: the pipe nearest the middle
 *   of the longest path of the worst spool, both pieces at least max(1 mm, minCutPieceMm); no limit is assumed (limits come from set_fabrication_rules)
 * @failure limit exceeded without autoBreak -> ISO_SPOOL_TOO_LARGE / ISO_SPOOL_TOO_HEAVY; autoBreak that cannot satisfy the limit -> the same code; autoBreak without field_welds in breakAt -> ISO_PARAM_INVALID;
 *   unknown line -> ISO_LINE_NOT_FOUND; the document is unchanged
 */
export const splitSpools = defineCommand({
  name: 'split_spools',
  description:
    'Split a pipe line into spools (shop-fabricated assemblies) and store the break choice for the line. Components joined by shop welds form one spool; breakAt lists what ends a spool: ' +
    'field_welds (site and field-fit welds), flanged_joints (bolted flange pairs) and line_ends (accepted for completeness: a line end is always the end of a spool). Spools are named ' +
    '<line>-SP01, -SP02 ... in the order of their first component (spoolPrefix of set_fabrication_rules replaces the line number). The limits of set_fabrication_rules (envelope, weight, pipe pieces) are checked: ' +
    'without autoBreak a spool over a limit is refused (ISO_SPOOL_TOO_LARGE / ISO_SPOOL_TOO_HEAVY); with autoBreak true site welds are inserted (add_field_weld equivalents, reported in data.insertedWelds) at the pipe ' +
    'nearest the middle of the longest path of the oversize spool, repeatedly, until every spool fits. No limit is invented: with none stored nothing is split. ' +
    'Returns data = { lineId, breakAt, spools: [{ name, componentIds, lengthMm (longest centreline path), boxMm (sorted envelope), weightKg, weightComplete, pieces, violations }], insertedWelds: [{ weldId, at }], limits }. ' +
    'Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_SPOOL_TOO_LARGE, ISO_SPOOL_TOO_HEAVY, ISO_PARAM_INVALID. Next: spool_list, cut_list, number_welds (numbers the inserted welds).',
  params: z.object({
    lineId: z.string().min(1).describe('The line: routed line id, imported PCF line number or legacy pipe line number.'),
    breakAt: z
      .array(z.enum(['field_welds', 'flanged_joints', 'line_ends']))
      .optional()
      .describe('What ends a spool: field_welds, flanged_joints, line_ends. Default all three.'),
    autoBreak: z
      .boolean()
      .optional()
      .describe(
        'true = insert site welds to bring an oversize spool within the limits (needs field_welds in breakAt). Default false: refuse instead.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const breakAt: SpoolBreak[] = params.breakAt ?? ['field_welds', 'flanged_joints', 'line_ends'];
    if (params.autoBreak === true && !breakAt.includes('field_welds'))
      return refuseIso(
        doc,
        'split_spools',
        'ISO_PARAM_INVALID',
        'autoBreak inserts site welds: breakAt must include field_welds',
        [params.lineId],
        ['breakAt'],
      );
    let current = doc;
    let analysis = analyseLine(current, 'split_spools', params.lineId, { breakAt });
    if (!isAnalysis(analysis)) return analysis;
    const inserted: FieldWeldRecord[] = [];
    for (let pass = 0; pass < MAX_PASSES && violating(analysis as LineAnalysis).length > 0 && params.autoBreak === true; pass++) {
      const state = analysis as LineAnalysis;
      const rules = state.fabrication.rules;
      const worst = state.spools.spools.find((spool) => violationsOf(spool, rules?.maxSpool).length > 0);
      const point = worst === undefined ? null : suggestSplit(state.read.network, worst, Math.max(1, rules?.minCutPieceMm?.value ?? 0));
      if (point === null) break;
      const weld: FieldWeldRecord = {
        id: nextId('fw'),
        lineId: params.lineId,
        xyz: [round1(point[0]), round1(point[1]), round1(point[2])],
        type: 'site',
      };
      const fabrication = getFabrication(current);
      current = withFabrication(current, { ...fabrication, fieldWelds: { ...fabrication.fieldWelds, [weld.id]: weld } });
      inserted.push(weld);
      const again = analyseLine(current, 'split_spools', params.lineId, { breakAt });
      if (!isAnalysis(again)) return again;
      analysis = again;
    }
    const final = analysis as LineAnalysis;
    const remaining = violating(final)[0];
    if (remaining !== undefined)
      return refuseIso(
        doc,
        'split_spools',
        remaining.code,
        `${remaining.message}${params.autoBreak === true ? ` (autoBreak could not satisfy it after ${inserted.length} weld(s))` : ''}`,
        final.spools.spools.filter((spool) => violationsOf(spool, final.fabrication.rules?.maxSpool).length > 0).map((spool) => spool.name),
        ['lineId'],
      );
    const fabrication = getFabrication(current);
    const document = withFabrication(current, { ...fabrication, spoolBreaks: { ...fabrication.spoolBreaks, [params.lineId]: breakAt } });
    const limits = final.fabrication.rules?.maxSpool;
    return {
      document,
      summary:
        `split_spools: line ${params.lineId}: ${final.spools.spools.length} spool(s) ${final.spools.spools.map((spool) => spool.name).join(', ')} (break at ${breakAt.join(', ')})` +
        `${inserted.length === 0 ? '' : `; autoBreak inserted ${inserted.length} site weld(s) ${inserted.map((weld) => weld.id).join(', ')}`}`,
      affected: [params.lineId, ...inserted.map((weld) => weld.id)],
      data: {
        lineId: params.lineId,
        breakAt,
        spools: final.spools.spools.map((spool) => spoolRow(spool, params.lineId, limits)),
        insertedWelds: inserted.map((weld) => ({ weldId: weld.id, at: weld.xyz })),
        limits: limits ?? null,
      },
    };
  },
});
