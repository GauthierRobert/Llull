import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { analyseLine, isAnalysis } from '../analysis';
import { isoIssue, refuseIso } from '../codes';

/**
 * @affects none (query: returns the same document)
 * @invariant welds are listed in numbering order; an unnumbered joint shows the number number_welds would give it (numbered false); orphaned numbers are listed apart
 * @failure unknown line -> ISO_LINE_NOT_FOUND; unknown spoolId -> ISO_SPOOL_NOT_FOUND; unnumbered joints -> warning ISO_WELDS_UNNUMBERED in data.warnings (not a refusal)
 */
export const weldList = defineCommand({
  name: 'weld_list',
  annotations: { readOnly: true, idempotent: true },
  description:
    'List the welds of a pipe line, in numbering order (walking from the line start, main run before each branch): number, kind (shop = welded in the shop, site or field_fit = welded on site; ' +
    'field is true for both), position, the components it joins, bore, end type and the spool(s). Butt-weld and socket-weld joints between components are shop welds; a WELD record of the line ' +
    '(SKEY WS site / WF field-fit) or a weld added with add_field_weld sets the kind; set_weld_type overrides it. Bolted flange pairs are not welds (flangedTerminals counts the flanged line ends). ' +
    'Numbers come from number_welds; a joint not yet numbered shows the number it would get (numbered false) and data.warnings has ISO_WELDS_UNNUMBERED. Spools use the breaks of split_spools (all breaks by default). ' +
    'Returns data = { lineId, welds: [{ weldId (null until numbered), number, numbered, kind, field, at: [x, y, z] mm, componentIds, boreMm, endType, spool, spools }], orphaned: [{ weldId, number, at }], ' +
    'counts: { total, shop, site, fieldFit, unnumbered }, highest, flangedTerminals, warnings }. Refusals: ISO_LINE_NOT_FOUND, ISO_SPOOL_NOT_FOUND.',
  params: z.object({
    lineId: z.string().min(1).describe('The line: routed line id, imported PCF line number or legacy pipe line number.'),
    spoolId: z.string().min(1).optional().describe('Only the welds that touch this spool (a name from spool_list, e.g. L-101-SP02).'),
  }),
  run: (doc, params): CommandResult => {
    const analysis = analyseLine(doc, 'weld_list', params.lineId);
    if (!isAnalysis(analysis)) return analysis;
    const names = analysis.spools.spools.map((spool) => spool.name);
    if (params.spoolId !== undefined && !names.includes(params.spoolId))
      return refuseIso(
        doc,
        'weld_list',
        'ISO_SPOOL_NOT_FOUND',
        `line ${params.lineId} has no spool "${params.spoolId}" (${names.join(', ')})`,
        [params.lineId],
        ['spoolId'],
      );
    const welds = analysis.numbering.entries
      .map((entry) => {
        const spools = [...new Set(entry.joint.members.map((member) => names[analysis.spools.spoolOf.get(member) ?? -1] ?? ''))].filter(
          (name) => name !== '',
        );
        return {
          weldId: entry.status === 'kept' ? entry.record.id : null,
          number: entry.record.number,
          numbered: entry.status === 'kept',
          kind: entry.record.kind,
          field: entry.record.kind !== 'shop',
          at: entry.record.joint.xyz,
          componentIds: entry.componentIds,
          boreMm: entry.record.joint.boreMm,
          endType: entry.record.joint.endType,
          spool: spools[0] ?? null,
          spools,
        };
      })
      .filter((weld) => params.spoolId === undefined || weld.spools.includes(params.spoolId));
    const unnumbered = welds.filter((weld) => !weld.numbered);
    const warnings = [
      ...(unnumbered.length === 0
        ? []
        : [
            isoIssue(
              'ISO_WELDS_UNNUMBERED',
              'warning',
              `${unnumbered.length} weld(s) have no stored number`,
              unnumbered.map((weld) => weld.number),
            ),
          ]),
      ...(analysis.read.staleWelds.length === 0
        ? []
        : [
            isoIssue(
              'ISO_FIELD_WELD_STALE',
              'warning',
              `${analysis.read.staleWelds.length} field weld(s) lie on no pipe any more`,
              analysis.read.staleWelds,
            ),
          ]),
    ];
    const terminals = analysis.graph.terminals.filter((terminal) => terminal.endType === 'FL').length;
    return report(
      doc,
      `weld_list: line ${params.lineId}: ${welds.length} weld(s) (${welds.filter((weld) => weld.kind === 'shop').length} shop, ${welds.filter((weld) => weld.field).length} field), ${terminals} flanged end(s)` +
        `${unnumbered.length === 0 ? '' : `; ${unnumbered.length} unnumbered (ISO_WELDS_UNNUMBERED): run number_welds`}${analysis.numbering.orphaned.length === 0 ? '' : `; ${analysis.numbering.orphaned.length} orphaned number(s)`}`,
      {
        lineId: params.lineId,
        welds,
        orphaned: analysis.numbering.orphaned.map((record) => ({ weldId: record.id, number: record.number, at: record.joint.xyz })),
        counts: {
          total: welds.length,
          shop: welds.filter((weld) => weld.kind === 'shop').length,
          site: welds.filter((weld) => weld.kind === 'site').length,
          fieldFit: welds.filter((weld) => weld.kind === 'field_fit').length,
          unnumbered: unnumbered.length,
        },
        highest: analysis.numbering.highest,
        flangedTerminals: terminals,
        warnings,
      },
    );
  },
});
