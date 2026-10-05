import type { CadDocument } from '@core/model/types';
import type { SteelMemberElement } from '@core/model/building';
import { findProfile, sectionProperties } from '@aec/steel/profiles';
import { G, step, twoLevels } from './steelFixtures';

/** Self weight of a catalogue profile, kN/m. */
export const weightOf = (profile: string): number =>
  ((findProfile(profile)?.massPerMetre ?? 0) * G) / 1000;

/** Strong-axis second moment of area of a catalogue profile, mm⁴. */
export const inertiaOf = (profile: string): number => {
  const found = findProfile(profile);
  if (!found) throw new Error(profile);
  return sectionProperties(found).inertia;
};

/** Beam axis height under a floor at +3000: top of steel 30 mm below the floor. */
export const AXIS = -180;
/** Level 1 column top, beam axes at 2820. */
export const BEAM_Z = 3000 + AXIS;

/** Column at (x, y) from 0 to `top` on level 1, strong axis along Y (roll π/2) unless given. */
export function frameColumn(
  doc: CadDocument,
  x: number,
  y: number,
  options: {
    profile?: string;
    top?: number;
    roll?: number;
    baseFixity?: 'pinned' | 'fixed';
  } = {},
): CadDocument {
  const { profile = 'HEB200', top = 3000, roll = Math.PI / 2, baseFixity } = options;
  return step(doc, 'add_steel_member', {
    role: 'column',
    profile,
    start: [x, y, 0],
    end: [x, y, top],
    levelId: 'level-1',
    roll,
    ...(baseFixity ? { baseFixity } : {}),
  });
}

/** Beam between two plan points at level `levelId` (axis 180 mm below the level) with joints. */
export function jointBeam(
  doc: CadDocument,
  from: [number, number],
  to: [number, number],
  options: {
    profile?: string;
    levelId?: string;
    z?: number;
    startJoint?: 'pinned' | 'rigid';
    endJoint?: 'pinned' | 'rigid';
  } = {},
): CadDocument {
  const { profile = 'IPE300', levelId = 'level-2', z = AXIS, startJoint, endJoint } = options;
  return step(doc, 'add_steel_member', {
    role: 'beam',
    profile,
    start: [...from, z],
    end: [...to, z],
    levelId,
    ...(startJoint ? { startJoint } : {}),
    ...(endJoint ? { endJoint } : {}),
  });
}

/** Single-bay portal in the plane x = 0: columns at y = 0 and y = span, rigid beam at +2820. */
export function portal(
  options: {
    span?: number;
    /** 'plate': the columns declare no baseFixity (the base plate decides). */
    base?: 'pinned' | 'fixed' | 'plate';
    columnProfile?: string;
    beamProfile?: string;
    columnRoll?: number;
    startJoint?: 'pinned' | 'rigid';
    endJoint?: 'pinned' | 'rigid';
  } = {},
): CadDocument {
  const {
    span = 6000,
    base = 'pinned',
    columnProfile,
    beamProfile,
    columnRoll,
    startJoint = 'rigid',
    endJoint = 'rigid',
  } = options;
  let doc = twoLevels();
  for (const y of [0, span]) {
    doc = frameColumn(doc, 0, y, {
      ...(base === 'plate' ? {} : { baseFixity: base }),
      ...(columnProfile ? { profile: columnProfile } : {}),
      ...(columnRoll !== undefined ? { roll: columnRoll } : {}),
    });
  }
  return jointBeam(doc, [0, 0], [0, span], {
    startJoint,
    endJoint,
    ...(beamProfile ? { profile: beamProfile } : {}),
  });
}

/** The stored member with this mark. */
export function memberOf(doc: CadDocument, mark: string): SteelMemberElement {
  const found = Object.values(doc.building?.elements ?? {}).find(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.mark === mark,
  );
  if (!found) throw new Error(`no member ${mark}`);
  return found;
}
