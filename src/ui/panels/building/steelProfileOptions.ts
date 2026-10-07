/**
 * @layer ui/panels/building
 * Catalogue section options shared by the steel tool forms and the element inspector.
 */

import { STEEL_PROFILES } from '@aec/steel/profiles';

export type SelectOption = readonly [string, string];

export const ALL_PROFILES: ReadonlyArray<SelectOption> = STEEL_PROFILES.map(
  (profile): SelectOption => [profile.name, `${profile.name} · ${profile.massPerMetre} kg/m`],
);

export const I_PROFILES: ReadonlyArray<SelectOption> = ALL_PROFILES.filter(([name]) =>
  /^(IPE|HEA|HEB)/.test(name),
);

export const MEMBER_ROLE_OPTIONS: ReadonlyArray<SelectOption> = [
  ['column', 'Column'],
  ['beam', 'Beam'],
  ['rafter', 'Rafter'],
  ['brace', 'Brace'],
  ['purlin', 'Purlin'],
  ['rail', 'Side rail'],
  ['crane', 'Crane beam'],
];

export const JOINT_OPTIONS: ReadonlyArray<SelectOption> = [
  ['pinned', 'Pinned'],
  ['rigid', 'Rigid (moment connection)'],
];

export const BASE_OPTIONS: ReadonlyArray<SelectOption> = [
  ['pinned', 'Pinned'],
  ['fixed', 'Fixed'],
];
