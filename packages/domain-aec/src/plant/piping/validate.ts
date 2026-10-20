/** Value errors of a raw `plant.piping` record (persistence refuses a file whose errors are non-empty). */

import { isRecord } from '@lib/isRecord';

const isVec3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));

/** Errors of a `Record<id, T>` + order list pair whose rows must carry their own id. */
function tableErrors(
  raw: Record<string, unknown>,
  table: string,
  orderKey: string,
  row: (id: string, value: Record<string, unknown>) => string[],
): string[] {
  const rows = raw[table];
  const order = raw[orderKey];
  if (!isRecord(rows)) return [`plant.piping.${table} must be an object`];
  if (!Array.isArray(order) || !order.every((id) => typeof id === 'string' && id in rows))
    return [`plant.piping.${orderKey} must list the ids of plant.piping.${table}`];
  if (order.length !== Object.keys(rows).length) return [`plant.piping.${orderKey} must list every id of plant.piping.${table} once`];
  return Object.entries(rows).flatMap(([id, value]) =>
    isRecord(value) && value['id'] === id ? row(id, value) : [`plant.piping.${table}.${id} must be an object with id "${id}"`],
  );
}

const endErrors = (path: string, end: unknown): string[] =>
  isRecord(end) && isVec3(end['point']) && (end['direction'] === undefined || isVec3(end['direction']))
    ? []
    : [`${path} needs a finite point`];

export function pipingErrors(raw: unknown): string[] {
  if (!isRecord(raw)) return ['plant.piping must be an object'];
  const lines = isRecord(raw['lines']) ? raw['lines'] : {};
  return [
    ...tableErrors(raw, 'tieIns', 'tieInOrder', (id, tieIn) => {
      const port = tieIn['port'];
      return typeof tieIn['tag'] === 'string' &&
        isRecord(port) &&
        isVec3(port['position']) &&
        isVec3(port['direction']) &&
        typeof port['dn'] === 'number'
        ? []
        : [`plant.piping.tieIns.${id} needs a tag and a port with position, direction and dn`];
    }),
    ...tableErrors(raw, 'lines', 'lineOrder', (id, line) =>
      typeof line['lineNumber'] === 'string' && typeof line['spec'] === 'string' && typeof line['dn'] === 'number' && line['dn'] > 0
        ? []
        : [`plant.piping.lines.${id} needs a lineNumber, a spec and a positive dn`],
    ),
    ...tableErrors(raw, 'runs', 'runOrder', (id, run) => [
      ...(typeof run['lineId'] === 'string' && run['lineId'] in lines ? [] : [`plant.piping.runs.${id}.lineId must name a line`]),
      ...endErrors(`plant.piping.runs.${id}.start`, run['start']),
      ...endErrors(`plant.piping.runs.${id}.end`, run['end']),
      ...(Array.isArray(run['pis']) && run['pis'].every(isVec3) ? [] : [`plant.piping.runs.${id}.pis must be [x, y, z] points`]),
    ]),
  ];
}
