/**
 * Purlin / side-rail design: iterative up-sizing of the secondary steel against check_purlins and
 * re-seating of the resized members on the rafters / columns.
 * @layer domain-aec
 */

import type { BuildingModel } from '@core/model/building';
import type { CadDocument, Vec3 } from '@core/model/types';
import { PURLIN_LOAD_SHAPE } from './purlinLoadParams';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { elementAffected, elementsOf, fromMm, getBuilding, withElement } from '../model';
import { noop } from '@core/commands/noop';
import { add3, scale3 } from '@lib/vec3';
import { regenerateBuilding } from '../evaluateElements';
import { finalUtilisationText, noChangeResult, utilisationStats } from './designReport';
import { sweepFrame } from '../mesh';
import { findProfile, lightestProfile, sectionProperties } from '../steel/profiles';

import {
  addProfileGroup,
  isValidTargetUtilisation,
  MAX_ITERATIONS,
  nextProfile,
  recordUpsizeStep,
  resizeProfileGroup,
  targetUtilisationParam,
  upsizeProfileGroups,
  type ProfileGroups,
} from './profileGroups';
import { type PurlinRow } from './purlinModel';
import { checkPurlins } from './purlinCheckRun';

/**
 * Next heavier secondary-steel profile: the next cold-formed C by mass, then the lightest IPE with a
 * larger plastic modulus than the C's elastic modulus; other families as design_portal_frames.
 * Null when nothing larger exists.
 */
export function nextSecondaryProfile(name: string): string | null {
  const profile = findProfile(name);
  if (!profile) return null;
  if (profile.shape !== 'C') return nextProfile(name);
  const heavierC = lightestProfile(
    (candidate) => candidate.family === 'C' && candidate.massPerMetre > profile.massPerMetre,
  );
  if (heavierC) return heavierC.name;
  const modulus = sectionProperties(profile).elasticModulus;
  const ipe = lightestProfile(
    (candidate) =>
      candidate.family === 'IPE' && sectionProperties(candidate).plasticModulus > modulus * 1.02,
  );
  return ipe?.name ?? null;
}

/**
 * @command design_purlins
 * @pure
 * @affects up-sizes failing purlin / rail profiles (all members of that role and profile on the
 *          level, keeping rows uniform) and re-seats them on the rafters / columns
 * @invariant a deeper purlin moves along the rafter normal, a deeper rail outwards, by half the depth change
 * @failure bad loads / unknown level / no purlins / no section large enough -> no-op or partial report
 */
export const designPurlins = defineCommand({
  name: 'design_purlins',
  description:
    'Preliminary design of the roof purlins and side rails of a level with the same loads and checks ' +
    'as check_purlins: repeatedly runs the check and up-sizes every purlin / rail profile (all ' +
    'members of that role and profile on the level, so rows stay uniform) whose utilisation exceeds ' +
    'targetUtilisation to the next heavier cold-formed C section, then to IPE when the C range is ' +
    'exhausted (at most 15 iterations). Deeper members are re-seated: a purlin moves along the ' +
    'rafter normal and a rail outwards from the column by half the depth change. Reports every ' +
    'change and the final maximum utilisation; no change returns the document untouched. ' +
    'Bracing eaves struts are not sized (see check_bracing).',
  params: z.object({
    ...PURLIN_LOAD_SHAPE,
    targetUtilisation: targetUtilisationParam,
  }),
  run: (doc, params): CommandResult => {
    const { targetUtilisation = 0.95, ...loadParams } = params;
    if (!isValidTargetUtilisation(targetUtilisation)) {
      return noop(doc, 'design_purlins failed: targetUtilisation must be in [0.5, 1].');
    }
    const analyse = (document: CadDocument): { rows: PurlinRow[]; summary: string } => {
      const result = checkPurlins.run(document, loadParams);
      const data = result.data as { rows: PurlinRow[] } | undefined;
      return { rows: data?.rows ?? [], summary: result.summary };
    };
    const first = analyse(doc);
    if (first.rows.length === 0) {
      return noop(doc, `design_purlins failed: ${first.summary}`);
    }
    let current = doc;
    let limited = false;
    const changes: string[] = [];
    const changed = new Set<string>();
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const { rows } = analyse(current);
      const building = getBuilding(current);
      const levelId = levelOf(building, rows);
      const groups: ProfileGroups = new Map();
      for (const row of rows) {
        if (row.utilisation <= targetUtilisation) continue;
        const member = building.elements[row.elementId];
        if (member?.category !== 'member') continue;
        addProfileGroup(groups, member);
      }
      if (groups.size === 0) break;
      const step = upsizeProfileGroups(
        building,
        groups,
        nextSecondaryProfile,
        (next, group, larger) => {
          const { building: resizedBuilding, resizedIds } = resizeProfileGroup(
            next,
            group,
            larger,
            (element) => element.levelId === levelId,
          );
          return {
            building: reseatResized(current, resizedBuilding, resizedIds, group.profile, larger),
            changedIds: resizedIds,
          };
        },
      );
      recordUpsizeStep(step, changes, changed);
      current = { ...current, building: step.building };
      if (step.limited) limited = true;
      if (!step.progressed) break;
      if (iteration === MAX_ITERATIONS - 1) limited = true;
    }
    if (changed.size === 0) {
      return noChangeResult(doc, `${first.rows.length} purlin / rail row(s)`, first.rows, limited);
    }
    const document = regenerateBuilding(doc, getBuilding(current));
    const final = analyse(document).rows;
    const stats = utilisationStats(final);
    return {
      document,
      summary:
        `Designed ${final.length} purlin / rail row(s): ${changes.join('; ')}. ` +
        `${finalUtilisationText(stats, 'row(s)', limited)} ` +
        `Re-seated on rafters / columns; verify bracing eaves struts with check_bracing.`,
      affected: elementAffected(document, [...changed]),
      data: { changes, ...stats },
    };
  },
});

/** Level of the checked rows (all rows of one check share one level). */
function levelOf(building: BuildingModel, rows: ReadonlyArray<PurlinRow>): string | undefined {
  const element = rows[0] ? building.elements[rows[0].elementId] : undefined;
  return element?.category === 'member' ? element.levelId : undefined;
}

/**
 * A deeper purlin sits on the rafter top flange: its axis moves along the rafter normal by half the
 * depth change. A deeper rail moves away from the hall centre by half the depth change.
 */
function reseatResized(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  resizedIds: ReadonlyArray<string>,
  before: string,
  after: string,
): BuildingModel {
  const [old, larger] = [findProfile(before), findProfile(after)];
  if (!old || !larger) return building;
  const half = fromMm(doc, larger.h - old.h) / 2;
  const tolerance = fromMm(doc, 10);
  const members = elementsOf(building, 'member');
  const rafters = members.filter((member) => member.role === 'rafter');
  const xs = members.flatMap((member) => [member.start[0], member.end[0]]);
  const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
  let next = building;
  for (const id of resizedIds) {
    const member = building.elements[id];
    if (member?.category !== 'member') continue;
    let offset: Vec3 | null = null;
    if (member.role === 'purlin') {
      const margin = fromMm(doc, larger.h);
      const rafter = rafters.find(
        (candidate) =>
          candidate.levelId === member.levelId &&
          (Math.abs(candidate.start[1] - member.start[1]) < tolerance ||
            Math.abs(candidate.start[1] - member.end[1]) < tolerance) &&
          member.start[0] > Math.min(candidate.start[0], candidate.end[0]) - margin &&
          member.start[0] < Math.max(candidate.start[0], candidate.end[0]) + margin,
      );
      const frame = rafter ? sweepFrame(rafter.start, rafter.end, rafter.roll) : null;
      if (frame) offset = scale3(frame.v, half);
    } else if (member.role === 'rail') {
      offset = [Math.sign(member.start[0] - centre) * half, 0, 0];
    }
    if (!offset) continue;
    next = withElement(next, {
      ...member,
      start: add3(member.start, offset),
      end: add3(member.end, offset),
    });
  }
  return next;
}
