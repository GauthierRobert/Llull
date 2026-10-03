/**
 * Portal frame design: iterative up-sizing of frame sections and sizing of moment-connection bolt
 * groups against check_portal_frames.
 * @layer domain-aec
 */

import type {
  BuildingModel,
  MomentConnectionElement,
  SteelMemberElement,
} from '@core/model/building';
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
import { regenerateBuilding } from '../evaluateElements';
import { refitPlates } from './plates';
import { designFixedPlates } from './plateDesign';
import { findProfile, sectionProperties, STEEL_PROFILES } from '../steel/profiles';
import { buildingConnectionSolids } from './evaluate';
import { addProfileGroup, resizeProfileGroup, type ProfileGroups } from './profileGroups';
import { sweepFrame } from '../mesh';
import { describeLoads, FRAME_LOAD_SHAPE, resolveFrameLoads } from './frameCheckPortal';
import { connectionCheck } from './frameCheckSolve';
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

const BOLT_SIZES_MM = [20, 24, 27, 30];

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
      return noChange(doc, 'design_portal_frames failed: targetUtilisation must be in [0.5, 1].');
    }
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved)
      return noChange(doc, `design_portal_frames failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    let current = doc;
    const analysed = new Set<string>();
    const changes: string[] = [];
    const changed = new Set<string>();
    let limited = false;
    for (let iteration = 0; iteration < 15; iteration++) {
      const { rows, frames } = checkFrames(current, levelId, loads);
      if (frames === 0) {
        return noChange(
          doc,
          'design_portal_frames failed: no analysable portal frame on the level.',
        );
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
    // Bolt groups: smallest bolt diameter / row count that passes for every connection of a kind.
    const { rows } = checkFrames(current, levelId, loads);
    let building = getBuilding(current);
    for (const kind of ['eaves', 'apex'] as const) {
      const targets = rows.filter((row) => {
        const element = building.elements[row.elementId];
        return element?.category === 'connection' && element.kind === kind && row.forces;
      });
      if (targets.length === 0) continue;
      let chosen: { rows: number; diameter: number } | null = null;
      // Fallback when nothing passes: the feasible group with the lowest worst utilisation.
      let best: { rows: number; diameter: number; worst: number } | null = null;
      search: for (const diameter of BOLT_SIZES_MM) {
        for (let boltRows = kind === 'eaves' ? 3 : 2; boltRows <= 6; boltRows++) {
          let worst = 0;
          let feasible = true;
          for (const row of targets) {
            const original = building.elements[row.elementId] as MomentConnectionElement;
            const trial: MomentConnectionElement = {
              ...original,
              boltRows,
              boltDiameter: fromMm(current, diameter),
            };
            if (!rowSpacingOk(current, building, trial)) {
              feasible = false;
              break;
            }
            const trialBuilding = withElement(building, trial);
            for (const forces of row.forces ?? []) {
              const verdict = connectionCheck(
                current,
                trialBuilding,
                trial,
                forces.moment,
                forces.shear,
              );
              if (verdict === null) {
                feasible = false;
                break;
              }
              worst = Math.max(worst, verdict.utilisation);
            }
            if (!feasible) break;
          }
          if (!feasible) continue;
          if (best === null || worst < best.worst) best = { rows: boltRows, diameter, worst };
          if (worst <= targetUtilisation) {
            chosen = { rows: boltRows, diameter };
            break search;
          }
        }
      }
      if (!chosen && best) {
        limited = true;
        chosen = { rows: best.rows, diameter: best.diameter };
      }
      if (!chosen) continue;
      changes.push(`${kind} connections: ${chosen.rows * 2} × M${chosen.diameter}`);
      for (const row of targets) {
        const original = building.elements[row.elementId] as MomentConnectionElement;
        if (
          original.boltRows === chosen.rows &&
          original.boltDiameter === fromMm(current, chosen.diameter)
        ) {
          continue;
        }
        building = withElement(building, {
          ...original,
          boltRows: chosen.rows,
          boltDiameter: fromMm(current, chosen.diameter),
        });
        changed.add(original.id);
      }
    }
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
  const shift = (point: Vec3, by: Vec3): Vec3 => [
    point[0] + by[0],
    point[1] + by[1],
    point[2] + by[2],
  ];
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
      if (frame && element.role === 'purlin')
        offset = [frame.v[0] * half, frame.v[1] * half, frame.v[2] * half];
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
        ? { ...element, start: shift(element.start, by) }
        : { ...element, end: shift(element.end, by) }
      : { ...element, start: shift(element.start, by), end: shift(element.end, by) };
    next = withElement(next, updated);
    moved.push(element.id);
  }
  return { building: next, moved };
}

/** Bolt rows at least 2.2 d0 apart (EN 1993-1-8 Tab. 3.3; d0 = d + 2 mm up to M24, + 3 mm above). */
function rowSpacingOk(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  connection: MomentConnectionElement,
): boolean {
  if (connection.boltRows < 2) return true;
  const solids = buildingConnectionSolids(doc, building, connection);
  if (!solids) return false;
  const diameter = connection.boltDiameter / fromMm(doc, 1);
  const hole = fromMm(doc, diameter + (diameter <= 24 ? 2 : 3));
  const ys = [
    ...new Set(
      solids
        .filter((solid) => solid.part.startsWith('bolt') && solid.part.endsWith('-l'))
        .map((solid) => {
          const values = solid.outline.map(([, y]) => y);
          return (Math.min(...values) + Math.max(...values)) / 2;
        }),
    ),
  ].sort((a, b) => a - b);
  return ys.every((y, index) => index === 0 || y - (ys[index - 1] as number) >= 2.2 * hole);
}
