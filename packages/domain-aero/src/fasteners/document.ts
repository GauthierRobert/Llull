/** The plugin's document slice: validation of `fasteners` on load, and the guard that keeps stack instances plugin-owned. */

import type { DerivationGuard } from '@core/commands/derivation';
import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { checkFamily } from './catalogFile';
import { fastenerModel } from './fastenerDoc';
import type { FastenerStack } from '@core/model/fasteners';

const HOLE_MODES: readonly unknown[] = ['cut_close_tolerance', 'cut_clearance', 'none'];

const isVec3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function stackErrors(key: string, raw: unknown, entities: Record<string, unknown> | null): string[] {
  const at = `fasteners.stacks.${key}`;
  if (!isRecord(raw)) return [`${at} must be an object`];
  const errors: string[] = [];
  if (raw['id'] !== key) errors.push(`${at}.id must equal its key`);
  const axis = raw['axis'];
  if (!isRecord(axis) || !isVec3(axis['origin']) || !isVec3(axis['direction']))
    errors.push(`${at}.axis needs origin and direction [x, y, z]`);
  const layers = raw['layers'];
  if (
    !Array.isArray(layers) ||
    layers.length === 0 ||
    !layers.every((layer) => isRecord(layer) && isText(layer['entityId']) && isCount(layer['thickness']))
  )
    errors.push(`${at}.layers must be a non-empty list of { entityId, thickness >= 0 }`);
  const fastener = raw['fastener'];
  if (
    !isRecord(fastener) ||
    !isText(fastener['family']) ||
    !isText(fastener['partNumber']) ||
    !isText(fastener['instanceId']) ||
    !isText(fastener['diameterDash'])
  )
    errors.push(`${at}.fastener needs family, partNumber, instanceId and diameterDash`);
  const washers = raw['washers'];
  if (
    !Array.isArray(washers) ||
    !washers.every(
      (washer) =>
        isRecord(washer) &&
        isText(washer['partNumber']) &&
        isText(washer['instanceId']) &&
        (washer['side'] === 'head' || washer['side'] === 'nut'),
    )
  )
    errors.push(`${at}.washers must be a list of { partNumber, instanceId, side }`);
  const nut = raw['nut'];
  if (nut !== undefined && (!isRecord(nut) || !isText(nut['partNumber']) || !isText(nut['instanceId'])))
    errors.push(`${at}.nut needs partNumber and instanceId`);
  if (!isCount(raw['stackThickness'])) errors.push(`${at}.stackThickness must be a number >= 0`);
  if (!HOLE_MODES.includes(raw['holeMode'])) errors.push(`${at}.holeMode must be cut_close_tolerance, cut_clearance or none`);
  if (!isCount(raw['holeDiameter'])) errors.push(`${at}.holeDiameter must be a number >= 0`);
  if (errors.length === 0 && entities !== null) {
    const ids = [
      fastener ? (fastener as Record<string, unknown>)['instanceId'] : '',
      ...(washers as Array<Record<string, unknown>>).map((washer) => washer['instanceId']),
      ...(isRecord(nut) ? [nut['instanceId']] : []),
    ];
    for (const id of ids)
      if (typeof id === 'string' && !Object.hasOwn(entities, id)) errors.push(`${at} references missing instance '${id}'`);
  }
  return errors;
}

/** `DocumentExtension` for `CadDocument.fasteners`: catalogues and stacks are validated; instances are ordinary saved entities. */
export const fastenersDocument: DocumentExtension = {
  validate(raw) {
    const slice = raw['fasteners'];
    if (slice === undefined) return [];
    if (!isRecord(slice) || !isRecord(slice['catalogs']) || !isRecord(slice['stacks'])) return ['fasteners must be { catalogs, stacks }'];
    const errors: string[] = [];
    for (const [key, family] of Object.entries(slice['catalogs'])) {
      const checked = checkFamily(family, `fasteners.catalogs.${key}`);
      if ('issues' in checked) errors.push(...checked.issues.map((issue) => `${issue.code}: ${issue.message}`));
      else if (checked.family.id !== key) errors.push(`fasteners.catalogs.${key}.id must equal its key`);
    }
    const entities = isRecord(raw['entities']) ? raw['entities'] : null;
    for (const [key, stack] of Object.entries(slice['stacks'])) errors.push(...stackErrors(key, stack, entities));
    return errors;
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
};

/** Fastener instances belong to their stack: deleting or exploding one directly is refused (use delete_fastener_stack). */
export const fastenerInstanceGuard: DerivationGuard = {
  domain: 'fasteners',
  check(previous, next) {
    const kept = fastenerModel(next).stacks;
    for (const stack of Object.values(fastenerModel(previous).stacks) as FastenerStack[]) {
      if (!Object.hasOwn(kept, stack.id)) continue;
      const ids = [
        stack.fastener.instanceId,
        ...stack.washers.map((washer) => washer.instanceId),
        ...(stack.nut ? [stack.nut.instanceId] : []),
      ];
      const lost = ids.find((id) => previous.entities[id] !== undefined && next.entities[id] === undefined);
      if (lost !== undefined) return `fastener instance '${lost}' belongs to stack '${stack.id}'; remove it with delete_fastener_stack`;
    }
    return null;
  },
};
