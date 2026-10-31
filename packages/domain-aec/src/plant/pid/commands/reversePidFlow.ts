import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { Draft, fail, findItem, findLine, isFail, refuse, segmentsOf } from '../authoring/refs';
import type { PidSegment } from '../model';
import { getPid, withPid } from '../state';

const flipped = (flow: PidSegment['flow']): PidSegment['flow'] => (flow === 'forward' ? 'reverse' : 'forward');

/**
 * @affects plant.pid (the flow of one segment, or of every segment of a line)
 * @invariant forward <-> reverse; a segment with flow none becomes forward; routes and ends are unchanged
 * @failure neither or both of line / segment -> PID_PARAM_INVALID; not found -> PID_ITEM_NOT_FOUND; segment param is not a segment -> PID_ITEM_KIND; document unchanged
 */
export const reversePidFlow = defineCommand({
  name: 'reverse_pid_flow',
  description:
    'Reverse the flow direction of a line (all its segments) or of one segment. Flow is stored per segment relative to its drawing direction (forward = from -> to, reverse = to -> from, none = unknown): ' +
    'forward becomes reverse and reverse becomes forward; a segment with flow none becomes forward. Give exactly one of `line` (line id or line number) and `segment` (segment id). ' +
    'Returns affected = the segment ids changed; data = { segments: [{ id, flow }] }. Refusals (document unchanged): PID_PARAM_INVALID, PID_ITEM_NOT_FOUND, PID_ITEM_KIND. Next: pid_report kind=connectivity.',
  params: z.object({
    line: z.string().min(1).optional().describe('Line id or line number: every segment of it is reversed.'),
    segment: z.string().min(1).optional().describe('Segment id: only this segment is reversed.'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'reverse_pid_flow';
    const pid = getPid(doc);
    if ((params.line === undefined) === (params.segment === undefined))
      return refuse(doc, name, fail('PID_PARAM_INVALID', 'give exactly one of line and segment', ['line', 'segment']));
    let targets: PidSegment[];
    if (params.line !== undefined) {
      const line = findLine(pid, params.line, 'line');
      if (isFail(line)) return refuse(doc, name, line);
      targets = segmentsOf(pid, line);
    } else {
      const segment = findItem(pid, params.segment ?? '', 'segment');
      if (isFail(segment)) return refuse(doc, name, segment);
      if (segment.kind !== 'segment')
        return refuse(doc, name, fail('PID_ITEM_KIND', `${params.segment} is a ${segment.kind}, not a segment`, ['segment']));
      targets = [segment];
    }
    const draft = new Draft(pid);
    const changes = targets.map((segment) => ({ ...segment, flow: flipped(segment.flow) }));
    changes.forEach((segment) => draft.put(segment));
    return {
      document: withPid(doc, draft.model()),
      summary: `reverse_pid_flow: ${changes.length} segment(s) reversed (${changes.map((s) => `${s.id} ${s.flow}`).join(', ')})`,
      affected: changes.map((s) => s.id),
      data: { segments: changes.map((s) => ({ id: s.id, flow: s.flow })) },
    };
  },
});
