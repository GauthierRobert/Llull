/** Load-time validation of the optional `display` field (colour profiles; plant 09 VIS). Unknown keys are ignored. */

import { profileProblems } from '../../geometry/colourRules';
import type { ColourProfile } from '../../model/display';
import { isRecord } from '../../lib/isRecord';
import { isReservedKey } from '../../lib/reservedKey';

const isRule = (rule: unknown): boolean =>
  isRecord(rule) &&
  typeof rule['id'] === 'string' &&
  typeof rule['legend'] === 'string' &&
  isRecord(rule['when']) &&
  isRecord(rule['appearance']) &&
  typeof rule['appearance']['colour'] === 'string';

function profileProblem(id: string, value: unknown): string | null {
  const where = `display.colourProfiles['${id}']`;
  if (isReservedKey(id)) return `display.colourProfiles: id '${id}' is a reserved JavaScript property name`;
  if (!isRecord(value) || value['id'] !== id) return `${where} must be an object whose id is '${id}'`;
  if (typeof value['name'] !== 'string' || typeof value['palette'] !== 'string' || typeof value['reviewRequired'] !== 'boolean')
    return `${where}: name and palette must be strings and reviewRequired a boolean`;
  if (typeof value['defaultColour'] !== 'string') return `${where}: defaultColour must be a string`;
  const rules = value['rules'];
  if (!Array.isArray(rules) || !rules.every(isRule)) return `${where}: rules must be rules with id, legend, when and appearance.colour`;
  const problem = profileProblems(value as unknown as ColourProfile)[0];
  return problem === undefined ? null : `${where}: ${problem.path}: ${problem.message}`;
}

/** Problems of the optional `display` field of a raw document (absent is valid). */
export function displayProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || !isRecord(value['colourProfiles'])) return ['display must be { colourProfiles, activeProfileId? }'];
  const profiles = value['colourProfiles'];
  const active = value['activeProfileId'];
  const problems = [
    ...Object.entries(profiles).map(([id, profile]) => profileProblem(id, profile)),
    active === undefined || (typeof active === 'string' && Object.hasOwn(profiles, active))
      ? null
      : 'display.activeProfileId must name an existing profile',
  ];
  return problems.filter((problem): problem is string => problem !== null);
}
