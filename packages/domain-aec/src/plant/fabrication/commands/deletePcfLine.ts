import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { refuseIso } from '../codes';
import { getFabrication, withFabrication } from '../state';

/**
 * @affects plant.fabrication.pcfLines[lineId] (removed) with the line's field welds, weld numbers and spool breaks
 * @invariant only lines stored by import_pcf are removed; routed and legacy lines are untouched
 * @failure no imported line with that id -> ISO_LINE_NOT_FOUND; the document is unchanged
 */
export const deletePcfLine = defineCommand({
  name: 'delete_pcf_line',
  description:
    'Delete a pipe line stored by import_pcf (a pcf_line), freeing its line id so the file can be imported again. Routed lines (delete_pipe_run) and legacy pipes ' +
    '(delete_building_element) are not touched by this command. Refusal: ISO_LINE_NOT_FOUND when no imported line has that id. Returns affected = [lineId].',
  params: z.object({
    lineId: z.string().min(1).describe('The imported line id (the PIPELINE-REFERENCE or the lineIdOverride used at import_pcf).'),
  }),
  run: (doc, params): CommandResult => {
    const fabrication = getFabrication(doc);
    const line = fabrication.pcfLines[params.lineId];
    if (line === undefined)
      return refuseIso(
        doc,
        'delete_pcf_line',
        'ISO_LINE_NOT_FOUND',
        `no imported PCF line "${params.lineId}"`,
        [params.lineId],
        ['lineId'],
      );
    const { [params.lineId]: _removed, ...pcfLines } = fabrication.pcfLines;
    void _removed;
    const ofOtherLines = <T extends { lineId: string }>(records: Readonly<Record<string, T>> | undefined): Record<string, T> | undefined =>
      records === undefined
        ? undefined
        : Object.fromEntries(Object.entries(records).filter(([, record]) => record.lineId !== params.lineId));
    const without = <T>(record: Readonly<Record<string, T>> | undefined): Record<string, T> | undefined =>
      record === undefined ? undefined : Object.fromEntries(Object.entries(record).filter(([key]) => key !== params.lineId));
    const fieldWelds = ofOtherLines(fabrication.fieldWelds);
    const welds = ofOtherLines(fabrication.welds);
    const highestWeldNumber = without(fabrication.highestWeldNumber);
    const spoolBreaks = without(fabrication.spoolBreaks);
    return {
      document: withFabrication(doc, {
        version: 1,
        pcfLines,
        ...(fabrication.rules === undefined ? {} : { rules: fabrication.rules }),
        ...(fieldWelds === undefined ? {} : { fieldWelds }),
        ...(welds === undefined ? {} : { welds }),
        ...(highestWeldNumber === undefined ? {} : { highestWeldNumber }),
        ...(spoolBreaks === undefined ? {} : { spoolBreaks }),
      }),
      summary: `delete_pcf_line: removed line ${params.lineId} (${line.components.length} component(s))`,
      affected: [params.lineId],
    };
  },
});
