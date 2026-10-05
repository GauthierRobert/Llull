import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { FrameReport } from '@aec/industrial/steelFrameAnalysis';
import { check as baseCheck, rowOf, step, twoLevels, type CheckData } from './steelFixtures';
import { BEAM_Z, frameColumn, inertiaOf, jointBeam, portal, weightOf } from './steelFrameFixtures';

interface FrameData extends CheckData {
  frames: FrameReport[];
  storeys: Array<{ shear: number; verticalLoad: number; frames: { X: number; Y: number } }>;
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}): FrameData =>
  baseCheck(doc, params) as FrameData;

/** Set the fixity of every base plate (add_base_plates itself leaves it pinned). */
function withPlateFixity(doc: CadDocument, fixity: 'pinned' | 'fixed'): CadDocument {
  const building = doc.building!;
  return {
    ...doc,
    building: {
      ...building,
      elements: Object.fromEntries(
        Object.entries(building.elements).map(([id, element]) => [
          id,
          element.category === 'plate' ? { ...element, fixity } : element,
        ]),
      ),
    },
  } as CadDocument;
}

const GAMMA = 1.35;
const NOTIONAL = 0.1;
const close = (actual: number | undefined, expected: number, tolerance = 0.02): void => {
  expect(Math.abs((actual ?? 0) - expected) / Math.abs(expected)).toBeLessThan(tolerance);
};

describe('single-bay portal vs the classical closed forms', () => {
  const [L, h] = [6000, BEAM_Z];
  const [wb, wc] = [weightOf('IPE300'), weightOf('HEB200')];
  const k = (inertiaOf('IPE300') / L / (inertiaOf('HEB200') / h)) as number;
  const q = GAMMA * wb;
  /** Horizontal force at the beam level: φ × factored vertical load there. */
  const H = NOTIONAL * GAMMA * (wb * (L / 1000) + 2 * wc * (h / 1000));

  it('fixed bases: base moment = qL²/(12(2+k)) from gravity + (H/2) h (1+3k)/(1+6k) from sway', () => {
    const data = check(portal({ base: 'fixed' }), { notionalFactor: NOTIONAL });
    const column = rowOf(data, 'SC1');
    expect(column.forces['amplification']).toBe(1);
    const gravity = (q * (L / 1000) ** 2) / (12 * (2 + k));
    const sway = ((H / 2) * (h / 1000) * (1 + 3 * k)) / (1 + 6 * k);
    close(column.forces['baseMoment'], gravity + sway);
    // Column shear is the sum of the sway shear H/2 and nothing from gravity at the base.
    expect(column.forces['VEd']).toBeGreaterThan(H / 2 - 0.5);
    expect(data.frames).toHaveLength(1);
    expect(data.frames[0]?.status).toBe('solved');
  });

  it('fixed bases: the beam joint moment is the beam end moment of the frame', () => {
    const data = check(portal({ base: 'fixed' }), { notionalFactor: NOTIONAL });
    const beam = rowOf(data, 'SB1');
    // Joint moments: gravity (hogging) ± the sway share (H/2) h 3k/(1+6k) at the top of the columns.
    const hogging = (q * (L / 1000) ** 2) / (6 * (2 + k));
    const sway = ((H / 2) * (h / 1000) * 3 * k) / (1 + 6 * k);
    const start = beam.forces['jointMomentStart'] ?? 0;
    const end = beam.forces['jointMomentEnd'] ?? 0;
    expect(start).toBeLessThan(0);
    expect(end).toBeLessThan(0);
    close(Math.max(Math.abs(start), Math.abs(end)), hogging + sway, 0.03);
    expect(data.frames[0]?.jointMoments['SB1 start']).toBe(start);
  });

  it('pinned bases: the column top moment is qL²/(4(2k+3)) + H h/2, base moment zero', () => {
    const data = check(portal({ base: 'pinned' }), { notionalFactor: NOTIONAL });
    const column = rowOf(data, 'SC1');
    const gravity = (q * (L / 1000) ** 2) / (4 * (2 * k + 3));
    close(column.forces['MEd'], gravity + (H / 2) * (h / 1000), 0.03);
    expect(column.forces['baseMoment']).toBeUndefined();
  });

  it('a stiffer beam and fixed bases shed column moment: fixed < pinned', () => {
    const fixed = rowOf(check(portal({ base: 'fixed' }), { notionalFactor: NOTIONAL }), 'SC1');
    const pinned = rowOf(check(portal({ base: 'pinned' }), { notionalFactor: NOTIONAL }), 'SC1');
    expect(fixed.forces['MEd']).toBeLessThan(pinned.forces['MEd'] ?? 0);
  });

  it('is pure and read-only', () => {
    const doc = portal({ base: 'fixed' });
    const before = JSON.stringify(doc);
    const result = execute(doc, 'check_steel_members', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.summary).toContain('3 member(s), 3 analysed');
  });

  it('row names follow the frame checks', () => {
    const data = check(portal({ base: 'fixed' }));
    const column = rowOf(data, 'SC1');
    const names = column.checks.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'frame N+M (§6.3.3)',
        'cross-section N+M (§6.2.9)',
        'shear (§6.2.6)',
        'sway h/300',
      ]),
    );
    const beam = rowOf(data, 'SB1');
    expect(beam.checks.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['frame N+M (§6.3.3)', 'deflection (L/250)']),
    );
  });
});

describe('two-storey bent with pinned bases', () => {
  const twoStorey = (): CadDocument => {
    let doc = twoLevels();
    doc = step(doc, 'add_level', {
      name: 'Roof',
      elevation: 6000,
      height: 3000,
      makeActive: false,
    });
    for (const y of [0, 6000]) doc = frameColumn(doc, 0, y, { top: 6000 });
    doc = jointBeam(doc, [0, 0], [0, 6000], { startJoint: 'rigid', endJoint: 'rigid' });
    return jointBeam(doc, [0, 0], [0, 6000], {
      levelId: 'level-3',
      startJoint: 'rigid',
      endJoint: 'rigid',
    });
  };

  it('carries the overturning of the notional forces by the column axial forces', () => {
    const [L, z1, z2] = [6, BEAM_Z, BEAM_Z + 3000];
    const [wb, wc] = [weightOf('IPE300'), weightOf('HEB200')];
    const v1 = GAMMA * (wb * L + 2 * wc * (z1 / 1000));
    const v2 = GAMMA * (wb * L + 2 * wc * ((z2 - z1) / 1000));
    const overturning = NOTIONAL * (v1 * (z1 / 1000) + v2 * (z2 / 1000));
    const data = check(twoStorey(), { notionalFactor: NOTIONAL });
    const column = rowOf(data, 'SC1');
    close(column.forces['NEd'], (v1 + v2) / 2 + overturning / L, 0.01);
    expect(data.frames[0]?.beams).toEqual(['SB1', 'SB2']);
    expect(data.storeys.map((storey) => storey.frames.Y)).toEqual([1, 1]);
    expect(data.warnings.some((text) => text.includes('direction Y'))).toBe(false);
    expect(data.warnings.filter((text) => text.includes('direction X'))).toHaveLength(2);
  });

  it('reports the elastic critical load factor of the frame and amplifies when αcr < 10', () => {
    const light = check(twoStorey());
    expect(light.frames[0]?.alphaCritical).toBeGreaterThan(10);
    expect(light.frames[0]?.amplification).toBe(1);
    // Slender columns under a loaded floor: 3 < αcr < 10 (4.6).
    let doc = twoLevels();
    for (const y of [0, 6000]) {
      doc = frameColumn(doc, 0, y, { profile: 'HEA140' });
    }
    doc = jointBeam(doc, [0, 0], [0, 6000], { startJoint: 'rigid', endJoint: 'rigid' });
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
    const heavy = check(doc);
    const alpha = heavy.frames[0]?.alphaCritical ?? Infinity;
    expect(alpha).toBeLessThan(10);
    expect(alpha).toBeGreaterThan(3);
    const amplification = heavy.frames[0]?.amplification ?? 1;
    expect(amplification).toBeCloseTo(1 / (1 - 1 / alpha), 6);
    expect(rowOf(heavy, 'SC1').forces['amplification']).toBeCloseTo(amplification, 3);
  });

  it('fails the critical column below αcr = 3', () => {
    let doc = twoLevels();
    for (const y of [0, 6000]) doc = frameColumn(doc, 0, y, { profile: 'IPE200' });
    doc = jointBeam(doc, [0, 0], [0, 6000], { startJoint: 'rigid', endJoint: 'rigid' });
    doc = step(doc, 'add_equipment', {
      name: 'Tank',
      mark: 'E-1',
      levelId: 'level-2',
      location: [0, 3000],
      size: [2000, 2000, 1000],
      weight: 60000,
    });
    const data = check(doc);
    const alpha = data.frames[0]?.alphaCritical ?? Infinity;
    expect(alpha).toBeLessThan(3);
    const stability = data.members.flatMap((row) =>
      row.checks.filter((entry) => entry.name.startsWith('sway stability')),
    );
    expect(stability).toHaveLength(1);
    expect(stability[0]?.utilisation).toBeGreaterThan(1);
    expect(data.ok).toBe(false);
  });
});

describe('braced in one direction, framed in the other', () => {
  const braced = (): CadDocument => {
    let doc = twoLevels();
    for (const [x, y] of [
      [0, 0],
      [6000, 0],
      [6000, 6000],
      [0, 6000],
    ] as const) {
      doc = frameColumn(doc, x, y);
    }
    for (const x of [0, 6000]) {
      doc = jointBeam(doc, [x, 0], [x, 6000], { startJoint: 'rigid', endJoint: 'rigid' });
    }
    for (const y of [0, 6000]) doc = jointBeam(doc, [0, y], [6000, y]);
    for (const [from, to] of [
      [
        [0, 0, 0],
        [6000, 0, BEAM_Z],
      ],
      [
        [6000, 0, 0],
        [0, 0, BEAM_Z],
      ],
    ] as const) {
      doc = step(doc, 'add_steel_member', {
        role: 'brace',
        profile: 'CHS139.7x5',
        start: [...from],
        end: [...to],
        levelId: 'level-1',
      });
    }
    return doc;
  };

  it('X-bracing + Y moment frames leave no direction without a lateral system', () => {
    const data = check(braced());
    expect(data.warnings.filter((text) => text.includes('no bracing'))).toEqual([]);
    expect(data.frames).toHaveLength(2);
    expect(data.storeys[0]?.frames).toEqual({ X: 0, Y: 2 });
    expect(data.members.every((row) => row.analysed)).toBe(true);
  });

  it('without the frames the Y direction is reported as unbraced', () => {
    const doc = braced();
    const pinned = {
      ...doc,
      building: {
        ...doc.building!,
        elements: Object.fromEntries(
          Object.entries(doc.building!.elements).map(([id, element]) => [
            id,
            element.category === 'member' && element.role === 'beam'
              ? { ...element, startJoint: 'pinned', endJoint: 'pinned' }
              : element,
          ]),
        ),
      },
    } as CadDocument;
    const data = check(pinned);
    expect(data.frames).toEqual([]);
    expect(data.warnings.filter((text) => text.includes('no bracing in direction Y'))).toHaveLength(
      1,
    );
  });

  it('delivers the pinned X beams to the frame columns as vertical loads (column axial = sum of reactions)', () => {
    const data = check(braced(), { notionalFactor: 0 });
    const [wb, wc] = [weightOf('IPE300'), weightOf('HEB200')];
    // Each column: half of two beams (6 m each) → one beam length of load, plus its own weight.
    const expected = GAMMA * (wb * 6 + wc * (BEAM_Z / 1000));
    for (const mark of ['SC1', 'SC2', 'SC3', 'SC4']) {
      close(rowOf(data, mark).forces['NEd'], expected, 0.01);
    }
  });
});

describe('column base fixity', () => {
  it('takes the base plate fixity when the member declares none', () => {
    const doc = portal({ base: 'plate' });
    expect(rowOf(check(doc), 'SC1').forces['baseMoment']).toBeUndefined();
    const data = check(withPlateFixity(step(doc, 'add_base_plates', {}), 'fixed'));
    expect(rowOf(data, 'SC1').forces['baseMoment']).toBeGreaterThan(0);
    expect(data.warnings.filter((text) => text.includes('base plate'))).toEqual([]);
  });

  it('warns when the column fixity contradicts its base plate', () => {
    const doc = withPlateFixity(step(portal({ base: 'fixed' }), 'add_base_plates', {}), 'pinned');
    const data = check(doc);
    expect(
      data.warnings.some((text) => text.includes("baseFixity 'fixed' but its base plate is")),
    ).toBe(true);
    expect(rowOf(data, 'SC1').forces['baseMoment']).toBeGreaterThan(0);
  });
});
