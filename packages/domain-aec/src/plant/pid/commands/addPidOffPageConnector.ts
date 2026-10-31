import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { Draft, fail, findLine, findSheet, isFail, refuse, segmentsOf, mintFree } from '../authoring/refs';
import type { PidOffPage } from '../model';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (one off-page connector on a free end of a line; that segment end now references it)
 * @invariant start = free `from` of the first segment (connector `in`), end = free `to` of the last segment (connector `out`); the connector sits on the end point; an unknown target sheet number is kept unresolved in passthrough pid:targetSheet
 * @failure line not found -> PID_ITEM_NOT_FOUND; the end is not free -> PID_LINE_ENDPOINT_INVALID; document unchanged
 */
export const addPidOffPageConnector = defineCommand({
  name: 'add_pid_off_page_connector',
  description:
    'Put an off-page connector (OPC) on the free end of a line so the line continues on another sheet. `end` is start (the free beginning: an incoming connector) or end ' +
    '(the free end: an outgoing connector). `pairKey` pairs the two connectors of one continuation (the same key on the other sheet, e.g. "OPC-1"); `targetSheet` is the sheet number the ' +
    'line goes to (e.g. "PID-002"); a number that is not a sheet yet stays unresolved (check_pid reports it later). Returns affected[0] = the connector id; data = { opc, direction }. ' +
    'Refusals (document unchanged): PID_ITEM_NOT_FOUND, PID_LINE_ENDPOINT_INVALID (that end is already connected). Alternative: add_pid_line with an { opc } end.',
  params: z.object({
    line: z.string().min(1).describe('Line id or line number.'),
    end: z
      .enum(['start', 'end'])
      .describe('Which end of the line: start (incoming connector) or end (outgoing connector). It must be a free end.'),
    pairKey: z.string().trim().min(1).describe('Key shared by the two connectors of one continuation, e.g. "OPC-1".'),
    targetSheet: z.string().min(1).optional().describe('Sheet number (or id) the line continues on, e.g. "PID-002".'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'add_pid_off_page_connector';
    const pid = getPid(doc);
    const line = findLine(pid, params.line, 'line');
    if (isFail(line)) return refuse(doc, name, line);
    const segments = segmentsOf(pid, line);
    const segment = params.end === 'start' ? segments[0] : segments[segments.length - 1];
    const end = segment === undefined ? undefined : params.end === 'start' ? segment.from : segment.to;
    if (segment === undefined || end?.type !== 'free')
      return refuse(doc, name, fail('PID_LINE_ENDPOINT_INVALID', `the ${params.end} of line ${params.line} is not a free end`, ['end']));
    const direction = params.end === 'start' ? 'in' : 'out';
    const target = params.targetSheet === undefined ? undefined : findSheet(pid, params.targetSheet);
    const opc: PidOffPage = {
      id: mintFree(pid),
      kind: 'opc',
      sheetId: segment.sheetId,
      at: end.at,
      rotationDeg: 0,
      dexpiClass: direction === 'out' ? 'FlowOutPipeOffPageConnector' : 'FlowInPipeOffPageConnector',
      attributes: {},
      ...(target !== undefined && !isFail(target)
        ? {}
        : params.targetSheet === undefined
          ? {}
          : { passthrough: { 'pid:targetSheet': params.targetSheet } }),
      direction,
      pairKey: params.pairKey,
      ...(target !== undefined && !isFail(target) ? { targetSheet: target.id } : {}),
    };
    const draft = new Draft(pid);
    draft.put(opc);
    draft.put({
      ...segment,
      ...(params.end === 'start' ? { from: { type: 'opc', itemId: opc.id } } : { to: { type: 'opc', itemId: opc.id } }),
    });
    return {
      document: withPid(doc, draft.model()),
      summary: `add_pid_off_page_connector: ${direction} connector ${params.pairKey} (${opc.id}) at the ${params.end} of line ${line.lineNumber ?? line.id}${params.targetSheet ? ` towards ${params.targetSheet}` : ''}`,
      affected: [opc.id],
      data: { opc: opc.id, direction },
    };
  },
});
