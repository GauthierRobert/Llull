// Steel member inspector form: element → field texts → changed `update_steel_member` params.

import type { SteelMemberElement } from '@aec/index';
import { changedFields, changedText } from '@ui/panels/changedParams';

export type SteelMemberEditKey = 'profile' | 'material' | 'role' | 'note' | 'startJoint' | 'endJoint' | 'baseFixity';

export type SteelMemberEditValues = Readonly<Record<SteelMemberEditKey, string>>;

const EDIT_KEYS: ReadonlyArray<SteelMemberEditKey> = ['profile', 'role', 'startJoint', 'endJoint', 'baseFixity', 'material', 'note'];

/** A section change of a horizontal member can keep its top of steel. */
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

/** null when nothing differs from `initial`. */
export function buildSteelMemberUpdate(
  memberId: string,
  initial: SteelMemberEditValues,
  values: SteelMemberEditValues,
  /** Horizontal members only (ignored otherwise). */
  keepTopOfSteel = false,
): Record<string, unknown> | null {
  // Blank joint / fixity / grade = "default", which the command cannot express: skipped.
  const changes: Record<string, unknown> = { ...changedFields(initial, values, ['note']) };
  for (const key of EDIT_KEYS) {
    if (key !== 'note') Object.assign(changes, changedText(key, values[key], initial[key]));
  }
  if (Object.keys(changes).length === 0) return null;
  return { memberId, ...changes, ...(keepTopOfSteel && 'profile' in changes ? { keepTopOfSteel: true } : {}) };
}
