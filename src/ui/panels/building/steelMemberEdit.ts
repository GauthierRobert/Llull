/**
 * @layer ui/panels/building
 * Steel member inspector form spec: element → field texts, field texts → the changed
 * `update_steel_member` params (param-gathering only, react R1).
 */

import type { SteelMemberElement } from '@core/model/building';
import { changedFields, changedText } from '@ui/panels/changedParams';

export type SteelMemberEditKey = 'profile' | 'material' | 'role' | 'note' | 'startJoint' | 'endJoint' | 'baseFixity';

export type SteelMemberEditValues = Readonly<Record<SteelMemberEditKey, string>>;

const EDIT_KEYS: ReadonlyArray<SteelMemberEditKey> = ['profile', 'role', 'startJoint', 'endJoint', 'baseFixity', 'material', 'note'];

/** Horizontal axis: a section change can keep its top of steel. */
export function isHorizontalMember(member: SteelMemberElement): boolean {
  return Math.abs(member.end[2] - member.start[2]) < 1e-9;
}

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
  /** A new section keeps the top of steel (horizontal members; the command ignores it otherwise). */
  keepTopOfSteel = false,
): Record<string, unknown> | null {
  // A blank joint / fixity / grade means "default": the command cannot express that, so skip it.
  const changes: Record<string, unknown> = {
    ...changedFields(initial, values, ['note']),
  };
  for (const key of EDIT_KEYS) {
    if (key !== 'note') Object.assign(changes, changedText(key, values[key], initial[key]));
  }
  if (Object.keys(changes).length === 0) return null;
  return {
    memberId,
    ...changes,
    ...(keepTopOfSteel && 'profile' in changes ? { keepTopOfSteel: true } : {}),
  };
}
