/**
 * Portal frame design: iterative up-sizing of frame sections and sizing of moment-connection bolt
 * groups against check_portal_frames.
 * @layer domain-aec
 */
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { elementAffected, getBuilding, withElement, fromMm } from '../model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../evaluateElements';
import { refitPlates } from './plateSupport';
import { designFixedPlates } from './plateDesign';
import { findProfile, lightestProfile, sectionProperties } from '../steel/profiles';
import {
  addProfileGroup,
  isValidTargetUtilisation,
  MAX_ITERATIONS,
  resizeProfileGroup,
  targetUtilisationParam,
  upsizeProfileGroups,
  type ProfileGroups,
} from './profileGroups';
import { describeLoads, FRAME_LOAD_SHAPE, resolveFrameLoads } from './frameLoadParams';
import { sizeBoltGroups } from './frameBoltDesign';
import { checkFrames } from './frameCheckFrames';
import type { BuildingModel, SteelMemberElement } from '@core/model/building';
import type { CadDocument, Vec3 } from '@core/model/types';
import { add3, scale3 } from '@lib/vec3';
import { sweepFrame } from '../mesh';

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
    targetUtilisation: targetUtilisationParam,
  }),
  run: (doc, params): CommandResult => {
    const { targetUtilisation = 0.95 } = params;
    if (!isValidTargetUtilisation(targetUtilisation)) {
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
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
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
      const step = upsizeProfileGroups(building, groups, nextProfile, (next, group, larger) => {
        const resizedGroup = resizeProfileGroup(
          next,
          group,
          larger,
          (element) => analysed.has(element.id),
          (building, resized) =>
            refitPlates(current, withElement(building, resized), resized, group.profile).building,
        );
        const { resizedIds } = resizedGroup;
        const reseated = reseatDependents(
          current,
          resizedGroup.building,
          resizedIds,
          group.profile,
          larger,
          analysed,
        );
        return { building: reseated.building, changedIds: [...resizedIds, ...reseated.moved] };
      });
      changes.push(...step.changes);
      for (const id of step.changedIds) changed.add(id);
      if (step.limited) limited = true;
      current = { ...current, building: step.building };
      if (!step.progressed) break;
      if (iteration === MAX_ITERATIONS - 1) limited = true;
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

/**
 * Members placed from a resized member's depth follow it: purlins on a rafter move along the
 * rafter normal, gable-post tops drop under a deeper rafter, side rails move out with a deeper
 * column (by half the depth change).
 */
function reseatDependents(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  resizedIds: ReadonlyArray<string>,
  before: string,
  after: string,
  analysed: ReadonlySet<string>,
): { building: BuildingModel; moved: string[] } {
  const [old, larger] = [findProfile(before), findProfile(after)];
  if (!old || !larger || resizedIds.length === 0) return { building, moved: [] };
  const half = fromMm(doc, larger.h - old.h) / 2;
  const tolerance = fromMm(doc, 10);
  const resized = resizedIds
    .map((id) => building.elements[id])
    .filter((element): element is SteelMemberElement => element?.category === 'member');
  const onPlane = (member: SteelMemberElement, y: number): boolean =>
    Math.abs(member.start[1] - y) < tolerance && Math.abs(member.end[1] - y) < tolerance;
  let next = building;
  const moved: string[] = [];
  for (const element of Object.values(building.elements)) {
    if (element.category !== 'member' || analysed.has(element.id)) continue;
    let offset: Vec3 | null = null;
    let topOnly = false;
    if (element.role === 'purlin' || element.role === 'column') {
      // Purlins span between frame planes; gable posts stand in one.
      const rafter = resized.find((candidate) => {
        if (candidate.role !== 'rafter') return false;
        const y = candidate.start[1];
        const inPlane =
          element.role === 'purlin'
            ? Math.abs(element.start[1] - y) < tolerance || Math.abs(element.end[1] - y) < tolerance
            : onPlane(element, y);
        const [low, high] = [
          Math.min(candidate.start[0], candidate.end[0]),
          Math.max(candidate.start[0], candidate.end[0]),
        ];
        // Gable posts stand strictly inside the rafter span (frame columns sit at its ends).
        const margin = element.role === 'purlin' ? -fromMm(doc, larger.h) : tolerance;
        return inPlane && element.start[0] > low + margin && element.start[0] < high - margin;
      });
      const frame = rafter ? sweepFrame(rafter.start, rafter.end, rafter.roll) : null;
      if (frame && element.role === 'purlin') offset = scale3(frame.v, half);
      if (frame && element.role === 'column' && Math.abs(frame.v[2]) > 1e-6) {
        offset = [0, 0, -half / frame.v[2]];
        topOnly = true;
      }
    }
    if (element.role === 'rail') {
      const column = resized.find(
        (candidate) =>
          candidate.role === 'column' &&
          (Math.abs(candidate.start[1] - element.start[1]) < tolerance ||
            Math.abs(candidate.start[1] - element.end[1]) < tolerance) &&
          Math.abs(candidate.start[0] - element.start[0]) < fromMm(doc, larger.h + 500),
      );
      if (column) offset = [Math.sign(element.start[0] - column.start[0]) * half, 0, 0];
    }
    if (!offset) continue;
    const by = offset;
    const updated: SteelMemberElement = topOnly
      ? element.start[2] >= element.end[2]
        ? { ...element, start: add3(element.start, by) }
        : { ...element, end: add3(element.end, by) }
      : { ...element, start: add3(element.start, by), end: add3(element.end, by) };
    next = withElement(next, updated);
    moved.push(element.id);
  }
  return { building: next, moved };
}
