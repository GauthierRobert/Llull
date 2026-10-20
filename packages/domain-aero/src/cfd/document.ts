/** `DocumentExtension` for `CadDocument.cfd`: cases and result summaries are validated on load; no geometry is derived. */

import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { isVec3 } from '@lib/vec3';

const REGIMES: readonly unknown[] = ['auto', 'low_speed', 'compressible'];
const RULES: readonly unknown[] = ['external_aero', 'buildings', 'custom'];
const QUALITIES: readonly unknown[] = ['draft', 'standard', 'fine'];
const SOLVERS: readonly unknown[] = ['lbm', 'euler'];
const KINDS: readonly unknown[] = ['wall', 'inlet', 'outlet', 'symmetry', 'ground'];

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTextList = (value: unknown): boolean => Array.isArray(value) && value.every(isText);

function caseErrors(key: string, raw: unknown): string[] {
  const at = `cfd.cases.${key}`;
  if (!isRecord(raw)) return [`${at} must be an object`];
  const errors: string[] = [];
  const need = (ok: boolean, what: string): void => {
    if (!ok) errors.push(`${at}.${what}`);
  };
  need(raw['id'] === key, 'id must equal its key');
  need(isTextList(raw['entityIds']) && isTextList(raw['excludedEntityIds']), 'entityIds / excludedEntityIds must be lists of ids');
  need(REGIMES.includes(raw['regime']), 'regime must be auto, low_speed or compressible');
  const freestream = raw['freestream'];
  need(
    isRecord(freestream) && isFiniteNumber(freestream['alphaDeg']) && isFiniteNumber(freestream['betaDeg']),
    'freestream needs numeric alphaDeg and betaDeg',
  );
  need(isVec3(raw['flowAxis']) && isVec3(raw['upAxis']), 'flowAxis / upAxis must be [x, y, z]');
  const reference = raw['reference'];
  need(
    isRecord(reference) && isFiniteNumber(reference['areaM2']) && isFiniteNumber(reference['lengthM']) && isVec3(reference['momentPointM']),
    'reference needs areaM2, lengthM and momentPointM',
  );
  const domain = raw['domain'];
  need(isRecord(domain) && RULES.includes(domain['rule']), 'domain.rule must be external_aero, buildings or custom');
  const ground = raw['ground'];
  need(
    isRecord(ground) && typeof ground['enabled'] === 'boolean' && typeof ground['moving'] === 'boolean',
    'ground needs enabled and moving',
  );
  const boundaries = raw['boundaries'];
  need(
    Array.isArray(boundaries) && boundaries.every((tag) => isRecord(tag) && KINDS.includes(tag['kind']) && isText(tag['entityId'])),
    'boundaries must be a list of { kind, entityId }',
  );
  need(QUALITIES.includes(raw['quality']), 'quality must be draft, standard or fine');
  need(raw['solver'] === undefined || SOLVERS.includes(raw['solver']), 'solver must be lbm or euler');
  const outputs = raw['outputs'];
  need(
    isRecord(outputs) && isTextList(outputs['surfaceFields']) && Array.isArray(outputs['slices']) && Array.isArray(outputs['probes']),
    'outputs needs surfaceFields, slices and probes',
  );
  return errors;
}

function resultErrors(key: string, raw: unknown): string[] {
  const at = `cfd.results.${key}`;
  if (!isRecord(raw)) return [`${at} must be an object`];
  const ok =
    raw['caseId'] === key &&
    isText(raw['resultsHash']) &&
    isText(raw['caseHash']) &&
    isText(raw['geometryHash']) &&
    SOLVERS.includes(raw['solver']);
  return ok ? [] : [`${at} needs caseId equal to its key, resultsHash, caseHash, geometryHash and a solver`];
}

export const cfdDocument: DocumentExtension = {
  validate(raw) {
    const slice = raw['cfd'];
    if (slice === undefined) return [];
    if (!isRecord(slice) || !isRecord(slice['cases']) || !isRecord(slice['results'])) return ['cfd must be { cases, results }'];
    return [
      ...Object.entries(slice['cases']).flatMap(([key, entry]) => caseErrors(key, entry)),
      ...Object.entries(slice['results']).flatMap(([key, entry]) => resultErrors(key, entry)),
    ];
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
};
