/**
 * Shared profile-group mechanics of the iterative design commands (design_portal_frames,
 * design_purlins): members of one role and section are up-sized together so rows stay uniform.
 * @layer domain-aec
 */

import { z } from '@core/commands/schema';
import type { BuildingModel, SteelMemberElement } from '@core/model/building';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { withElement } from '../model';

/** Iteration cap of the design loops of design_portal_frames and design_purlins. */
export const MAX_ITERATIONS = 15;

/** Shared `targetUtilisation` parameter of the design commands. */
export const targetUtilisationParam = z
  .number()
  .optional()
  .describe('Maximum accepted utilisation (0.5–1). Default 0.95.');

/** @invariant accepted target utilisations lie in [0.5, 1] */
export function isValidTargetUtilisation(value: number): boolean {
  return isFiniteNumber(value) && value >= 0.5 && value <= 1;
}

interface ProfileGroup {
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

/**
 * One design iteration: up-size every group to `nextSize(profile)` via `resizeGroup` (which also
 * re-seats dependents). Groups without a larger size set `limited`; `progressed` is false when no
 * group could grow.
 * @pure
 */
export function upsizeProfileGroups(
  building: BuildingModel,
  groups: ProfileGroups,
  nextSize: (profile: string) => string | null,
  resizeGroup: (
    building: BuildingModel,
    group: ProfileGroup,
    larger: string,
  ) => { building: BuildingModel; changedIds: string[] },
): {
  building: BuildingModel;
  progressed: boolean;
  limited: boolean;
  changes: string[];
  changedIds: string[];
} {
  let next = building;
  let progressed = false;
  let limited = false;
  const changes: string[] = [];
  const changedIds: string[] = [];
  for (const group of groups.values()) {
    const larger = nextSize(group.profile);
    if (!larger) {
      limited = true;
      continue;
    }
    progressed = true;
    changes.push(`${group.role}s ${group.profile} → ${larger}`);
    const resized = resizeGroup(next, group, larger);
    next = resized.building;
    changedIds.push(...resized.changedIds);
  }
  return { building: next, progressed, limited, changes, changedIds };
}
