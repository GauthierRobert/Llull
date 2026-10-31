import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { Vec2 } from '@core/model/vectors';
import { dedupe, orthogonalRoute, samePoint } from '../authoring/geometry';
import { Draft, fail, findItem, isFail, refuse, mintFree } from '../authoring/refs';
import { PID_SIGNAL_KINDS, type PidSignal } from '../model';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (one information flow between two instruments / actuating systems)
 * @invariant both ends are instruments or actuating systems on the same sheet; the route runs from the first to the second item (orthogonal when `via` is absent)
 * @failure end unknown -> PID_ITEM_NOT_FOUND; end not an instrument / actuating system, other sheet, or same item -> PID_LINE_ENDPOINT_INVALID; document unchanged
 */
export const addPidSignalLine = defineCommand({
  name: 'add_pid_signal_line',
  description:
    'Draw an information flow (signal line) between two instruments, or from an instrument to an actuating system, on one P&ID sheet. `from` and `to` are tags or item ids ' +
    '(e.g. "FT-101" to "FIC-101"); `kind` is the line style: measuring, electric, pneumatic, software or capillary. `via` lists bend points in sheet mm; without it the route is ' +
    'orthogonal. For the process connection of an instrument use add_pid_instrument `measures`. Returns affected[0] = the signal id; data = { signal, route }. ' +
    'Refusals (document unchanged): PID_ITEM_NOT_FOUND, PID_LINE_ENDPOINT_INVALID (an end is not an instrument or actuating system, the ends are on different sheets or the same item).',
  params: z.object({
    from: z.string().min(1).describe('Source instrument or actuating system: tag or item id.'),
    to: z.string().min(1).describe('Target instrument or actuating system: tag or item id.'),
    kind: z.enum(PID_SIGNAL_KINDS).describe('Signal style: measuring, electric, pneumatic, software or capillary.'),
    via: z
      .array(vec2('Bend point [x, y], sheet mm.'))
      .optional()
      .describe('Bend points between the two items, sheet mm (default: automatic orthogonal route).'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'add_pid_signal_line';
    const pid = getPid(doc);
    const from = findItem(pid, params.from, 'from');
    if (isFail(from)) return refuse(doc, name, from);
    const to = findItem(pid, params.to, 'to');
    if (isFail(to)) return refuse(doc, name, to);
    const signalEnd = (item: typeof from): boolean => item.kind === 'instrument' || item.kind === 'actuating';
    if (!signalEnd(from) || !signalEnd(to))
      return refuse(
        doc,
        name,
        fail('PID_LINE_ENDPOINT_INVALID', `a signal joins instruments or actuating systems, got ${from.kind} and ${to.kind}`, [
          'from',
          'to',
        ]),
      );
    if (from.id === to.id || from.sheetId !== to.sheetId)
      return refuse(doc, name, fail('PID_LINE_ENDPOINT_INVALID', 'the two ends must be different items on the same sheet', ['from', 'to']));
    const via: Vec2[] = (params.via ?? []).map((p) => [p[0], p[1]]);
    const route = via.length > 0 ? dedupe([from.at, ...via, to.at]) : orthogonalRoute(from.at, to.at, undefined, undefined);
    if (route.length < 2 || samePoint(from.at, to.at))
      return refuse(doc, name, fail('PID_LINE_ENDPOINT_INVALID', 'the two items are at the same point', ['from', 'to']));
    const signal: PidSignal = {
      id: mintFree(pid),
      kind: 'signal',
      sheetId: from.sheetId,
      at: from.at,
      rotationDeg: 0,
      dexpiClass: 'InformationFlow',
      attributes: {},
      signalKind: params.kind,
      from: { type: 'instrument', itemId: from.id },
      to: { type: 'instrument', itemId: to.id },
      route,
    };
    const draft = new Draft(pid);
    draft.put(signal);
    return {
      document: withPid(doc, draft.model()),
      summary: `add_pid_signal_line: ${params.kind} signal ${signal.id} from ${from.tag ?? from.id} to ${to.tag ?? to.id}, ${route.length} route points`,
      affected: [signal.id],
      data: { signal: signal.id, route },
    };
  },
});
