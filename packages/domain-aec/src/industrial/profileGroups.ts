/**
 * Shared profile-group mechanics of the iterative design commands (design_portal_frames,
 * design_purlins): members of one role and section are up-sized together so rows stay uniform.
 * @layer domain-aec
 */

import { z } from '@core/commands/schema';
import type { BuildingModel, SteelMemberElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { withElement } from '../model';
import { findProfile, lightestProfile, sectionProperties } from '../steel/profiles';

/** Iteration cap of the design loops of design_portal_frames and design_purlins. */
const MAX_ITERATIONS = 15;

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

type UpsizeStep = ReturnType<typeof upsizeProfileGroups>;

/**
 * Iterate `step` (one upsize pass on the current document; `null` = nothing left to upsize) up
 * to MAX_ITERATIONS, accumulating the change texts and ids. `limited` when a group had no larger
 * size or the iteration cap was hit.
 */
export function iterateUpsizing(
  doc: CadDocument,
  step: (current: CadDocument) => UpsizeStep | null,
): { current: CadDocument; limited: boolean; changes: string[]; changed: Set<string> } {
  let current = doc;
  let limited = false;
  const changes: string[] = [];
  const changed = new Set<string>();
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const result = step(current);
    if (!result) break;
    changes.push(...result.changes);
    for (const id of result.changedIds) changed.add(id);
    current = { ...current, building: result.building };
    if (result.limited) limited = true;
    if (!result.progressed) break;
    if (iteration === MAX_ITERATIONS - 1) limited = true;
  }
  return { current, limited, changes, changed };
}

/**
 * Next heavier profile of the same family; at the top of the family, the lightest I-section
 * (IPE / HEA / HEB) with a larger plastic modulus. Null when nothing larger exists.
 */
export function nextProfile(name: string): string | null {
  const profile = findProfile(name);
  if (!profile) return null;
  const sameFamily = lightestProfile(
    (candidate) =>
      candidate.family === profile.family && candidate.massPerMetre > profile.massPerMetre,
  );
  if (sameFamily) return sameFamily.name;
  if (profile.shape !== 'I') return null;
  const modulus = sectionProperties(profile).plasticModulus;
  const stronger = lightestProfile(
    (candidate) =>
      candidate.shape === 'I' && sectionProperties(candidate).plasticModulus > modulus * 1.02,
  );
  return stronger?.name ?? null;
}
