import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { buildingErrors } from '@aec/validate';
import type { FrameReport } from '@aec/industrial/steelFrameAnalysis';
import {
  check as baseCheck,
  rowOf,
  step,
  twoLevels,
  withMember,
  type CheckData,
} from './steelFixtures';
import {
  frameColumn,
  inertiaOf,
  jointBeam,
  memberOf,
  portal,
  weightOf,
} from './steelFrameFixtures';

interface FrameData extends CheckData {
  frames: FrameReport[];
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}): FrameData =>
  baseCheck(doc, params) as FrameData;

describe('joint fixity on add_steel_member / update_steel_member', () => {
  const base = (): CadDocument => twoLevels();

  it('stores startJoint / endJoint on a beam and baseFixity on a column', () => {
    let doc = frameColumn(base(), 0, 0, { baseFixity: 'fixed' });
    doc = jointBeam(doc, [0, 0], [0, 6000], { startJoint: 'rigid', endJoint: 'pinned' });
    expect(memberOf(doc, 'SC1').baseFixity).toBe('fixed');
    expect(memberOf(doc, 'SB1').startJoint).toBe('rigid');
    expect(memberOf(doc, 'SB1').endJoint).toBe('pinned');
    expect(buildingErrors(doc.building)).toEqual([]);
    const result = execute(base(), 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, 0],
      end: [0, 6000, 0],
      levelId: 'level-2',
      startJoint: 'rigid',
      endJoint: 'rigid',
    });
    expect(result.summary).toContain('rigid start joint, rigid end joint');
    expect(result.affected).toContain('member-1');
  });

  it('keeps old members valid and defaults to pinned', () => {
    const doc = jointBeam(base(), [0, 0], [0, 6000]);
    const member = memberOf(doc, 'SB1');
    expect(member.startJoint).toBeUndefined();
    expect(member.endJoint).toBeUndefined();
    expect(buildingErrors(doc.building)).toEqual([]);
  });

  it('rejects joints on a non-beam and baseFixity on a non-column (no-op)', () => {
    const doc = base();
    const column = execute(doc, 'add_steel_member', {
      role: 'column',
      profile: 'HEB200',
      start: [0, 0, 0],
      end: [0, 0, 3000],
      levelId: 'level-1',
      startJoint: 'rigid',
    });
    expect(column.document).toBe(doc);
    expect(column.affected).toEqual([]);
    expect(column.summary).toContain('startJoint / endJoint apply to beams');
    const beam = execute(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, 0],
      end: [0, 6000, 0],
      levelId: 'level-2',
      baseFixity: 'fixed',
    });
    expect(beam.document).toBe(doc);
    expect(beam.summary).toContain('baseFixity applies to columns');
    const bad = execute(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, 0],
      end: [0, 6000, 0],
      endJoint: 'welded',
    });
    expect(bad.document).toBe(doc);
    expect(bad.summary).toContain('add_steel_member rejected: invalid params');
  });

  it('updates the joints and the base, and drops them when the role changes', () => {
    let doc = frameColumn(base(), 0, 0);
    doc = jointBeam(doc, [0, 0], [0, 6000], { startJoint: 'rigid' });
    const beamId = memberOf(doc, 'SB1').id;
    const columnId = memberOf(doc, 'SC1').id;
    const joint = execute(doc, 'update_steel_member', { memberId: beamId, endJoint: 'rigid' });
    expect(memberOf(joint.document, 'SB1').startJoint).toBe('rigid');
    expect(memberOf(joint.document, 'SB1').endJoint).toBe('rigid');
    const unjoint = execute(joint.document, 'update_steel_member', {
      memberId: beamId,
      startJoint: 'pinned',
    });
    expect(memberOf(unjoint.document, 'SB1').startJoint).toBe('pinned');
    expect(memberOf(unjoint.document, 'SB1').endJoint).toBe('rigid');
    const foot = execute(doc, 'update_steel_member', { memberId: columnId, baseFixity: 'fixed' });
    expect(memberOf(foot.document, 'SC1').baseFixity).toBe('fixed');
    const brace = execute(joint.document, 'update_steel_member', {
      memberId: beamId,
      role: 'brace',
    });
    expect(brace.document).not.toBe(joint.document);
    const braced = Object.values(brace.document.building!.elements).find(
      (element) => element.category === 'member' && element.role === 'brace',
    ) as unknown as Record<string, unknown>;
    expect(braced['startJoint']).toBeUndefined();
    expect(braced['endJoint']).toBeUndefined();
    const refused = execute(doc, 'update_steel_member', { memberId: columnId, endJoint: 'rigid' });
    expect(refused.document).toBe(doc);
    expect(refused.summary).toContain('apply to beams');
  });

  it('flags an invalid stored joint in a loaded document', () => {
    const doc = jointBeam(base(), [0, 0], [0, 6000], { startJoint: 'rigid' });
    const member = memberOf(doc, 'SB1');
    const broken = {
      ...doc.building!,
      elements: { ...doc.building!.elements, [member.id]: { ...member, endJoint: 'welded' } },
    };
    expect(buildingErrors(broken).join(' ')).toContain('endJoint must be pinned or rigid');
  });
});

describe('rigid joints that cannot be modelled', () => {
  const row = (doc: CadDocument, mark: string): ReturnType<typeof rowOf> => rowOf(check(doc), mark);

  it('rejects a rigid joint to nothing: the beam is not analysed with the reason', () => {
    let doc = frameColumn(twoLevels(), 0, 0, { baseFixity: 'fixed' });
    doc = jointBeam(doc, [0, 0], [0, 6000], { startJoint: 'rigid', endJoint: 'rigid' });
    const data = check(doc);
    const beam = rowOf(data, 'SB1');
    expect(beam.analysed).toBe(false);
    expect(beam.ok).toBe(false);
    expect(beam.detail).toContain('end joint is rigid but the beam bears on nothing');
    expect(data.ok).toBe(false);
    expect(data.warnings.some((text) => text.startsWith('SB1: end joint is rigid'))).toBe(true);
    expect(data.frames).toEqual([]);
  });

  it('rejects a rigid joint into another beam and a pinned end of a frame beam on a beam', () => {
    let doc = portal({ base: 'fixed' });
    doc = frameColumn(doc, -4000, 3000, { baseFixity: 'fixed' });
    doc = jointBeam(doc, [-4000, 3000], [0, 3000], { startJoint: 'rigid', endJoint: 'rigid' });
    expect(row(doc, 'SB2').detail).toContain(
      'end joint is rigid but the beam frames into beam SB1',
    );
    let pinnedEnd = portal({ base: 'fixed' });
    pinnedEnd = frameColumn(pinnedEnd, -4000, 3000, { baseFixity: 'fixed' });
    pinnedEnd = jointBeam(pinnedEnd, [-4000, 3000], [0, 3000], { startJoint: 'rigid' });
    expect(row(pinnedEnd, 'SB2').detail).toContain(
      'the pinned end of a moment-frame beam must bear on',
    );
    // The portal itself is still analysed.
    expect(row(pinnedEnd, 'SB1').analysed).toBe(true);
  });

  it('rejects a rigid beam that is not in an X or Y vertical plane', () => {
    let doc = frameColumn(twoLevels(), 0, 0, { baseFixity: 'fixed' });
    doc = frameColumn(doc, 4000, 4000, { baseFixity: 'fixed' });
    doc = jointBeam(doc, [0, 0], [4000, 4000], { startJoint: 'rigid', endJoint: 'rigid' });
    expect(row(doc, 'SB1').detail).toContain('vertical plane parallel to X or Y');
  });

  it('gives a column to one frame plane only: the second plane is not modelled', () => {
    let doc = portal({ base: 'fixed' });
    doc = frameColumn(doc, 6000, 0, { baseFixity: 'fixed', roll: 0 });
    doc = jointBeam(doc, [0, 0], [6000, 0], { startJoint: 'rigid', endJoint: 'rigid' });
    const data = check(doc);
    expect(rowOf(data, 'SB2').detail).toContain('already belongs to frame x = 0.00 m');
    expect(rowOf(data, 'SB1').analysed).toBe(true);
    expect(data.frames).toHaveLength(1);
  });

  it('reports a beam with no length between its columns', () => {
    let doc = frameColumn(twoLevels(), 0, 0, { baseFixity: 'fixed' });
    doc = jointBeam(doc, [0, 0], [0, 100], { startJoint: 'rigid', endJoint: 'rigid' });
    const data = check(doc);
    expect(rowOf(data, 'SB1').detail).toContain('no length between the columns');
    expect(data.warnings.some((text) => text.includes('no length between the columns'))).toBe(true);
  });

  it('flags a mechanism: pinned-base column with a rigid cantilever beam', () => {
    let doc = frameColumn(twoLevels(), 0, 0);
    doc = jointBeam(doc, [0, 0], [0, 3000], { startJoint: 'rigid' });
    const data = check(doc);
    expect(data.frames[0]?.status).toBe('mechanism');
    for (const mark of ['SC1', 'SB1']) {
      const entry = rowOf(data, mark);
      expect(entry.analysed).toBe(false);
      expect(entry.ok).toBe(false);
      expect(entry.detail).toContain('mechanism');
    }
    expect(data.warnings.some((text) => text.includes('is a mechanism'))).toBe(true);
    expect(data.ok).toBe(false);
    // The notional force of the storey is not carried by any frame.
    expect(data.warnings.some((text) => text.includes('no bracing in direction Y'))).toBe(true);
  });
});

describe('member rows of a frame', () => {
  it('checks a fixed-base cantilever beam against 2L/250 with the root deflection', () => {
    let doc = frameColumn(twoLevels(), 0, 0, { baseFixity: 'fixed' });
    doc = jointBeam(doc, [0, 0], [0, 3000], { startJoint: 'rigid' });
    const data = check(doc);
    const beam = rowOf(data, 'SB1');
    expect(beam.analysed).toBe(true);
    expect(beam.checks.map((entry) => entry.name)).toContain('deflection (cantilever 2L/250)');
    const tip = (weightOf('IPE300') * 3000 ** 4) / 1000 / (8 * 210000 * inertiaOf('IPE300'));
    expect(beam.forces['deflection']).toBeGreaterThanOrEqual(tip * 0.99);
    expect(beam.forces['jointMomentStart']).toBeLessThan(0);
    expect(beam.forces['jointMomentEnd']).toBeUndefined();
    expect(data.warnings.some((text) => text.includes('SB1 end rests on no column or beam'))).toBe(
      true,
    );
  });

  it('is independent of the direction the beam is drawn', () => {
    type Joint = 'rigid' | 'pinned';
    const drawn = (
      from: [number, number],
      to: [number, number],
      start: Joint,
      end: Joint,
    ): ReturnType<typeof rowOf> => {
      let doc = frameColumn(twoLevels(), 0, 0, { baseFixity: 'fixed' });
      doc = frameColumn(doc, 0, 6000, { baseFixity: 'pinned' });
      doc = jointBeam(doc, from, to, { startJoint: start, endJoint: end });
      return rowOf(check(doc), 'SB1');
    };
    const forward = drawn([0, 0], [0, 6000], 'rigid', 'pinned');
    const backward = drawn([0, 6000], [0, 0], 'pinned', 'rigid');
    expect(forward.utilisation).toBeCloseTo(backward.utilisation, 6);
    expect(forward.forces['MEd']).toBeCloseTo(backward.forces['MEd'] ?? 0, 6);
    expect(forward.forces['jointMomentStart']).toBeCloseTo(
      backward.forces['jointMomentEnd'] ?? 0,
      6,
    );
    expect(forward.forces['jointMomentStart']).toBeLessThan(0);
    // A pinned end carries no moment: the propped beam has M ≈ wL²/8 at the rigid end at most.
    expect(forward.forces['jointMomentEnd']).toBeUndefined();
  });

  it('analyses a frame in a plane y = const (resists X) like the same frame in x = const', () => {
    let doc = twoLevels();
    for (const x of [0, 6000]) doc = frameColumn(doc, x, 0, { baseFixity: 'fixed', roll: 0 });
    doc = jointBeam(doc, [0, 0], [6000, 0], { startJoint: 'rigid', endJoint: 'rigid' });
    const data = check(doc);
    expect(data.frames[0]?.direction).toBe('X');
    const reference = check(portal({ base: 'fixed' }));
    expect(rowOf(data, 'SB1').utilisation).toBeCloseTo(rowOf(reference, 'SB1').utilisation, 6);
    expect(rowOf(data, 'SC1').forces['baseMoment']).toBeCloseTo(
      rowOf(reference, 'SC1').forces['baseMoment'] ?? 0,
      6,
    );
  });

  it('bends the weak axis when the column depth lies along the frame plane normal', () => {
    const strong = rowOf(check(portal({ base: 'fixed' })), 'SC1');
    const weak = rowOf(check(portal({ base: 'fixed', columnRoll: 0 })), 'SC1');
    expect(strong.detail).toContain('strong axis');
    expect(weak.detail).toContain('weak axis');
    expect(weak.utilisation).toBeGreaterThan(strong.utilisation);
    // Weak-axis frame stiffness: the column draws less moment from the stiff beam.
    expect(weak.forces['baseMoment']).toBeLessThan(strong.forces['baseMoment'] ?? 0);
  });

  it('refuses a roll between the principal axes and unsupported column shapes', () => {
    const skew = check(portal({ base: 'fixed', columnRoll: 0.6 }));
    expect(rowOf(skew, 'SC1').analysed).toBe(false);
    expect(rowOf(skew, 'SC1').detail).toContain('lies between the principal axes');
    expect(rowOf(skew, 'SB1').analysed).toBe(true);
    const channel = check(portal({ base: 'fixed', columnProfile: 'UPN200' }));
    expect(rowOf(channel, 'SC1').analysed).toBe(false);
    expect(rowOf(channel, 'SC1').detail).toContain('not covered');
    const slender = withMember(portal({ base: 'fixed' }), 'SC1', {
      profile: 'CHS139.7x5',
      material: 'S960',
    });
    const class4 = rowOf(check(slender), 'SC1');
    expect(class4.analysed).toBe(false);
    expect(class4.detail).toContain('class 4');
    const weakProfile = check(portal({ base: 'fixed', beamProfile: 'UPN200' }));
    expect(rowOf(weakProfile, 'SB1').analysed).toBe(false);
    const hollow = check(portal({ base: 'fixed', columnProfile: 'SHS150x8', columnRoll: 0.6 }));
    expect(rowOf(hollow, 'SC1').analysed).toBe(true);
  });

  it('applies the sway limit parameter and rejects a bad one', () => {
    const doc = portal({ base: 'pinned' });
    const loose = rowOf(check(doc), 'SC1');
    const tight = rowOf(check(doc, { swayRatio: 1e7 }), 'SC1');
    const named = tight.checks.find((entry) => entry.name.startsWith('sway h/'));
    expect(named?.name).toBe('sway h/10000000');
    expect(named?.utilisation).toBeGreaterThan(1);
    expect(loose.checks.find((entry) => entry.name === 'sway h/300')?.utilisation).toBeLessThan(1);
    const rejected = execute(doc, 'check_steel_members', { swayRatio: 0 });
    expect(rejected.document).toBe(doc);
    expect(rejected.data).toBeUndefined();
    expect(rejected.summary).toContain('swayRatio');
  });
});

describe('loads on a frame', () => {
  it('takes beams framing into a frame beam as point loads and extra column nodes', () => {
    const base = check(portal({ base: 'fixed' }), { notionalFactor: 0 });
    let doc = portal({ base: 'fixed' });
    // Secondary beam framing into the middle of the frame beam, carried at its far end by a column.
    doc = frameColumn(doc, -4000, 3000, { baseFixity: 'pinned' });
    doc = jointBeam(doc, [-4000, 3000], [0, 3000]);
    // A landing beam into the frame column at mid height (extra node on the column).
    doc = step(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE200',
      start: [0, 0, 1500],
      end: [3000, 0, 1500],
      levelId: 'level-1',
    });
    const data = check(doc, { notionalFactor: 0 });
    const secondary = (1.35 * weightOf('IPE300') * 4) / 2;
    const landing = (1.35 * weightOf('IPE200') * 3) / 2;
    const gain = (rowOf(data, 'SC1').forces['NEd'] ?? 0) - (rowOf(base, 'SC1').forces['NEd'] ?? 0);
    // SC1 (y = 0): half the secondary reaction through the frame beam + the landing beam reaction.
    expect(gain).toBeGreaterThan(secondary / 2 + landing - 0.2);
    expect(gain).toBeLessThan(secondary / 2 + landing + 0.2);
    expect(rowOf(data, 'SB1').forces['MEd']).toBeGreaterThan(rowOf(base, 'SB1').forces['MEd'] ?? 0);
  });

  it('checks the hogging end with LTB over the hogging length when a floor restrains the top flange', () => {
    let doc = portal({ base: 'fixed' });
    doc = step(doc, 'add_slab', {
      levelId: 'level-2',
      boundary: [
        [-3000, 0],
        [3000, 0],
        [3000, 6000],
        [-3000, 6000],
      ],
      thickness: 30,
      material: 'grating',
    });
    const beam = rowOf(check(doc), 'SB1');
    expect(beam.analysed).toBe(true);
    expect(beam.forces['jointMomentStart']).toBeLessThan(0);
    const interaction = beam.checks.find((entry) => entry.name === 'frame N+M (§6.3.3)');
    expect(interaction?.utilisation).toBeGreaterThan(0);
    expect(beam.detail).toBeTruthy();
  });
});
