import type { BuildingElement } from '@aec/building/types';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { getBuilding } from '../../../building/model';
import { getFabrication } from '../../fabrication/state';
import { getPiping, refuse } from '../model';

/**
 * @affects changes the line number (`line`) of legacy pipes (add_pipe_run), several pipes may share one number (the runs of a line)
 * @invariant a legacy line number never equals a routed line number / id or an imported PCF line (one PIPELINE-REFERENCE per file, ISO_LINE_DUPLICATE); atomic
 * @failure unknown pipe, empty number, number of a routed or imported line -> RTE_* refusal, document unchanged
 */
export const setPipeLineNumber = defineCommand({
  name: 'set_pipe_line_number',
  description:
    'Set the line number of legacy pipes (add_pipe_run elements; routed lines have update_pipeline). pipes: [{ pipeId, line }]. Several pipes may carry the same ' +
    'number (the runs of one line), but not the number of a routed line or of an imported PCF line (the isometric export needs one PIPELINE-REFERENCE per line). ' +
    'The whole batch is applied or refused. Returns data = { changed [{ id, from, to }] }. Refusals: RTE_UNKNOWN_PIPE, RTE_DUPLICATE_LINE_NUMBER, RTE_EDIT_INVALID. ' +
    'Used by assign_plant_object (plant data) to write a line tag back.',
  params: z.object({
    pipes: z
      .array(
        z.object({
          pipeId: z.string().describe('Legacy pipe element id, e.g. "pipe-3".'),
          line: z.string().describe('New line number, not empty.'),
        }),
      )
      .min(1)
      .max(10000)
      .describe('Pipes and their new line numbers.'),
  }),
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    const piping = getPiping(doc);
    const taken = new Set([
      ...piping.lineOrder.flatMap((id) => [id, piping.lines[id]?.lineNumber ?? '']),
      ...Object.keys(getFabrication(doc).pcfLines),
    ]);
    const elements: Record<string, BuildingElement> = { ...building.elements };
    const changes: Array<{ id: string; from: string; to: string }> = [];
    for (const [index, entry] of params.pipes.entries()) {
      const pipe = elements[entry.pipeId];
      if (pipe?.category !== 'pipe')
        return refuse(doc, 'set_pipe_line_number', 'RTE_UNKNOWN_PIPE', `no legacy pipe "${entry.pipeId}"`, [], [`pipes[${index}].pipeId`]);
      const line = entry.line.trim();
      if (line === '')
        return refuse(doc, 'set_pipe_line_number', 'RTE_EDIT_INVALID', 'the line number is empty', [pipe.id], [`pipes[${index}].line`]);
      if (taken.has(line))
        return refuse(
          doc,
          'set_pipe_line_number',
          'RTE_DUPLICATE_LINE_NUMBER',
          `"${line}" is the number of a routed or imported line`,
          [pipe.id],
          [`pipes[${index}].line`],
        );
      if (pipe.line === line) continue;
      changes.push({ id: pipe.id, from: pipe.line ?? '', to: line });
      elements[pipe.id] = { ...pipe, line };
    }
    if (changes.length === 0)
      return { document: doc, summary: 'set_pipe_line_number: every pipe already has these numbers; nothing changed.', affected: [] };
    const result = commitBuilding(
      doc,
      { ...building, elements },
      changes.map((change) => change.id),
      `set_pipe_line_number: ${changes.length} pipe(s) renumbered.`,
    );
    return { ...result, data: { changed: changes } };
  },
});
