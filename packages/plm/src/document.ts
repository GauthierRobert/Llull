/** The plugin's document slice: validation of `plm` on load, replay carry (TR-PLM-32) and the load-time integrity check (TR-PLM-33). */

import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { integrityWarnings } from './integrity';
import { LIFECYCLE_STATES, isLegalTransition } from './transitions';
import { REVISION_LABEL } from './schemes';
import { isSealed } from './records';
import { membersHash } from './structure';

export const PART_NUMBER = /^[A-Z0-9][A-Z0-9._\-/]{0,63}$/i;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function revisionErrors(at: string, raw: unknown): string[] {
  if (!isRecord(raw)) return [`${at} must be an object`];
  const errors: string[] = [];
  if (typeof raw['label'] !== 'string' || !REVISION_LABEL.test(raw['label']))
    errors.push(`${at}.label must be 1-16 characters of A-Z, 0-9 and -`);
  if (!LIFECYCLE_STATES.includes(raw['state'] as never)) errors.push(`${at}.state is not a lifecycle state`);
  for (const key of ['iterations', 'effectivity', 'approvals', 'signatures', 'stateHistory'])
    if (!Array.isArray(raw[key])) errors.push(`${at}.${key} must be a list`);
  const history = raw['stateHistory'];
  if (Array.isArray(history) && history.length > 0) {
    let previous: unknown = null;
    for (const [index, entry] of history.entries()) {
      if (!isRecord(entry) || entry['from'] !== previous || !LIFECYCLE_STATES.includes(entry['to'] as never)) {
        errors.push(`${at}.stateHistory[${index}] does not continue the history`);
        break;
      }
      if (!isLegalTransition(entry['from'] as never, entry['to'] as never)) {
        errors.push(
          `${at}.stateHistory[${index}] is a transition the lifecycle does not allow (${String(entry['from'])} to ${String(entry['to'])})`,
        );
        break;
      }
      previous = entry['to'];
    }
    if (previous !== raw['state']) errors.push(`${at}.state does not match the end of its stateHistory`);
  }
  if (['released', 'superseded', 'obsolete'].includes(String(raw['state'])) && (!isText(raw['contentHash']) || !isRecord(raw['snapshot'])))
    errors.push(`${at} is ${String(raw['state'])} and needs a contentHash and a snapshot`);
  const snapshot = raw['snapshot'];
  if (isRecord(snapshot) && snapshot['kind'] === 'vault' && snapshot['objectSha256'] !== raw['contentHash'])
    errors.push(`${at}.snapshot is a vault reference whose object is not the content hash`);
  return errors;
}

function itemErrors(raw: unknown): string[] {
  if (!isRecord(raw)) return ['plm.item must be an object'];
  const errors: string[] = [];
  if (typeof raw['partNumber'] !== 'string' || !PART_NUMBER.test(raw['partNumber']))
    errors.push('plm.item.partNumber is not a valid part number');
  if (!isText(raw['name'])) errors.push('plm.item.name must be a non-empty string');
  if (!isText(raw['revisionScheme'])) errors.push('plm.item.revisionScheme must be a string');
  const revisions = raw['revisions'];
  const order = raw['revisionOrder'];
  if (!isRecord(revisions) || !Array.isArray(order)) return [...errors, 'plm.item needs revisions and revisionOrder'];
  if (
    order.length === 0 ||
    order.some((label) => typeof label !== 'string' || !Object.hasOwn(revisions, label)) ||
    order.length !== Object.keys(revisions).length
  )
    errors.push('plm.item.revisionOrder must list every revision label once');
  if (typeof raw['currentRevision'] !== 'string' || !Object.hasOwn(revisions, raw['currentRevision']))
    errors.push('plm.item.currentRevision is not a revision');
  for (const [label, revision] of Object.entries(revisions)) {
    if (!REVISION_LABEL.test(label)) errors.push(`plm.item.revisions key '${label}' must be 1-16 characters of A-Z, 0-9 and -`);
    errors.push(...revisionErrors(`plm.item.revisions.${label}`, revision));
  }
  if (!isRecord(raw['marking']) || !isText(raw['marking']['regime'])) errors.push('plm.item.marking.regime must be a string');
  return errors;
}

/** Baselines are never edited: each member list must still hash to the recorded hash. */
function baselineErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ['plm.baselines must be an object'];
  return Object.entries(raw).flatMap(([id, baseline]) =>
    isRecord(baseline) && Array.isArray(baseline['members']) && baseline['hash'] === membersHash(baseline['members'] as never)
      ? []
      : [`plm.baselines.${id} does not hash to its recorded hash (edited by hand?)`],
  );
}

/** As-built records and manufacturing BOMs are never edited: each must still hash to its seal, under the key it is stored by. */
function sealedErrors(slice: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, field] of [
    ['asBuilt', 'serial'],
    ['mbom', 'id'],
  ] as const) {
    const raw = slice[key];
    if (raw === undefined) continue;
    if (!isRecord(raw)) {
      errors.push(`plm.${key} must be an object`);
      continue;
    }
    for (const [name, record] of Object.entries(raw))
      if (!isRecord(record) || record[field] !== name || !isSealed(record))
        errors.push(`plm.${key}.${name} does not hash to its seal (edited by hand?)`);
  }
  const results = slice['faiResults'];
  if (results !== undefined && !isRecord(results)) errors.push('plm.faiResults must be an object');
  return errors;
}

/** `DocumentExtension` for `CadDocument.plm`: structural validation, carried across replay, integrity warnings on load. */
export const plmDocument: DocumentExtension = {
  validate(raw) {
    const slice = raw['plm'];
    if (slice === undefined) return [];
    if (!isRecord(slice) || slice['schema'] !== 1) return ['plm must be an object with schema 1'];
    const errors = itemErrors(slice['item']);
    if (!isRecord(slice['changes']) || !Array.isArray(slice['changeOrder']) || !isRecord(slice['policy']))
      errors.push('plm needs changes, changeOrder and policy');
    errors.push(...baselineErrors(slice['baselines']), ...sealedErrors(slice));
    return errors;
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
  carry: (prev, next) => (prev.plm === undefined ? next : { ...next, plm: prev.plm }),
  afterLoad: integrityWarnings,
};
