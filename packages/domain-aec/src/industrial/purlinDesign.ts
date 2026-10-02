/**
 * Purlin / side-rail design: iterative up-sizing of the secondary steel against check_purlins and
 * re-seating of the resized members on the rafters / columns.
 * @layer domain-aec
 */

import type { BuildingModel, SteelMemberElement } from '@core/model/building';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isFiniteNumber,
  noChange,
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluate';
import { sweepFrame } from '../mesh';
import { findProfile, sectionProperties, STEEL_PROFILES } from '../steel/profiles';
import { nextProfile } from './frameDesign';
import { checkPurlins, type PurlinRow } from './purlinCheck';

const MAX_ITERATIONS = 15;

const byMass = (a: { massPerMetre: number }, b: { massPerMetre: number }): number =>
  a.massPerMetre - b.massPerMetre;

/**
 * Next heavier secondary-steel profile: the next cold-formed C by mass, then the lightest IPE with a
 * larger plastic modulus than the C's elastic modulus; other families as design_portal_frames.
 * Null when nothing larger exists.
 */
export function nextSecondaryProfile(name: string): string | null {
  const profile = findProfile(name);
  if (!profile) return null;
  if (profile.shape !== 'C') return nextProfile(name);
  const heavierC = STEEL_PROFILES.filter(
    (candidate) => candidate.family === 'C' && candidate.massPerMetre > profile.massPerMetre,
  ).sort(byMass)[0];
  if (heavierC) return heavierC.name;
  const modulus = sectionProperties(profile).elasticModulus;
  const ipe = STEEL_PROFILES.filter(
    (candidate) =>
      candidate.family === 'IPE' && sectionProperties(candidate).plasticModulus > modulus * 1.02,
  ).sort(byMass)[0];
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
    windPressure: z
      .number()
      .optional()
      .describe('Peak velocity pressure qp, kN/m² (EN 1991-1-4), >= 0. Default 0.6.'),
    snowLoad: z.number().optional().describe('Roof snow load on plan, kN/m², >= 0. Default 0.8.'),
    roofDeadLoad: z
      .number()
      .optional()
      .describe(
        'Roof build-up dead load per m² of roof carried by the purlins, kN/m², >= 0. Default 0.3.',
      ),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
    targetUtilisation: z
      .number()
      .optional()
      .describe('Maximum accepted utilisation (0.5–1). Default 0.95.'),
  }),
  run: (doc, params): CommandResult => {
    const { targetUtilisation = 0.95, ...loadParams } = params;
    if (
      !(isFiniteNumber(targetUtilisation) && targetUtilisation >= 0.5 && targetUtilisation <= 1)
    ) {
      return noChange(doc, 'design_purlins failed: targetUtilisation must be in [0.5, 1].');
    }
    const analyse = (document: CadDocument): { rows: PurlinRow[]; summary: string } => {
      const result = checkPurlins.run(document, loadParams);
      const data = result.data as { rows: PurlinRow[] } | undefined;
      return { rows: data?.rows ?? [], summary: result.summary };
    };
    const first = analyse(doc);
    if (first.rows.length === 0) {
      return noChange(doc, `design_purlins failed: ${first.summary}`);
    }
    let current = doc;
    let limited = false;
    const changes: string[] = [];
    const changed = new Set<string>();
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const { rows } = analyse(current);
      const building = getBuilding(current);
      const levelId = levelOf(building, rows);
      const groups = new Map<string, { role: string; profile: string }>();
      for (const row of rows) {
        if (row.utilisation <= targetUtilisation) continue;
        const member = building.elements[row.elementId];
        if (member?.category !== 'member') continue;
        groups.set(`${member.role}:${member.profile}`, {
          role: member.role,
          profile: member.profile,
        });
      }
      if (groups.size === 0) break;
      let next = building;
      let progressed = false;
      for (const { role, profile } of groups.values()) {
        const larger = nextSecondaryProfile(profile);
        if (!larger) {
          limited = true;
          continue;
        }
        progressed = true;
        changes.push(`${role}s ${profile} → ${larger}`);
        const resizedIds: string[] = [];
        for (const element of Object.values(next.elements)) {
          if (
            element.category !== 'member' ||
            element.levelId !== levelId ||
            element.role !== role ||
            element.profile !== profile
          )
            continue;
          next = withElement(next, { ...element, profile: larger });
          changed.add(element.id);
          resizedIds.push(element.id);
        }
        next = reseatResized(current, next, resizedIds, profile, larger);
      }
      current = { ...current, building: next };
      if (!progressed) break;
      if (iteration === MAX_ITERATIONS - 1) limited = true;
    }
    if (changed.size === 0) {
      const worst = Math.max(0, ...first.rows.map((row) => row.utilisation));
      return {
        document: doc,
        summary:
          `Designed ${first.rows.length} purlin / rail row(s): no change needed (max utilisation ${worst.toFixed(2)}` +
          `${limited ? '; largest available size reached for some elements' : ''}).`,
        affected: [],
        data: {
          changes: [],
          maxUtilisation: worst,
          failures: first.rows.filter((row) => row.utilisation > 1).length,
        },
      };
    }
    const document = regenerateBuilding(doc, getBuilding(current));
    const final = analyse(document).rows;
    const worst = Math.max(0, ...final.map((row) => row.utilisation));
    const failures = final.filter((row) => row.utilisation > 1).length;
    return {
      document,
      summary:
        `Designed ${final.length} purlin / rail row(s): ${changes.join('; ')}. ` +
        `Max utilisation now ${worst.toFixed(2)}${failures > 0 ? `, ${failures} row(s) still failing` : ''}` +
        `${limited ? ' (largest available size reached for some elements)' : ''}. ` +
        `Re-seated on rafters / columns; verify bracing eaves struts with check_bracing.`,
      affected: elementAffected(document, [...changed]),
      data: { changes, maxUtilisation: worst, failures },
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
  const members = Object.values(building.elements).filter(
    (element): element is SteelMemberElement => element.category === 'member',
  );
  const rafters = members.filter((member) => member.role === 'rafter');
  const xs = members.flatMap((member) => [member.start[0], member.end[0]]);
  const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
  const shift = (point: Vec3, by: Vec3): Vec3 => [
    point[0] + by[0],
    point[1] + by[1],
    point[2] + by[2],
  ];
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
      if (frame) offset = [frame.v[0] * half, frame.v[1] * half, frame.v[2] * half];
    } else if (member.role === 'rail') {
      offset = [Math.sign(member.start[0] - centre) * half, 0, 0];
    }
    if (!offset) continue;
    next = withElement(next, {
      ...member,
      start: shift(member.start, offset),
      end: shift(member.end, offset),
    });
  }
  return next;
}
