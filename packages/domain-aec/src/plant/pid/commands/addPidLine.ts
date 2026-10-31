import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { Vec2 } from '@core/model/vectors';
import { endpointParam, resolveEnd } from '../authoring/endpoints';
import { dedupe, orthogonalRoute, samePoint } from '../authoring/geometry';
import { Draft, fail, findSheet, isFail, refuse, mintFree } from '../authoring/refs';
import type { PidLine, PidSegment } from '../model';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (one line, its first segment, and the off-page connector of an opc end; a tee end only references the host segment)
 * @invariant a nozzle takes <= 1 segment; the route starts and ends on its end points; without `via` the route is orthogonal (straight, L or Z); line numbers are unique; segment dn / class / flow come from the line
 * @failure sheet unknown -> PID_SHEET_NOT_FOUND; nozzle in use -> PID_NOZZLE_OCCUPIED; bad end -> PID_LINE_ENDPOINT_INVALID; tee point > 5 mm off -> PID_POINT_OFF_LINE; line number used -> PID_LINE_NUMBER_DUPLICATE; document unchanged
 */
export const addPidLine = defineCommand({
  name: 'add_pid_line',
  description:
    'Draw a process line (a DEXPI PipingNetworkSystem with one segment) between two ends on a P&ID sheet. Each end `from` / `to` is exactly one of: a nozzle ' +
    '{ tag: "P-101", nozzle: "N1" } (a nozzle takes one line), a tee on another line { line, at: [x, y] } (the point is snapped to the line, within 5 mm), an off-page ' +
    'connector { opc: "OPC-1", targetSheet?: "PID-002", at? } created with the line (an `in` connector at `from`, an `out` connector at `to`), or an open end { free: [x, y] } ' +
    '(sheet mm). `via` lists the bends between the ends; without it the route is orthogonal (straight, L or Z, leaving a nozzle along its side). `dn` is the ' +
    'integer nominal size, `flow` is relative to the drawing direction from -> to (forward, reverse, none). Returns affected = [line id, segment id, opc id?]; ' +
    'affected[0] is the line id (alias it, pass it as `line` to add_pid_inline). data = { line, segment, route }. Refusals (document unchanged): PID_SHEET_NOT_FOUND, ' +
    'PID_NOZZLE_OCCUPIED, PID_LINE_ENDPOINT_INVALID, PID_ITEM_NOT_FOUND, PID_POINT_OFF_LINE, PID_LINE_NUMBER_DUPLICATE. Next: add_pid_inline, add_pid_instrument.',
  params: z.object({
    sheet: z.string().min(1).describe('Sheet number or id the line is drawn on.'),
    from: endpointParam.describe('Start end: { tag, nozzle } | { line, at } | { opc, targetSheet?, at? } | { free: [x, y] }.'),
    to: endpointParam.describe('End end, same forms as `from`.'),
    via: z
      .array(vec2('Bend point [x, y], sheet mm.'))
      .optional()
      .describe('Bend points between the ends, sheet mm, in drawing order (default: automatic orthogonal route).'),
    lineNumber: z.string().trim().min(1).optional().describe('Line number, unique in the document (e.g. "80-P-1002-A1").'),
    dn: z.number().int().positive().optional().describe('Nominal size, DN integer (e.g. 80).'),
    pipingClass: z.string().trim().min(1).optional().describe('Piping class / spec (e.g. "A1").'),
    fluidCode: z.string().trim().min(1).optional().describe('Fluid code (e.g. "P").'),
    flow: z
      .enum(['forward', 'reverse', 'none'])
      .optional()
      .describe('Flow relative to the drawing direction from -> to (default forward).'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'add_pid_line';
    const pid = getPid(doc);
    const sheet = findSheet(pid, params.sheet);
    if (isFail(sheet)) return refuse(doc, name, sheet);
    if (
      params.lineNumber !== undefined &&
      pid.itemOrder.some((id) => {
        const item = pid.items[id];
        return item?.kind === 'line' && item.lineNumber === params.lineNumber;
      })
    )
      return refuse(
        doc,
        name,
        fail('PID_LINE_NUMBER_DUPLICATE', `line number "${params.lineNumber}" is used by another line`, ['lineNumber']),
      );
    const from = resolveEnd(pid, params.from, 'from', sheet.id, 'from');
    if (isFail(from)) return refuse(doc, name, from);
    const to = resolveEnd(pid, params.to, 'to', sheet.id, 'to');
    if (isFail(to)) return refuse(doc, name, to);
    const via: Vec2[] = (params.via ?? []).map((p) => [p[0], p[1]]);
    const startPoint = from.point ?? via[0] ?? (to.point === undefined ? undefined : ([to.point[0] - 40, to.point[1]] as const));
    const endPoint =
      to.point ?? via[via.length - 1] ?? (from.point === undefined ? undefined : ([from.point[0] + 40, from.point[1]] as const));
    if (startPoint === undefined || endPoint === undefined)
      return refuse(
        doc,
        name,
        fail('PID_LINE_ENDPOINT_INVALID', 'both ends are off-page connectors without a position: give `at` for one', ['from', 'to']),
      );
    const route = via.length > 0 ? dedupe([startPoint, ...via, endPoint]) : orthogonalRoute(startPoint, endPoint, from.axis, to.axis);
    if (route.length < 2 || samePoint(startPoint, endPoint))
      return refuse(doc, name, fail('PID_LINE_ENDPOINT_INVALID', 'the two ends are at the same point', ['from', 'to']));
    const targetSheet = (opc: typeof from.opc): { targetSheet?: string; passthrough?: Record<string, string> } => {
      const wanted = params[opc?.direction === 'out' ? 'to' : 'from'].targetSheet;
      if (wanted === undefined) return {};
      const found = findSheet(pid, wanted);
      return isFail(found) ? { passthrough: { 'pid:targetSheet': wanted } } : { targetSheet: found.id };
    };
    const lineId = mintFree(pid);
    const segmentId = mintFree(pid);
    const line: PidLine = {
      id: lineId,
      kind: 'line',
      sheetId: sheet.id,
      at: startPoint,
      rotationDeg: 0,
      dexpiClass: 'PipingNetworkSystem',
      attributes: {},
      ...(params.lineNumber === undefined ? {} : { lineNumber: params.lineNumber }),
      ...(params.dn === undefined ? {} : { dn: params.dn }),
      ...(params.pipingClass === undefined ? {} : { pipingClass: params.pipingClass }),
      ...(params.fluidCode === undefined ? {} : { fluidCode: params.fluidCode }),
      segmentIds: [segmentId],
    };
    const segment: PidSegment = {
      id: segmentId,
      kind: 'segment',
      sheetId: sheet.id,
      at: startPoint,
      rotationDeg: 0,
      dexpiClass: 'PipingNetworkSegment',
      attributes: {},
      passthrough: { 'dexpi:segment': segmentId },
      lineId,
      from: from.endpoint,
      to: to.endpoint,
      route,
      flow: params.flow ?? 'forward',
      ...(params.dn === undefined ? {} : { dn: params.dn }),
      ...(params.pipingClass === undefined ? {} : { pipingClass: params.pipingClass }),
      primary: true,
    };
    const draft = new Draft(pid);
    draft.put(line);
    draft.put(segment);
    const connectors = [from.opc, to.opc].flatMap((opc, i) => {
      if (opc === undefined) return [];
      const end = i === 0 ? route[0] : route[route.length - 1];
      return [{ ...opc, at: end ?? opc.at, ...targetSheet(opc) }];
    });
    connectors.forEach((opc) => draft.put(opc));
    return {
      document: withPid(doc, draft.model()),
      summary:
        `add_pid_line: line ${params.lineNumber ?? lineId} (${lineId}) with segment ${segmentId} on ${sheet.number}, ${route.length} route points` +
        (connectors.length > 0 ? `, ${connectors.length} off-page connector(s) ${connectors.map((c) => c.id).join(', ')}` : ''),
      affected: [lineId, segmentId, ...connectors.map((c) => c.id)],
      data: { line: lineId, segment: segmentId, route },
    };
  },
});
