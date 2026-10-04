/**
 * Portal frame design: iterative up-sizing of frame sections and sizing of moment-connection bolt
 * groups against check_portal_frames.
 * @layer domain-aec
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { elementAffected, getBuilding, withElement } from '../model';
import { noop } from '@core/commands/noop';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { regenerateBuilding } from '../evaluateElements';
import { refitPlates } from './plateSupport';
import { designFixedPlates } from './plateDesign';
import { findProfile, sectionProperties, STEEL_PROFILES } from '../steel/profiles';
import { addProfileGroup, resizeProfileGroup, type ProfileGroups } from './profileGroups';
import { describeLoads, FRAME_LOAD_SHAPE, resolveFrameLoads } from './frameLoadParams';
import { sizeBoltGroups } from './frameBoltDesign';
import { reseatDependents } from './frameReseat';
import { checkFrames } from './frameCheckFrames';

/**
 * Next heavier profile of the same family; at the top of the family, the lightest I-section
 * (IPE / HEA / HEB) with a larger plastic modulus. Null when nothing larger exists.
 */
export function nextProfile(name: string): string | null {
  const profile = findProfile(name);
  if (!profile) return null;
  const byMass = (a: { massPerMetre: number }, b: { massPerMetre: number }): number =>
    a.massPerMetre - b.massPerMetre;
  const sameFamily = STEEL_PROFILES.filter(
    (candidate) =>
      candidate.family === profile.family && candidate.massPerMetre > profile.massPerMetre,
  ).sort(byMass);
  if (sameFamily[0]) return sameFamily[0].name;
  if (profile.shape !== 'I') return null;
  const modulus = sectionProperties(profile).plasticModulus;
  const stronger = STEEL_PROFILES.filter(
    (candidate) =>
      candidate.shape === 'I' && sectionProperties(candidate).plasticModulus > modulus * 1.02,
  ).sort(byMass);
  return stronger[0]?.name ?? null;
}

/**
 * @command design_portal_frames
 * @pure
 * @affects up-sizes failing rafter / column profiles (all members of that role and section on the
 *          level, keeping frames uniform) and sizes the bolt groups of every moment connection
 * @failure bad loads / unknown level / no frame / no section large enough -> no-op or partial report
 */
export const designPortalFrames = defineCommand({
  name: 'design_portal_frames',
  description:
    'Preliminary design of the portal frames of a level with the same loads, combinations and ' +
    'checks as check_portal_frames (strength, buckling, sway stability, SLS deflections): ' +
    'repeatedly analyses the frames and up-sizes the rafter / column sections that exceed ' +
    'targetUtilisation to the next heavier profile of the same family (uniformly for all frames), ' +
    'then sizes the bolt groups of the moment connections (bolt diameter M20–M30 and rows) per ' +
    'connection type for every combination. Reports every change and the final utilisations.',
  params: z.object({
    ...FRAME_LOAD_SHAPE,
    targetUtilisation: z
      .number()
      .optional()
      .describe('Maximum accepted utilisation (0.5–1). Default 0.95.'),
  }),
  run: (doc, params): CommandResult => {
    const { targetUtilisation = 0.95 } = params;
    if (
      !(isFiniteNumber(targetUtilisation) && targetUtilisation >= 0.5 && targetUtilisation <= 1)
    ) {
      return noop(doc, 'design_portal_frames failed: targetUtilisation must be in [0.5, 1].');
    }
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved) return noop(doc, `design_portal_frames failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    let current = doc;
    const analysed = new Set<string>();
    const changes: string[] = [];
    const changed = new Set<string>();
    let limited = false;
    for (let iteration = 0; iteration < 15; iteration++) {
      const { rows, frames } = checkFrames(current, levelId, loads);
      if (frames === 0) {
        return noop(doc, 'design_portal_frames failed: no analysable portal frame on the level.');
      }
      const building = getBuilding(current);
      for (const row of rows) if (row.kind !== 'connection') analysed.add(row.elementId);
      const groups: ProfileGroups = new Map();
      const addGroup = (elementId: string): void => {
        const member = building.elements[elementId];
        if (member?.category === 'member') addProfileGroup(groups, member);
      };
      for (const row of rows) {
        if (row.kind === 'connection' || row.utilisation <= targetUtilisation) continue;
        addGroup(row.elementId);
        // Sway and stability depend on the whole frame: stiffen its rafters with the columns.
        if (row.kind === 'stability' || (row.kind === 'deflection' && row.check.includes('sway'))) {
          for (const other of rows) {
            if (other.frame === row.frame && other.kind === 'rafter') addGroup(other.elementId);
          }
        }
      }
      if (groups.size === 0) break;
      let next = building;
      let progressed = false;
      for (const { role, profile } of groups.values()) {
        const larger = nextProfile(profile);
        if (!larger) {
          limited = true;
          continue;
        }
        progressed = true;
        changes.push(`${role}s ${profile} → ${larger}`);
        const resizedGroup = resizeProfileGroup(
          next,
          { role, profile },
          larger,
          (element) => analysed.has(element.id),
          (building, resized) =>
            refitPlates(current, withElement(building, resized), resized, profile).building,
        );
        next = resizedGroup.building;
        const resizedIds = resizedGroup.resizedIds;
        for (const id of resizedIds) changed.add(id);
        const reseated = reseatDependents(current, next, resizedIds, profile, larger, analysed);
        next = reseated.building;
        for (const id of reseated.moved) changed.add(id);
      }
      current = { ...current, building: next };
      if (!progressed) break;
      if (iteration === 14) limited = true;
    }
    const { rows } = checkFrames(current, levelId, loads);
    const bolts = sizeBoltGroups(current, getBuilding(current), rows, targetUtilisation);
    let building = bolts.building;
    changes.push(...bolts.changes);
    for (const id of bolts.changed) changed.add(id);
    if (bolts.limited) limited = true;
    const plates = designFixedPlates(current, building, levelId, loads, targetUtilisation);
    building = plates.building;
    if (plates.changed.length > 0) changes.push(...plates.descriptions);
    for (const id of plates.changed) changed.add(id);
    if (plates.unresolved > 0) limited = true;
    if (changed.size === 0) {
      const final = checkFrames(doc, levelId, loads);
      const worst = Math.max(0, ...final.rows.map((row) => row.utilisation));
      return {
        document: doc,
        summary: `Designed ${final.frames} frame(s): no change needed (max utilisation ${worst.toFixed(2)}${limited ? '; largest available size reached for some elements' : ''}).`,
        affected: [],
        data: {
          changes: [],
          maxUtilisation: worst,
          failures: final.rows.filter((row) => row.utilisation > 1).length,
        },
      };
    }
    const document = regenerateBuilding(doc, building);
    const final = checkFrames(document, levelId, loads);
    const unanalysedPosts = Object.values(building.elements).some(
      (element) =>
        element.category === 'member' &&
        element.levelId === levelId &&
        element.role === 'column' &&
        !analysed.has(element.id),
    );
    const worst = Math.max(0, ...final.rows.map((row) => row.utilisation));
    const failures = final.rows.filter((row) => row.utilisation > 1).length;
    return {
      document,
      summary:
        `Designed ${final.frames} frame(s) for ${final.combinations.length} ULS combination(s) + SLS (${describeLoads(loads)}): ` +
        `${changes.length > 0 ? changes.join('; ') : 'no change needed'}. ` +
        `Max utilisation now ${worst.toFixed(2)}${failures > 0 ? `, ${failures} element(s) still failing` : ''}` +
        `${limited ? ' (largest available size reached for some elements)' : ''}. ` +
        `Frames only (verify bracing, foundations and runways with their checks)` +
        `${unanalysedPosts ? '; gable posts are not analysed' : ''}.`,
      affected: elementAffected(document, [...changed]),
      data: { changes, maxUtilisation: worst, failures },
    };
  },
});
