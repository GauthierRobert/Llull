/** `DocumentExtension` of `CadDocument.aero`: structural validation of airfoil, wing and body definitions on load. A definition whose entity was deleted stays as a stale record (commands refuse to use it), so doc and load(save(doc)) are equal. */

import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { isVec3 } from '@lib/vec3';
import type { AircraftFrame } from '@aero/surfacing/types';
import { frameViolation } from './aircraftFrame';

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function airfoilErrors(key: string, raw: unknown): string[] {
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
  return errors;
}

function wingErrors(key: string, raw: unknown, aero: Record<string, unknown>): string[] {
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
  return errors;
}

function bodyErrors(key: string, raw: unknown): string[] {
  const at = `aero.bodies.${key}`;
  if (!isRecord(raw)) return [`${at} must be an object`];
  const errors: string[] = [];
  if (raw['id'] !== key) errors.push(`${at}.id must equal its key`);
  const stations = raw['stations'];
  if (
    !Array.isArray(stations) ||
    stations.length < 2 ||
    !stations.every((s) => isRecord(s) && isNumber(s['fs']) && isRecord(s['section']) && isText(s['section']['type']))
  )
    errors.push(`${at}.stations needs at least 2 stations with fs and section.type`);
  if (!Array.isArray(raw['controlCurveIds']) || !raw['controlCurveIds'].every(isText))
    errors.push(`${at}.controlCurveIds must be a list of ids`);
  if (!isNumber(raw['degreeV'])) errors.push(`${at}.degreeV must be a number`);
  if (!isText(raw['entityId'])) errors.push(`${at}.entityId must be text`);
  errors.push(...frameErrors(raw['frame'], `${at}.frame`));
  return errors;
}

function frameErrors(raw: unknown, at = 'aero.frame'): string[] {
  if (raw === undefined) return [];
  const axes = ['datum', 'fsAxis', 'blAxis', 'wlAxis'] as const;
  if (!isRecord(raw) || !axes.every((axis) => isVec3(raw[axis]))) return [`${at} needs datum, fsAxis, blAxis and wlAxis as [x, y, z]`];
  const violation = frameViolation(raw as unknown as AircraftFrame);
  return violation === null ? [] : [`${at}: ${violation}`];
}

export const aeroDocument: DocumentExtension = {
  validate(raw) {
    const slice = raw['aero'];
    if (slice === undefined) return [];
    if (!isRecord(slice) || !isRecord(slice['airfoils']) || !isRecord(slice['wings'])) return ['aero must be { airfoils, wings }'];
    return [
      ...Object.entries(slice['airfoils']).flatMap(([key, value]) => airfoilErrors(key, value)),
      ...Object.entries(slice['wings']).flatMap(([key, value]) => wingErrors(key, value, slice)),
      ...frameErrors(slice['frame']),
      ...(slice['bodies'] === undefined
        ? []
        : isRecord(slice['bodies'])
          ? Object.entries(slice['bodies']).flatMap(([key, value]) => bodyErrors(key, value))
          : ['aero.bodies must be an object']),
    ];
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
};
