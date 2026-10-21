import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { BasePlateElement } from '@aec/building/types';
import { execute } from '@core/commands/registry';
import { framesOf } from '@aec/industrial/frames/frameModelFrames';
import { solveCombination } from '@aec/industrial/frames/frameModelSolve';
import type { FrameLoads } from '@aec/industrial/frames/frameModelTypes';
import { stifferProfile } from '@aec/industrial/frames/frameDesignLoop';
import { nextProfile } from '@aec/industrial/common/profileGroups';
import { findProfile, sectionProperties } from '@aec/steel/profiles';
import { E_STEEL } from '@aec/industrial/steelDesign/steelDesign';
import { HALL, hall } from './hallFixtures';

const LOADS: FrameLoads = { deadLoad: 0.5, snowLoad: 0.8, windPressure: 0.7 };
const CRANE_HALL = { ...HALL, crane: { capacity: 10, railHeight: 6000 } };
const inertia = (name: string): number => sectionProperties(findProfile(name)!).inertia;

const plates = (doc: CadDocument): BasePlateElement[] =>
  Object.values(doc.building!.elements).filter((element): element is BasePlateElement => element.category === 'plate');

/** Steel mass (kg) of all columns and rafters (mm model). */
const frameKg = (doc: CadDocument): number =>
  Object.values(doc.building!.elements).reduce((sum, element) => {
    if (element.category !== 'member' || (element.role !== 'column' && element.role !== 'rafter')) return sum;
    const metres =
      Math.hypot(element.end[0] - element.start[0], element.end[1] - element.start[1], element.end[2] - element.start[2]) / 1000;
    return sum + metres * findProfile(element.profile)!.massPerMetre;
  }, 0);

/** Rail-level sway (mm) of the first frame under 10 kN horizontal at each crane bracket, with the closed-form portal values. */
function railSway(doc: CadDocument): { solver: number; fixed: number; pinned: number } {
  const building = doc.building!;
  const frame = framesOf(doc, building, building.levelOrder[0]!, LOADS).frames[0]!;
  const forces = frame.craneNodes.map((crane) => ({ node: crane.node, fx: 10_000 }));
  const solver = Math.abs(solveCombination(frame, {}, forces)!.displacements[frame.craneNodes[0]!.node]![0]);
  const members = Object.values(building.elements).flatMap((element) => (element.category === 'member' ? [element] : []));
  const column = members.find((member) => member.id === frame.craneNodes[0]!.elementId)!;
  const rafter = members.find((member) => member.role === 'rafter')!;
  const [Ic, Ib] = [inertia(column.profile), inertia(rafter.profile)];
  const [h, a] = [Math.abs(column.end[2] - column.start[2]), frame.craneNodes[0]!.height];
  const halfRafter = Math.hypot(rafter.end[0] - rafter.start[0], rafter.end[2] - rafter.start[2]);
  // Antisymmetric sway: the rafter restrains the eaves joint rotation like a propped cantilever, K = 3 E Ib / (half rafter).
  const [EI, K, P] = [E_STEEL * Ic, (3 * E_STEEL * Ib) / halfRafter, 10_000];
  const thetaP = (P * a * a) / (2 * EI);
  const topMoment = (K * thetaP) / (1 + (K * h) / EI);
  const fixed = (P * a ** 3) / (3 * EI) - (topMoment * a * a) / (2 * EI);
  // Pinned foot: curvature -P y / EI below the load, -P a / EI above; rotation at the foot from the restrained eaves joint.
  const thetaBase = (P * a) / K + (P * a * (2 * h - a)) / (2 * EI);
  const pinned = thetaBase * a - (P * a ** 3) / (6 * EI);
  return { solver, fixed, pinned };
}

describe('stiffness-driven column step', () => {
  it('picks the lightest HEA / HEB section with the asked inertia gain', () => {
    expect(stifferProfile('HEA400', 2)).toBe('HEA550');
    expect(inertia('HEA550')).toBeGreaterThanOrEqual(2 * inertia('HEA400'));
    expect(stifferProfile('HEA400', 1)).toBe('HEA450');
    expect(inertia(stifferProfile('HEA400', 100)!)).toBeGreaterThanOrEqual(2.5 * inertia('HEA400'));
  });
  it('falls back to the next heavier profile for non-I sections and at the top of the catalogue', () => {
    expect(stifferProfile('CHS76.1x3.6', 2)).toBe(nextProfile('CHS76.1x3.6'));
    expect(findProfile('HEB700')).toMatchObject({ h: 700, massPerMetre: 241 });
    expect(stifferProfile('HEB700', 2)).toBe(nextProfile('HEB700'));
  });
});

describe('portal frame sway against the closed-form portal formulas', () => {
  it('matches the fixed-base and pinned-base rail-level sway of the default hall within 1 %', () => {
    // The closed forms are for prismatic rafters: no eaves haunch.
    const prismatic = { ...CRANE_HALL, haunch: { eavesLength: 0 } };
    const fixed = railSway(hall({ ...prismatic, columnBase: 'fixed' }));
    expect(fixed.solver).toBeGreaterThan(0);
    expect(Math.abs(fixed.solver / fixed.fixed - 1)).toBeLessThan(0.01);
    const pinned = railSway(hall(prismatic));
    expect(Math.abs(pinned.solver / pinned.pinned - 1)).toBeLessThan(0.01);
    expect(pinned.solver).toBeGreaterThan(3 * fixed.solver);
  });
  it('sways less with the default 10 % eaves haunches, which stiffen the eaves joint (stiffer rafter restraint)', () => {
    const plain = railSway(hall({ ...CRANE_HALL, haunch: { eavesLength: 0 } }));
    const haunched = railSway(hall(CRANE_HALL));
    expect(haunched.solver).toBeLessThan(plain.solver);
    expect(haunched.solver).toBeGreaterThan(0.8 * plain.solver);
  });
});

describe('design_portal_frames sway-driven design', () => {
  const params = { windPressure: 0.7 };
  it('fixes the bases of a crane hall whose pinned design is sway-governed, lighter and passing', () => {
    const doc = hall(CRANE_HALL);
    expect(plates(doc).every((plate) => plate.fixity !== 'fixed')).toBe(true);
    const pinnedKept = execute(doc, 'design_portal_frames', { ...params, allowFixedBases: false });
    const auto = execute(doc, 'design_portal_frames', params);
    expect(auto.summary).toMatch(/column bases pinned → fixed \(\d+ plate\(s\)\)/);
    expect(auto.summary).toMatch(/Sway governed the pinned-base design/);
    expect(plates(auto.document).filter((plate) => plate.fixity === 'fixed').length).toBeGreaterThan(0);
    expect(plates(pinnedKept.document).every((plate) => plate.fixity !== 'fixed')).toBe(true);
    expect(frameKg(auto.document)).toBeLessThan(0.75 * frameKg(pinnedKept.document));
    const check = execute(auto.document, 'check_portal_frames', params);
    expect((check.data as { maxUtilisation: number }).maxUtilisation).toBeLessThanOrEqual(0.95);
    expect(check.summary).toMatch(/all OK/);
  }, 120_000);
  it('keeps the modelled fixity with allowFixedBases false and leaves non-sway halls pinned', () => {
    const quiet = execute(hall(), 'design_portal_frames', {});
    expect(plates(quiet.document).every((plate) => plate.fixity !== 'fixed')).toBe(true);
    expect(quiet.summary).not.toMatch(/pinned → fixed/);
  }, 120_000);
});
