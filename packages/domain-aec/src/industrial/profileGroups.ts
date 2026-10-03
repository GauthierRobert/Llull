/**
 * Shared profile-group mechanics of the iterative design commands (design_portal_frames,
 * design_purlins): members of one role and section are up-sized together so rows stay uniform.
 * @layer domain-aec
 */

import type { BuildingModel, SteelMemberElement } from '@core/model/building';
import { withElement } from '../model';

export interface ProfileGroup {
  role: string;
  profile: string;
}

export type ProfileGroups = Map<string, ProfileGroup>;

/** Register the role + profile of a steel member (idempotent per role:profile). */
export function addProfileGroup(groups: ProfileGroups, member: SteelMemberElement): void {
  groups.set(`${member.role}:${member.profile}`, { role: member.role, profile: member.profile });
}

/**
 * Re-profile every member of the group accepted by `isTarget`; `resize` returns the building with
 * the resized member applied (it may also refit dependents).
 * @pure
 */
export function resizeProfileGroup(
  building: BuildingModel,
  group: ProfileGroup,
  larger: string,
  isTarget: (member: SteelMemberElement) => boolean,
  resize: (next: BuildingModel, resized: SteelMemberElement) => BuildingModel = withElement,
): { building: BuildingModel; resizedIds: string[] } {
  let next = building;
  const resizedIds: string[] = [];
  for (const element of Object.values(building.elements)) {
    if (
      element.category !== 'member' ||
      element.role !== group.role ||
      element.profile !== group.profile ||
      !isTarget(element)
    )
      continue;
    next = resize(next, { ...element, profile: larger });
    resizedIds.push(element.id);
  }
  return { building: next, resizedIds };
}
