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

const isRef = (ref: unknown, branchAllowed: boolean): boolean =>
  isRecord(ref) &&
  ((ref['kind'] === 'tieIn' && typeof ref['id'] === 'string') ||
    (ref['kind'] === 'nozzle' && typeof ref['equipmentId'] === 'string' && typeof ref['nozzleId'] === 'string') ||
    (ref['kind'] === 'runEnd' && typeof ref['runId'] === 'string' && (ref['end'] === 'start' || ref['end'] === 'end')) ||
    (branchAllowed && ref['kind'] === 'branch' && typeof ref['runId'] === 'string' && typeof ref['branchId'] === 'string'));

/** A run end; only the start of a branch run may reference a branch point. */
const endErrors = (path: string, end: unknown, branchAllowed: boolean): string[] => {
  if (!isRecord(end) || !isVec3(end['point']) || (end['direction'] !== undefined && !isVec3(end['direction'])))
    return [`${path} needs a finite point`];
  return end['ref'] === undefined || isRef(end['ref'], branchAllowed)
    ? []
    : [`${path}.ref must be a tieIn, nozzle, runEnd${branchAllowed ? ' or branch' : ''} reference`];
};

const entityIdErrors = (raw: Record<string, unknown>): string[] => {
  const ids = raw['entityIds'];
  const runs = isRecord(raw['runs']) ? raw['runs'] : {};
  if (!isRecord(ids)) return ['plant.piping.entityIds must be an object'];
  return Object.entries(ids).flatMap(([runId, list]) =>
    runId in runs && Array.isArray(list) && list.every((id) => typeof id === 'string')
      ? []
      : [`plant.piping.entityIds.${runId} must list entity ids of a run`],
  );
};

const isPositive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Errors of the M2 members of a run: its own size, the inline components and the branch points. */
function runSizeErrors(id: string, run: Record<string, unknown>, runs: Record<string, unknown>): string[] {
  const path = `plant.piping.runs.${id}`;
  const errors: string[] = [];
  if (run['dn'] !== undefined && !isPositive(run['dn'])) errors.push(`${path}.dn must be a positive size`);
  const inline = run['inline'];
  if (inline !== undefined && !Array.isArray(inline)) errors.push(`${path}.inline must be a list`);
  else
    (inline ?? []).forEach((item: unknown, index: number) => {
      const ok =
        isRecord(item) &&
        typeof item['id'] === 'string' &&
        typeof item['type'] === 'string' &&
        Number.isInteger(item['leg']) &&
        isPositive(item['centreDistance']) &&
        (item['dn2'] === undefined || isPositive(item['dn2'])) &&
        (item['stemDirection'] === undefined || isVec3(item['stemDirection']));
      if (!ok) errors.push(`${path}.inline.${index} needs an id, a type, an integer leg and a positive centreDistance`);
    });
  const branches = run['branches'];
  if (branches !== undefined && !Array.isArray(branches)) errors.push(`${path}.branches must be a list`);
  else
    (branches ?? []).forEach((item: unknown, index: number) => {
      const ok =
        isRecord(item) &&
        typeof item['id'] === 'string' &&
        Number.isInteger(item['leg']) &&
        isPositive(item['distance']) &&
        typeof item['branchRunId'] === 'string' &&
        item['branchRunId'] in runs;
      if (!ok) errors.push(`${path}.branches.${index} needs an id, an integer leg, a positive distance and the id of a run`);
    });
  return errors;
}

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
      ...endErrors(`plant.piping.runs.${id}.start`, run['start'], true),
      ...endErrors(`plant.piping.runs.${id}.end`, run['end'], false),
      ...runSizeErrors(id, run, isRecord(raw['runs']) ? raw['runs'] : {}),
      ...(run['broken'] === undefined ||
      (isRecord(run['broken']) && typeof run['broken']['code'] === 'string' && typeof run['broken']['reason'] === 'string')
        ? []
        : [`plant.piping.runs.${id}.broken must be { code, reason }`]),
      ...(Array.isArray(run['pis']) && run['pis'].every(isVec3) ? [] : [`plant.piping.runs.${id}.pis must be [x, y, z] points`]),
    ]),
    ...entityIdErrors(raw),
  ];
}
