import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { analyseLine, isAnalysis } from '../analysis';
import { refuseIso } from '../codes';
import { allLineIds } from '../lineNetwork';
import { spoolRow } from './spoolOutput';

/**
 * @affects none (query: returns the same document)
 * @invariant spools are derived from the line, so they follow every edit; breaks are the ones stored by split_spools (all breaks by default); names are stable for the same line
 * @failure unknown line -> ISO_LINE_NOT_FOUND; no piping at all -> ISO_NO_PIPING
 */
export const spoolList = defineCommand({
  name: 'spool_list',
  annotations: { readOnly: true, idempotent: true },
  description:
    'List the spools of one pipe line, or of every line when lineId is omitted: name (<line>-SP01 ... in flow order), the component ids, the longest centreline path (lengthMm), the sorted envelope (boxMm, ' +
    'connection points plus the largest outside diameter), weight (sum of the component weights; weightComplete false when some component carries none), pipe pieces, and the limit violations against ' +
    'set_fabrication_rules. Spools break at the choice stored by split_spools for the line (field welds, flanged joints and line ends by default). ' +
    'Returns data = { spools: [{ name, lineId, componentIds, lengthMm, boxMm, weightKg, weightComplete, pieces, violations }], count }. Refusals: ISO_LINE_NOT_FOUND, ISO_NO_PIPING.',
  params: z.object({
    lineId: z
      .string()
      .min(1)
      .optional()
      .describe('One line (routed line id, imported PCF line number, legacy line number). Omit for every line of the document.'),
  }),
  run: (doc, params): CommandResult => {
    const lineIds = params.lineId === undefined ? allLineIds(doc) : [params.lineId];
    if (lineIds.length === 0) return refuseIso(doc, 'spool_list', 'ISO_NO_PIPING', 'the document has no piping');
    const spools: Array<Record<string, unknown>> = [];
    for (const lineId of lineIds) {
      const analysis = analyseLine(doc, 'spool_list', lineId);
      if (!isAnalysis(analysis)) return analysis;
      spools.push(...analysis.spools.spools.map((spool) => spoolRow(spool, lineId, analysis.fabrication.rules?.maxSpool)));
    }
    const over = spools.filter((spool) => (spool['violations'] as unknown[]).length > 0).length;
    return report(
      doc,
      `spool_list: ${spools.length} spool(s) on ${lineIds.length} line(s): ${spools.map((spool) => String(spool['name'])).join(', ')}${over === 0 ? '' : `; ${over} over a limit`}`,
      { spools, count: spools.length },
    );
  },
});
