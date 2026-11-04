/** Load-time validation of the optional `display` field (colour profiles, material classes; plant 09 VIS). Unknown keys are ignored. */

import { profileProblems } from '../../geometry/colourRules';
import type { ColourProfile } from '../../model/display';
import { isRecord } from '../../lib/isRecord';
import { isReservedKey } from '../../lib/reservedKey';

const isPropertyValue = (value: unknown): boolean => ['string', 'number', 'boolean'].includes(typeof value);

/** Structural shape of a RulePredicate (field types only; semantic checks are `profileProblems`). Depth-limited like the model. */
function isPredicateShape(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 5) return false;
  const { property, equals, matches, range } = value;
  const oneOf = value['in'];
  const alternatives = value['any'];
  return (
    (property === undefined || typeof property === 'string') &&
    (equals === undefined || isPropertyValue(equals)) &&
    (matches === undefined || typeof matches === 'string') &&
    (oneOf === undefined || (Array.isArray(oneOf) && oneOf.every(isPropertyValue))) &&
    (range === undefined || (Array.isArray(range) && range.length === 2 && range.every((n) => typeof n === 'number'))) &&
    (alternatives === undefined || (Array.isArray(alternatives) && alternatives.every((sub) => isPredicateShape(sub, depth + 1))))
  );
}

const isScheme = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['rowId'] === 'string' &&
    typeof value['category'] === 'string' &&
    isRecord(value['names']) &&
    Object.values(value['names']).every((name) => typeof name === 'string'));

const isMarker = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) && typeof value['letters'] === 'string' && (value['letterHex'] === undefined || typeof value['letterHex'] === 'string'));

const isRule = (rule: unknown): boolean => {
  if (!isRecord(rule) || typeof rule['id'] !== 'string' || typeof rule['legend'] !== 'string') return false;
  const appearance = rule['appearance'];
  return (
    isPredicateShape(rule['when']) &&
    isScheme(rule['scheme']) &&
    isMarker(rule['marker']) &&
    isRecord(appearance) &&
    typeof appearance['colour'] === 'string' &&
    (appearance['transparency'] === undefined || typeof appearance['transparency'] === 'number') &&
    (appearance['hidden'] === undefined || typeof appearance['hidden'] === 'boolean')
  );
};

function profileProblem(id: string, value: unknown): string | null {
  const where = `display.colourProfiles['${id}']`;
  if (isReservedKey(id)) return `display.colourProfiles: id '${id}' is a reserved JavaScript property name`;
  if (!isRecord(value) || value['id'] !== id) return `${where} must be an object whose id is '${id}'`;
  if (typeof value['name'] !== 'string' || typeof value['palette'] !== 'string' || typeof value['reviewRequired'] !== 'boolean')
    return `${where}: name and palette must be strings and reviewRequired a boolean`;
  if (typeof value['defaultColour'] !== 'string') return `${where}: defaultColour must be a string`;
  const approval = value['approval'];
  if (
    approval !== undefined &&
    !(
      isRecord(approval) &&
      typeof approval['signer'] === 'string' &&
      typeof approval['signatureId'] === 'string' &&
      typeof approval['profileSha256'] === 'string'
    )
  )
    return `${where}: approval must be { signer, signatureId, profileSha256 }`;
  const rules = value['rules'];
  if (!Array.isArray(rules) || !rules.every(isRule))
    return `${where}: rules must be { id, legend, when (predicate), appearance { colour, transparency?, hidden? }, scheme?, marker? { letters, letterHex? } }`;
  const problem = profileProblems(value as unknown as ColourProfile)[0];
  return problem === undefined ? null : `${where}: ${problem.path}: ${problem.message}`;
}

const COLOUR = /^#[0-9a-fA-F]{6}$/;
const unit = (value: unknown): boolean => typeof value === 'number' && value >= 0 && value <= 1;

function materialClassProblems(display: Record<string, unknown>): string[] {
  const classes = display['materialClasses'];
  const assigned = display['materialClassOf'];
  const problems: string[] = [];
  if (classes !== undefined) {
    if (!isRecord(classes)) return ['display.materialClasses must be a record'];
    for (const [id, entry] of Object.entries(classes)) {
      const where = `display.materialClasses['${id}']`;
      if (isReservedKey(id)) problems.push(`display.materialClasses: id '${id}' is a reserved JavaScript property name`);
      else if (!isRecord(entry) || entry['id'] !== id || typeof entry['name'] !== 'string')
        problems.push(`${where} must be { id: '${id}', name, colour, metalness, roughness }`);
      else if (entry['colour'] !== null && !(typeof entry['colour'] === 'string' && COLOUR.test(entry['colour'])))
        problems.push(`${where}.colour must be #rrggbb or null`);
      else if (!unit(entry['metalness']) || !unit(entry['roughness'])) problems.push(`${where}: metalness and roughness must be in [0, 1]`);
    }
  }
  if (assigned !== undefined) {
    if (!isRecord(assigned) || !Object.values(assigned).every((id) => typeof id === 'string'))
      problems.push('display.materialClassOf must map entity ids to class ids');
    else if (Object.keys(assigned).some(isReservedKey))
      problems.push('display.materialClassOf: an entity id is a reserved JavaScript property name');
  }
  return problems;
}

const isVec3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
const REASONS = ['valve', 'flange', 'bend', 'interval'];

function pipeMarkerProblems(display: Record<string, unknown>): string[] {
  const markers = display['pipeMarkers'];
  if (markers === undefined) return [];
  if (!isRecord(markers)) return ['display.pipeMarkers must be a record'];
  return Object.entries(markers).flatMap(([id, marker]) => {
    const where = `display.pipeMarkers['${id}']`;
    if (isReservedKey(id)) return [`display.pipeMarkers: id '${id}' is a reserved JavaScript property name`];
    const ok =
      isRecord(marker) &&
      marker['id'] === id &&
      typeof marker['pipeId'] === 'string' &&
      isVec3(marker['positionMm']) &&
      isVec3(marker['tangent']) &&
      typeof marker['atMm'] === 'number' &&
      REASONS.includes(marker['reason'] as string) &&
      typeof marker['fieldLengthMm'] === 'number' &&
      typeof marker['letterHeightMm'] === 'number' &&
      typeof marker['bandInterpolated'] === 'boolean' &&
      typeof marker['bidirectional'] === 'boolean' &&
      (marker['letters'] === undefined || typeof marker['letters'] === 'string') &&
      (marker['letterHex'] === undefined || typeof marker['letterHex'] === 'string');
    return ok
      ? []
      : [
          `${where} must be { id, pipeId, positionMm, tangent, atMm, reason, fieldLengthMm, letterHeightMm, bandInterpolated, bidirectional, letters?, letterHex? }`,
        ];
  });
}

function paletteProblems(display: Record<string, unknown>): string[] {
  const palettes = display['palettes'];
  if (palettes === undefined) return [];
  if (!isRecord(palettes)) return ['display.palettes must be a record'];
  return Object.entries(palettes).flatMap(([id, palette]) => {
    const where = `display.palettes['${id}']`;
    if (isReservedKey(id)) return [`display.palettes: id '${id}' is a reserved JavaScript property name`];
    if (!isRecord(palette) || palette['id'] !== id || typeof palette['name'] !== 'string' || !isRecord(palette['colours']))
      return [`${where} must be { id: '${id}', name, colours }`];
    const colours = palette['colours'];
    return Object.entries(colours).flatMap(([name, hex]) =>
      isReservedKey(name) || typeof hex !== 'string' || !COLOUR.test(hex)
        ? [`${where}.colours['${name}'] must be a #rrggbb colour under a usable name`]
        : [],
    );
  });
}

/** Problems of the optional `display` field of a raw document (absent is valid). */
export function displayProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || !isRecord(value['colourProfiles']))
    return ['display must be { colourProfiles, activeProfileId?, materialClasses?, materialClassOf?, pipeMarkers?, palettes? }'];
  const profiles = value['colourProfiles'];
  const active = value['activeProfileId'];
  const problems = [
    ...Object.entries(profiles).map(([id, profile]) => profileProblem(id, profile)),
    active === undefined || (typeof active === 'string' && Object.hasOwn(profiles, active))
      ? null
      : 'display.activeProfileId must name an existing profile',
    ...materialClassProblems(value),
    ...pipeMarkerProblems(value),
    ...paletteProblems(value),
  ];
  return problems.filter((problem): problem is string => problem !== null);
}
