/** Segment split at an inline item and heal (plant 04 PID §5.3): the routes, the ends and the tee references that follow. */

import type { Vec2 } from '@core/model/vectors';
import { healRoutes, nearestLeg } from './geometry';
import type { Draft } from './refs';
import type { PidEndpoint, PidInline, PidLine, PidSegment } from '../model';

/** Group key folding the pieces of one drawn segment (the DEXPI segment of the census). */
export const groupKey = (segment: PidSegment): string => segment.passthrough?.['dexpi:segment'] ?? segment.id;

const withGroup = (segment: PidSegment, key: string): Record<string, string> => ({ ...segment.passthrough, 'dexpi:segment': key });

/** Re-points the branch ends (tees of segments and signals) that sat on `host` and now lie on `moved`'s route (the closer of the two routes wins). */
export function movedBranches(draft: Draft, host: PidSegment, hostRoute: readonly Vec2[] | undefined, moved: PidSegment): void {
  const retarget = (end: PidEndpoint): PidEndpoint => {
    if (end.type !== 'branch' || end.segmentId !== host.id) return end;
    if (hostRoute === undefined) return { ...end, segmentId: moved.id };
    const onHost = nearestLeg(hostRoute, end.at)?.distance ?? Infinity;
    const onMoved = nearestLeg(moved.route, end.at)?.distance ?? Infinity;
    return onMoved < onHost ? { ...end, segmentId: moved.id } : end;
  };
  for (const id of draft.order) {
    const item = draft.get(id);
    if (item?.kind === 'segment' || item?.kind === 'signal') {
      const from = retarget(item.from);
      const to = retarget(item.to);
      if (from !== item.from || to !== item.to) draft.put({ ...item, from, to });
    }
  }
}

/** Splits `host` at the inline item: the host keeps its id and the first piece, a new segment (`newId`) takes the second piece and the old end. */
export function splitSegmentAt(
  draft: Draft,
  host: PidSegment,
  line: PidLine,
  inline: PidInline,
  pieces: { first: Vec2[]; second: Vec2[] },
  newId: string,
): void {
  const key = groupKey(host);
  const first: PidSegment = {
    ...host,
    route: pieces.first,
    to: { type: 'inline', itemId: inline.id, node: 0 },
    passthrough: withGroup(host, key),
  };
  const inherited: Omit<PidSegment, 'sourceId'> = { ...host };
  delete (inherited as { sourceId?: string }).sourceId;
  const second: PidSegment = {
    ...inherited,
    id: newId,
    route: pieces.second,
    from: { type: 'inline', itemId: inline.id, node: 1 },
    passthrough: withGroup(host, key),
    at: pieces.second[0] ?? host.at,
  };
  draft.put(inline);
  draft.put(first);
  draft.put(second);
  const at = line.segmentIds.indexOf(host.id);
  draft.put({ ...line, segmentIds: [...line.segmentIds.slice(0, at + 1), newId, ...line.segmentIds.slice(at + 1)] });
  movedBranches(draft, host, pieces.first, second);
}

/** Merges the two segments around a removed inline item: `incoming` keeps its id, `outgoing` disappears. Returns the id of the removed segment. */
export function healSegments(draft: Draft, incoming: PidSegment, outgoing: PidSegment, inline: PidInline): string {
  const merged: PidSegment = { ...incoming, route: healRoutes(incoming.route, outgoing.route, inline.ports), to: outgoing.to };
  draft.put(merged);
  movedBranches(draft, outgoing, undefined, merged);
  const line = draft.get(incoming.lineId);
  if (line?.kind === 'line') draft.put({ ...line, segmentIds: line.segmentIds.filter((id) => id !== outgoing.id) });
  draft.drop(new Set([outgoing.id]));
  return outgoing.id;
}
