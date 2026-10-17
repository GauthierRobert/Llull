/** Load-time validation of material records and of `CadDocument.materialLibraries` (08 MAT TR-MAT-14 / 31). */

import { isRecord } from '../../lib/isRecord';
import { isReservedKey } from '../../lib/reservedKey';
import { LICENCE_FLAGS } from '../../model/materialLibrary';

const REGIMES = ['none', 'EAR99', 'EAR', 'ITAR'] as const;
const REASONS = ['provider missing', 'library missing', 'hash mismatch'] as const;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const oneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

function markingProblem(marking: unknown): string | null {
  if (!isRecord(marking) || !oneOf(REGIMES, marking['regime'])) return `exportMarking.regime must be one of ${REGIMES.join(', ')}`;
  if (marking['regime'] === 'EAR' && !isText(marking['eccn'])) return 'exportMarking regime EAR needs an eccn';
  return null;
}

function refProblem(ref: unknown): string | null {
  return isRecord(ref) && isText(ref['libraryId']) && isText(ref['version']) && isText(ref['sha256'])
    ? null
    : 'libraryRef must be { libraryId, version, sha256 }';
}

/** First problem of a saved `Material.record`, or null. */
export function recordProblem(name: string, record: unknown): string | null {
  const at = `material '${name}': record`;
  if (!isRecord(record)) return `${at} must be an object`;
  if (record['id'] !== name) return `${at}.id must equal the material name`;
  if (typeof record['designation'] !== 'string') return `${at}.designation must be a string`;
  const specs = record['specs'];
  if (!Array.isArray(specs) || !specs.every((spec: unknown) => isRecord(spec) && isText(spec['body']) && isText(spec['id'])))
    return `${at}.specs must be [{ body, id }]`;
  if (!oneOf(LICENCE_FLAGS, record['licence'])) return `${at}.licence must be one of ${LICENCE_FLAGS.join(', ')}`;
  const marking = markingProblem(record['exportMarking']);
  if (marking !== null) return `${at}.${marking}`;
  const superseded = record['superseded'];
  if (superseded !== undefined && !(isRecord(superseded) && typeof superseded['by'] === 'string' && typeof superseded['note'] === 'string'))
    return `${at}.superseded must be { by, note }`;
  const ref = record['libraryRef'];
  if (ref !== undefined && refProblem(ref) !== null) return `${at}.${refProblem(ref)}`;
  const unresolved = record['unresolved'];
  if (unresolved !== undefined && !(ref !== undefined && isRecord(unresolved) && oneOf(REASONS, unresolved['reason'])))
    return `${at}.unresolved needs a libraryRef and a reason (${REASONS.join(', ')})`;
  return null;
}

/** Problems of the library entries and of the records that pin them. */
export function materialLibraryProblems(libraries: unknown, materials: unknown): string[] {
  if (libraries !== undefined && !isRecord(libraries)) return ['materialLibraries must be an object'];
  const entries = libraries === undefined ? {} : libraries;
  const errors: string[] = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (isReservedKey(id)) errors.push(`materialLibraries: id '${id}' is a reserved JavaScript property name`);
    const at = `materialLibraries['${id}']`;
    if (!isRecord(entry) || entry['libraryId'] !== id) errors.push(`${at}.libraryId must equal its key`);
    else if (!isText(entry['version']) || !isText(entry['sha256']) || typeof entry['title'] !== 'string')
      errors.push(`${at} needs version, sha256 and title`);
    else if (!oneOf(['embedded', 'private'], entry['storage']) || !oneOf(LICENCE_FLAGS, entry['licence']))
      errors.push(`${at}: storage is embedded | private and licence one of ${LICENCE_FLAGS.join(', ')}`);
    else {
      const marking = markingProblem(entry['exportMarking']);
      if (marking !== null) errors.push(`${at}.${marking}`);
    }
  }
  if (!isRecord(materials)) return errors;
  for (const [name, material] of Object.entries(materials)) {
    const ref = isRecord(material) && isRecord(material['record']) ? material['record']['libraryRef'] : undefined;
    if (!isRecord(ref)) continue;
    const entry = entries[String(ref['libraryId'])];
    if (!isRecord(entry) || entry['version'] !== ref['version'] || entry['sha256'] !== ref['sha256'])
      errors.push(`material '${name}': libraryRef does not match a declared library in materialLibraries`);
    else if (entry['storage'] === 'private' && isRecord(material) && material['propertyModels'] !== undefined)
      errors.push(`material '${name}': values of private library '${String(ref['libraryId'])}' must not be stored in a document`);
  }
  return errors;
}
