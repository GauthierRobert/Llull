/** `DocumentExtension` of `CadDocument.aero`: validation of the airfoil and wing definitions on load. Their entities are ordinary saved entities. */

import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { isVec3 } from '@lib/vec3';

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function airfoilErrors(key: string, raw: unknown, entities: Record<string, unknown> | null): string[] {
  const at = `aero.airfoils.${key}`;
  if (!isRecord(raw)) return [`${at} must be an object`];
  const errors: string[] = [];
  if (raw['id'] !== key) errors.push(`${at}.id must equal its key`);
  const source = raw['source'];
  if (!isRecord(source) || !['naca4', 'naca5', 'points'].includes(source['type'] as string))
    errors.push(`${at}.source.type must be naca4, naca5 or points`);
  else if (source['type'] === 'points') {
    const points = source['points'];
    if (!Array.isArray(points) || points.length < 5 || !points.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNumber)))
      errors.push(`${at}.source.points must be at least 5 [x, y] pairs`);
    if (!isText(source['sha256'])) errors.push(`${at}.source.sha256 must be text`);
  } else if (!isText(source['designation']) || !isNumber(source['pointsPerSide']))
    errors.push(`${at}.source needs designation and pointsPerSide`);
  if (raw['normalize'] !== 'none' && raw['normalize'] !== 'chord') errors.push(`${at}.normalize must be none or chord`);
  const provenance = raw['provenance'];
  if (!isRecord(provenance) || typeof provenance['verified'] !== 'boolean' || !isText(provenance['source']))
    errors.push(`${at}.provenance needs verified (boolean) and source (text)`);
  if (!isText(raw['entityId'])) errors.push(`${at}.entityId must be text`);
  else if (entities !== null && !Object.hasOwn(entities, raw['entityId']))
    errors.push(`${at} references missing curve '${raw['entityId']}'`);
  return errors;
}

function wingErrors(key: string, raw: unknown, aero: Record<string, unknown>, entities: Record<string, unknown> | null): string[] {
  const at = `aero.wings.${key}`;
  if (!isRecord(raw)) return [`${at} must be an object`];
  const errors: string[] = [];
  if (raw['id'] !== key) errors.push(`${at}.id must equal its key`);
  if (!isVec3(raw['origin'])) errors.push(`${at}.origin must be [x, y, z]`);
  const airfoils = isRecord(aero['airfoils']) ? aero['airfoils'] : {};
  const sections = raw['sections'];
  if (!Array.isArray(sections) || sections.length < 2) errors.push(`${at}.sections needs at least 2 sections`);
  else
    sections.forEach((section, index) => {
      if (
        !isRecord(section) ||
        !isNumber(section['span']) ||
        !isNumber(section['chord']) ||
        !(section['chord'] > 0) ||
        !isNumber(section['twistDeg'])
      )
        errors.push(`${at}.sections.${index} needs span, chord > 0 and twistDeg`);
      else if (!isText(section['airfoilId']) || !Object.hasOwn(airfoils, section['airfoilId']))
        errors.push(`${at}.sections.${index} references missing airfoil '${String(section['airfoilId'])}'`);
    });
  const segments = raw['segments'];
  if (!Array.isArray(segments) || (Array.isArray(sections) && segments.length !== sections.length - 1))
    errors.push(`${at}.segments needs one entry per span interval`);
  else if (!segments.every((s) => isRecord(s) && isNumber(s['sweepDeg']) && isNumber(s['sweepLocation']) && isNumber(s['dihedralDeg'])))
    errors.push(`${at}.segments entries need sweepDeg, sweepLocation and dihedralDeg`);
  if (!isNumber(raw['twistLocation'])) errors.push(`${at}.twistLocation must be a number`);
  if (raw['loft'] !== 'linear' && raw['loft'] !== 'smooth') errors.push(`${at}.loft must be linear or smooth`);
  if (typeof raw['mirror'] !== 'boolean') errors.push(`${at}.mirror must be a boolean`);
  const ids = raw['entityIds'];
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isText)) errors.push(`${at}.entityIds must list the loft entity ids`);
  else if (entities !== null)
    for (const id of ids) if (!Object.hasOwn(entities, id)) errors.push(`${at} references missing entity '${id}'`);
  return errors;
}

/** Drops definitions whose entities were deleted (airfoil curve, wing lofts) so a saved file always reopens; malformed data is left for `validate`. */
function pruneDanglingAero(raw: Record<string, unknown>): Record<string, unknown> {
  const slice = raw['aero'];
  if (!isRecord(slice) || !isRecord(slice['airfoils']) || !isRecord(slice['wings']) || !isRecord(raw['entities'])) return raw;
  const entities = raw['entities'];
  const airfoils = Object.fromEntries(
    Object.entries(slice['airfoils']).filter(([, a]) => !isRecord(a) || !isText(a['entityId']) || Object.hasOwn(entities, a['entityId'])),
  );
  const wings: Record<string, unknown> = {};
  for (const [key, wing] of Object.entries(slice['wings'])) {
    if (!isRecord(wing) || !Array.isArray(wing['entityIds']) || !Array.isArray(wing['sections'])) {
      wings[key] = wing;
      continue;
    }
    const entityIds = wing['entityIds'].filter((id) => !isText(id) || Object.hasOwn(entities, id));
    const sectionsOk = wing['sections'].every((s) => !isRecord(s) || !isText(s['airfoilId']) || Object.hasOwn(airfoils, s['airfoilId']));
    if (entityIds.length > 0 && sectionsOk) wings[key] = entityIds.length === wing['entityIds'].length ? wing : { ...wing, entityIds };
  }
  return { ...raw, aero: { ...slice, airfoils, wings } };
}

export const aeroDocument: DocumentExtension = {
  validate(raw) {
    const slice = raw['aero'];
    if (slice === undefined) return [];
    if (!isRecord(slice) || !isRecord(slice['airfoils']) || !isRecord(slice['wings'])) return ['aero must be { airfoils, wings }'];
    const entities = isRecord(raw['entities']) ? raw['entities'] : null;
    return [
      ...Object.entries(slice['airfoils']).flatMap(([key, value]) => airfoilErrors(key, value, entities)),
      ...Object.entries(slice['wings']).flatMap(([key, value]) => wingErrors(key, value, slice, entities)),
    ];
  },
  derivedEntityIds: () => new Set(),
  restore: pruneDanglingAero,
};
