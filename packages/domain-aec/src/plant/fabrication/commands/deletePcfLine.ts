import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { refuseIso } from '../codes';
import { getFabrication, withFabrication } from '../state';

/**
 * @affects plant.fabrication.pcfLines[lineId] (removed)
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
    return {
      document: withFabrication(doc, { ...fabrication, pcfLines }),
      summary: `delete_pcf_line: removed line ${params.lineId} (${line.components.length} component(s))`,
      affected: [params.lineId],
    };
  },
});
