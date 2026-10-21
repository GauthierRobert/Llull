/** Iterative sizing loop of design_portal_frames: sway-driven column stiffening, rafter strength up-sizing, pinned / fixed base variants. */
import type { BuildingModel } from '@aec/building/types';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { elementsOf, getBuilding, withElement } from '../../building/model';
import { findProfile, lightestProfile, sectionProperties } from '../../steel/profiles';
import {
  addProfileGroup,
  iterateUpsizing,
  nextProfile,
  resizeProfileGroup,
  upsizeProfileGroups,
  type ProfileGroups,
} from '../common/profileGroups';
import { refitPlates } from '../connections/plateSupport';
import { checkFrames } from './frameCheckFrames';
import type { CheckRow } from './frameCheckSolve';
import type { FrameLoads } from './frameModelTypes';
import { reseatDependents } from './frameReseat';
import { tryLongerHaunch } from './haunchDesign';

/** Haunch trials (one frame check each) per sizing run. */
const MAX_HAUNCH_TRIALS = 3;

/** Largest stiffness gain asked of a column section in one iteration (the loop continues if it was not enough). */
const MAX_STIFFNESS_STEP = 2.5;

/** Smallest stiffness gain of a sway-driven column step. */
const MIN_STIFFNESS_STEP = 1.1;

const isSwayRow = (row: CheckRow): boolean => row.kind === 'stability' || (row.kind === 'deflection' && row.check.includes('sway'));

/**
 * Lightest section of the member's family (HEA / HEB share one pool) whose strong-axis inertia is at least `factor` times the current one
 * and which is heavier than it; the next heavier profile when none exists. Sway is stiffness driven (δ ∝ 1/I), so the step is chosen by
 * inertia per kilogram, not by the next catalogue size.
 */
export function stifferProfile(name: string, factor: number): string | null {
  const profile = findProfile(name);
  if (!profile || profile.shape !== 'I') return nextProfile(name);
  const required = sectionProperties(profile).inertia * Math.min(Math.max(factor, MIN_STIFFNESS_STEP), MAX_STIFFNESS_STEP);
  const families: ReadonlyArray<string> = profile.family === 'HEA' || profile.family === 'HEB' ? ['HEA', 'HEB'] : [profile.family];
  const stiffer = lightestProfile(
    (candidate) =>
      families.includes(candidate.family) &&
      candidate.massPerMetre > profile.massPerMetre &&
      sectionProperties(candidate).inertia >= required,
  );
  return stiffer?.name ?? nextProfile(name);
}

/** Observed sway utilisation falling less than this fraction of the requested stiffness gain means the rafters limit the sway too. */
const SLOW_SWAY_PROGRESS = 1.5;

export interface FrameSizing {
  current: CadDocument;
  changes: string[];
  changed: Set<string>;
  limited: boolean;
  analysed: Set<string>;
  noFrames: boolean;
  /** Rows of `current` when the loop ended because nothing exceeded the target; null otherwise (re-analyse). */
  settledRows: CheckRow[] | null;
  /** True when a sway / stability failure drove at least one iteration. */
  swayDriven: boolean;
}

/**
 * Repeats analyse → up-size until every row is within `target`. Strength / buckling failures up-size the failing member's profile group
 * (next heavier profile). Sway and stability failures are handled first, by stiffness: the columns go to the section whose inertia the
 * sway ratio asks for; when that gains less than expected (the rafters' rotational restraint limits the frame) the rafters are stiffened
 * the same way.
 */
export function sizeFrames(doc: CadDocument, levelId: string, loads: FrameLoads, target: number): FrameSizing {
  const analysed = new Set<string>();
  let noFrames = false;
  let settledRows: CheckRow[] | null = null;
  let swayDriven = false;
  let rafterAssist = false;
  let previous: { utilisation: number; factor: number } | null = null;
  let haunchTrials = 0;
  const upsized = iterateUpsizing(doc, (current) => {
    const { rows, frames } = checkFrames(current, levelId, loads);
    noFrames = frames === 0;
    settledRows = null;
    if (noFrames) return null;
    const building = getBuilding(current);
    for (const row of rows) if (row.kind !== 'connection') analysed.add(row.elementId);
    const groups: ProfileGroups = new Map();
    const stiffening = new Map<string, number>();
    const addGroup = (elementId: string): void => {
      const member = building.elements[elementId];
      if (member?.category === 'member') addProfileGroup(groups, member);
    };
    const failing = rows.filter((row) => row.kind !== 'connection' && row.utilisation > target);
    // Sway amplifies every moment: stiffen first and re-analyse before sizing members for strength.
    const swayRows = failing.filter(isSwayRow);
    const swayFirst = swayRows.length > 0;
    if (swayFirst) {
      swayDriven = true;
      const worst = Math.max(...swayRows.map((row) => row.utilisation));
      if (previous && worst > (previous.utilisation / previous.factor) * SLOW_SWAY_PROGRESS) rafterAssist = true;
      const factor = Math.min(worst / target, MAX_STIFFNESS_STEP);
      previous = { utilisation: worst, factor };
      for (const row of swayRows) {
        const column = building.elements[row.elementId];
        if (column?.category !== 'member') continue;
        addGroup(row.elementId);
        stiffening.set(`column:${column.profile}`, Math.max(stiffening.get(`column:${column.profile}`) ?? 0, row.utilisation / target));
        if (rafterAssist || stifferProfile(column.profile, row.utilisation / target) === null) {
          for (const other of rows) {
            if (other.frame !== row.frame || other.kind !== 'rafter') continue;
            addGroup(other.elementId);
            const rafter = building.elements[other.elementId];
            if (rafter?.category === 'member')
              stiffening.set(
                `rafter:${rafter.profile}`,
                Math.max(stiffening.get(`rafter:${rafter.profile}`) ?? 0, row.utilisation / target),
              );
          }
        }
      }
    }
    // A longer eaves haunch is tried before the rafters are up-sized (strength, or sway the rafters limit too).
    if ((!swayFirst || rafterAssist) && haunchTrials < MAX_HAUNCH_TRIALS) {
      haunchTrials += 1;
      const haunch = tryLongerHaunch(current, failing, rows, target, (trial) => checkFrames(trial, levelId, loads).rows);
      if (haunch) return { ...haunch, progressed: true, limited: false };
    }
    if (!swayFirst) for (const row of failing) addGroup(row.elementId);
    if (groups.size === 0) {
      settledRows = rows;
      return null;
    }
    const nextSize = (profile: string, role: string): string | null => {
      const factor = stiffening.get(`${role}:${profile}`);
      return factor === undefined ? nextProfile(profile) : stifferProfile(profile, factor);
    };
    return upsizeProfileGroups(building, groups, nextSize, (next, group, larger) => {
      const resizedGroup = resizeProfileGroup(
        next,
        group,
        larger,
        (element) => analysed.has(element.id),
        (building, resized) => refitPlates(current, withElement(building, resized), resized, group.profile).building,
      );
      const { resizedIds } = resizedGroup;
      const reseated = reseatDependents(current, resizedGroup.building, resizedIds, group.profile, larger, analysed);
      return { building: reseated.building, changedIds: [...resizedIds, ...reseated.moved] };
    });
  });
  return { ...upsized, analysed, noFrames, settledRows, swayDriven };
}

/** Base plates of the analysed frame columns of the level that are not yet fixed. */
function pinnedFramePlates(building: BuildingModel, levelId: string, columnIds: ReadonlySet<string>): string[] {
  return elementsOf(building, 'plate')
    .filter((plate) => plate.levelId === levelId && columnIds.has(plate.memberId) && plate.fixity !== 'fixed')
    .map((plate) => plate.id);
}

/** `doc` with the base plates of its frame columns fixed (ids of the changed plates alongside); null when there is none to fix. */
export function withFixedBases(
  doc: CadDocument,
  levelId: string,
  columnIds: ReadonlySet<string>,
): { doc: CadDocument; plateIds: string[] } | null {
  const building = getBuilding(doc);
  const plateIds = pinnedFramePlates(building, levelId, columnIds);
  if (plateIds.length === 0) return null;
  let next = building;
  for (const id of plateIds) {
    const plate = building.elements[id];
    if (plate?.category === 'plate') next = withElement(next, { ...plate, fixity: 'fixed' });
  }
  return { doc: { ...doc, building: next }, plateIds };
}

/** Unmet checks (connections excluded: their bolts are sized afterwards) and worst utilisation among `rows`. */
export function scoreRows(rows: ReadonlyArray<CheckRow>, target: number): { failing: number; max: number } {
  const frameRows = rows.filter((row) => row.kind !== 'connection');
  return {
    failing: frameRows.filter((row) => row.utilisation > target).length,
    max: Math.max(0, ...frameRows.map((row) => row.utilisation)),
  };
}

/** Steel mass (kg) of the analysed frame columns and rafters of `doc`. */
export function frameMassKg(doc: CadDocument, analysed: ReadonlySet<string>): number {
  let kilograms = 0;
  for (const element of Object.values(getBuilding(doc).elements)) {
    if (element.category !== 'member' || !analysed.has(element.id) || (element.role !== 'column' && element.role !== 'rafter')) continue;
    const metres = toMetres(
      doc,
      Math.hypot(element.end[0] - element.start[0], element.end[1] - element.start[1], element.end[2] - element.start[2]),
    );
    kilograms += metres * (findProfile(element.profile)?.massPerMetre ?? 0);
  }
  return kilograms;
}
