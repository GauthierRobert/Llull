/**
 * @layer ui/panels/building
 * Steel member inspector form spec: element → field texts, field texts → the changed
 * `update_steel_member` params (param-gathering only, react R1).
 */

import type { SteelMemberElement } from '@core/model/building';

export type SteelMemberEditKey =
  | 'profile'
  | 'material'
  | 'role'
  | 'note'
  | 'startJoint'
  | 'endJoint'
  | 'baseFixity';

export type SteelMemberEditValues = Readonly<Record<SteelMemberEditKey, string>>;

const EDIT_KEYS: ReadonlyArray<SteelMemberEditKey> = [
  'profile',
  'role',
  'startJoint',
  'endJoint',
  'baseFixity',
  'material',
  'note',
];

export function steelMemberValues(member: SteelMemberElement): SteelMemberEditValues {
  return {
    profile: member.profile,
    material: member.material,
    role: member.role,
    note: member.note ?? '',
    startJoint: member.startJoint ?? '',
    endJoint: member.endJoint ?? '',
    baseFixity: member.baseFixity ?? '',
  };
}

/** `update_steel_member` params for the fields that differ from `initial`; null if none. */
export function buildSteelMemberUpdate(
  memberId: string,
  initial: SteelMemberEditValues,
  values: SteelMemberEditValues,
): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {};
  for (const key of EDIT_KEYS) {
    if (values[key] === initial[key]) continue;
    const text = values[key].trim();
    // A blank joint / fixity / grade means "default": the command cannot express that, so skip.
    if (text === '' && key !== 'note') continue;
    changes[key] = key === 'note' ? values[key] : text;
  }
  return Object.keys(changes).length === 0 ? null : { memberId, ...changes };
}
