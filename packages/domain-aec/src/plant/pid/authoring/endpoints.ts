/** Line ends of add_pid_line (plant 04 PID §4.1): a nozzle, a point on another line (tee), an off-page connector or a free end. */

import { vec2, z } from '@core/commands/schema';
import type { Vec2 } from '@core/model/vectors';
import type { PidEndpoint, PidModel, PidOffPage } from '../model';
import { axisOf, nearestLeg, SNAP_DISTANCE, type Axis } from './geometry';
import { fail, findItem, findLine, isFail, segmentsOf, type Fail, mintFree } from './refs';

export const endpointParam = z.object({
  tag: z.string().min(1).optional().describe('Equipment tag (or id) when the end is a nozzle: use with `nozzle`.'),
  nozzle: z.string().min(1).optional().describe('Sub-tag of the nozzle on `tag` (e.g. "N1"). A nozzle takes one line.'),
  line: z.string().min(1).optional().describe('Line id / line number when the end is a tee on another line: use with `at`.'),
  at: vec2(
    'Sheet point [x, y] in mm: on the other line for `line` (snapped, within 5 mm), or the position of the off-page connector for `opc`.',
  ).optional(),
  opc: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Pair key of an off-page connector created at this end (e.g. "OPC-1"); it is placed at `at`, else at the last (first) `via` point.',
    ),
  targetSheet: z
    .string()
    .min(1)
    .optional()
    .describe('Sheet number the off-page connector leads to (e.g. "PID-002"); an unknown sheet stays unresolved.'),
  free: vec2('Open end at this sheet point [x, y], mm (a vent, drain or an unfinished line).').optional(),
});

export type EndpointParam = z.output<typeof endpointParam>;

export interface ResolvedEnd {
  readonly endpoint: PidEndpoint;
  readonly point: Vec2 | undefined;
  readonly axis: Axis | undefined;
  readonly opc?: PidOffPage;
}

/** True when the nozzle already has a segment. */
const occupied = (pid: PidModel, nozzleId: string): boolean =>
  pid.itemOrder.some((id) => {
    const item = pid.items[id];
    return (
      item?.kind === 'segment' &&
      ((item.from.type === 'nozzle' && item.from.itemId === nozzleId) || (item.to.type === 'nozzle' && item.to.itemId === nozzleId))
    );
  });

/**
 * Resolves one end. An off-page connector end has no point yet when neither `at` nor a via point is known (`point` undefined): the caller places it once the
 * other end is known with `placeOpc`.
 */
export function resolveEnd(pid: PidModel, end: EndpointParam, role: 'from' | 'to', sheetId: string, path: string): ResolvedEnd | Fail {
  const given = [end.nozzle !== undefined || end.tag !== undefined, end.line !== undefined, end.opc !== undefined, end.free !== undefined];
  if (given.filter(Boolean).length !== 1)
    return fail('PID_LINE_ENDPOINT_INVALID', 'an end is exactly one of {tag, nozzle}, {line, at}, {opc}, {free}', [path]);
  if (end.free !== undefined) return { endpoint: { type: 'free', at: end.free }, point: end.free, axis: undefined };
  if (end.opc !== undefined) {
    const direction = role === 'to' ? 'out' : 'in';
    const opc: PidOffPage = {
      id: mintFree(pid),
      kind: 'opc',
      sheetId,
      at: end.at ?? [0, 0],
      rotationDeg: 0,
      dexpiClass: direction === 'out' ? 'FlowOutPipeOffPageConnector' : 'FlowInPipeOffPageConnector',
      attributes: {},
      direction,
      pairKey: end.opc,
    };
    return { endpoint: { type: 'opc', itemId: opc.id }, point: end.at, axis: undefined, opc };
  }
  if (end.line !== undefined) {
    if (end.at === undefined) return fail('PID_LINE_ENDPOINT_INVALID', 'a tee end {line, at} needs `at`', [`${path}.at`]);
    const line = findLine(pid, end.line, `${path}.line`);
    if (isFail(line)) return line;
    let best: { segmentId: string; hit: NonNullable<ReturnType<typeof nearestLeg>> } | undefined;
    for (const segment of segmentsOf(pid, line)) {
      const hit = nearestLeg(segment.route, end.at);
      if (hit !== undefined && (best === undefined || hit.distance < best.hit.distance)) best = { segmentId: segment.id, hit };
    }
    if (best === undefined || best.hit.distance > SNAP_DISTANCE)
      return fail(
        'PID_POINT_OFF_LINE',
        `[${end.at.join(', ')}] is ${best ? best.hit.distance.toFixed(1) : 'far'} mm from line ${end.line} (limit ${SNAP_DISTANCE} mm)`,
        [`${path}.at`],
      );
    const perpendicular: Axis = Math.abs(best.hit.direction[0]) > Math.abs(best.hit.direction[1]) ? 'v' : 'h';
    return { endpoint: { type: 'branch', segmentId: best.segmentId, at: best.hit.snapped }, point: best.hit.snapped, axis: perpendicular };
  }
  if (end.tag === undefined || end.nozzle === undefined)
    return fail('PID_LINE_ENDPOINT_INVALID', 'a nozzle end needs both `tag` and `nozzle`', [path]);
  const equipment = findItem(pid, end.tag, `${path}.tag`);
  if (isFail(equipment)) return equipment;
  if (equipment.kind !== 'equipment')
    return fail('PID_LINE_ENDPOINT_INVALID', `${end.tag} is a ${equipment.kind}, not an equipment`, [`${path}.tag`]);
  const nozzle = pid.itemOrder
    .map((id) => pid.items[id])
    .find((item) => item?.kind === 'nozzle' && item.equipmentId === equipment.id && item.subTag === end.nozzle);
  if (nozzle?.kind !== 'nozzle') return fail('PID_ITEM_NOT_FOUND', `${end.tag} has no nozzle "${end.nozzle}"`, [`${path}.nozzle`]);
  if (nozzle.sheetId !== sheetId)
    return fail('PID_LINE_ENDPOINT_INVALID', `${end.tag}/${end.nozzle} is on another sheet than the line`, [path]);
  if (occupied(pid, nozzle.id)) return fail('PID_NOZZLE_OCCUPIED', `${end.tag}/${end.nozzle} already has a line`, [path], [nozzle.id]);
  return { endpoint: { type: 'nozzle', itemId: nozzle.id }, point: nozzle.port, axis: axisOf(equipment.at, nozzle.port) };
}
