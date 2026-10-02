import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { BasePlateElement } from '@core/model/building';
import { execute } from '@core/commands/registry';
import {
  baseReactions,
  framesOf,
  solveCombination,
  type FrameLoads,
} from '@aec/industrial/frameModel';
import { BEARING_STRENGTH, checkPlateMN, sizeBasePlate } from '@aec/industrial/basePlateMN';
import { footingMoment, type FoundationRow } from '@aec/industrial/foundationCheck';
import type { FootingDesignRow } from '@aec/industrial/footingDesign';
import { findProfile } from '@aec/steel/profiles';
import { buildingErrors } from '@aec/validate';

const HALL = { span: 24000, length: 30000 };
const LOADS: FrameLoads = { deadLoad: 0.5, snowLoad: 0.8, windPressure: 0.7 };
const CRANE_HALL = { ...HALL, crane: { capacity: 10, railHeight: 6000 } };

function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', { ...HALL, ...params })
    .document;
}

const plates = (doc: CadDocument): BasePlateElement[] =>
  Object.values(doc.building!.elements).filter(
    (element): element is BasePlateElement => element.category === 'plate',
  );

/** Same document with every pad footing replaced by a square pad of `size` × `thickness`. */
function withPads(doc: CadDocument, size: number, thickness: number): CadDocument {
  const elements = { ...doc.building!.elements };
  for (const [id, element] of Object.entries(elements)) {
    if (element.category === 'footing') {
      elements[id] = { ...element, width: size, length: size, thickness };
    }
  }
  return { ...doc, building: { ...doc.building!, elements } };
}

function sections(doc: CadDocument): { column: string; rafter: string; tonnes: number } {
  const members = Object.values(doc.building!.elements).flatMap((element) =>
    element.category === 'member' && (element.role === 'column' || element.role === 'rafter')
      ? [element]
      : [],
  );
  const profileOf = (role: string): string =>
    members.find((member) => member.role === role && !member.profile.startsWith('HEA200'))!.profile;
  const tonnes = members.reduce((sum, member) => {
    const length =
      Math.hypot(
        member.end[0] - member.start[0],
        member.end[1] - member.start[1],
        member.end[2] - member.start[2],
      ) / 1000;
    return sum + (length * findProfile(member.profile)!.massPerMetre) / 1000;
  }, 0);
  return { column: profileOf('column'), rafter: profileOf('rafter'), tonnes };
}

const foundationRows = (doc: CadDocument): FoundationRow[] =>
  (execute(doc, 'check_foundations', { windPressure: 0.7 }).data as { rows: FoundationRow[] }).rows;

describe('add_portal_frame_building columnBase', () => {
  it('keeps pinned bases as the default: no fixity on the plates, no base moments', () => {
    const doc = hall();
    expect(plates(doc).every((plate) => plate.fixity === undefined)).toBe(true);
    const building = doc.building!;
    const reactions = baseReactions(doc, building, building.levelOrder[0]!, LOADS);
    expect(reactions.length).toBeGreaterThan(0);
    for (const reaction of reactions) {
      for (const forces of Object.values(reaction.cases)) expect(forces.moment).toBe(0);
    }
    expect(
      plates(hall({ columnBase: 'pinned' })).every((plate) => plate.fixity === undefined),
    ).toBe(true);
  });

  it('stores fixity on every base plate and reports it in the summary', () => {
    const result = execute(createEmptyDocument(), 'add_portal_frame_building', {
      ...HALL,
      columnBase: 'fixed',
    });
    expect(result.summary).toContain('fixed column bases');
    const list = plates(result.document);
    const members = result.document.building!.elements;
    const framePlates = list.filter(
      (plate) => (members[plate.memberId] as { roll: number }).roll === 0,
    );
    expect(framePlates).toHaveLength(12);
    expect(framePlates.every((plate) => plate.fixity === 'fixed')).toBe(true);
    // Gable wind posts are not frame columns: pinned.
    expect(list.filter((plate) => plate.fixity === undefined)).toHaveLength(list.length - 12);
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('rejects an unknown columnBase and fixed bases without base plates (no-op)', () => {
    const doc = createEmptyDocument();
    const bad = execute(doc, 'add_portal_frame_building', { ...HALL, columnBase: 'hinged' });
    expect(bad.document).toBe(doc);
    expect(bad.affected).toEqual([]);
    expect(bad.summary).toContain('add_portal_frame_building rejected: invalid params');
    const noPlates = execute(doc, 'add_portal_frame_building', {
      ...HALL,
      columnBase: 'fixed',
      basePlates: false,
    });
    expect(noPlates.document).toBe(doc);
    expect(noPlates.affected).toEqual([]);
    expect(noPlates.summary).toContain('needs base plates');
  });

  it('flags an invalid stored fixity', () => {
    const doc = hall({ columnBase: 'fixed' });
    const plate = plates(doc)[0]!;
    const broken = {
      ...doc.building!,
      elements: { ...doc.building!.elements, [plate.id]: { ...plate, fixity: 'rigid' } },
    };
    expect(buildingErrors(broken).join(' ')).toContain('fixity must be pinned or fixed');
  });
});

describe('fixed column bases in the frame analysis', () => {
  const frameOf = (doc: CadDocument): ReturnType<typeof framesOf>['frames'][number] => {
    const building = doc.building!;
    return framesOf(doc, building, building.levelOrder[0]!, LOADS).frames[0]!;
  };

  it('restrains the base rotation: lower apex deflection and eaves sway', () => {
    const pinned = frameOf(hall());
    const fixed = frameOf(hall({ columnBase: 'fixed' }));
    const apex = (frame: typeof pinned): number => {
      const result = solveCombination(frame, { G: 1, S: 1 })!;
      const top = frame.nodes.reduce(
        (best, node, index) => (node.y > (frame.nodes[best]?.y ?? 0) ? index : best),
        0,
      );
      return Math.abs(result.displacements[top]![1]);
    };
    const sway = (frame: typeof pinned): number => {
      const result = solveCombination(frame, { WL: 1 })!;
      return Math.max(
        ...frame.columnTops.map((top) => Math.abs(result.displacements[top.node]![0])),
      );
    };
    expect(fixed.nodes.filter((node) => node.restraint[2])).toHaveLength(2);
    expect(pinned.nodes.filter((node) => node.restraint[2])).toHaveLength(0);
    expect(apex(fixed)).toBeLessThan(apex(pinned));
    expect(sway(fixed)).toBeLessThan(0.5 * sway(pinned));
  });

  it('lowers the rail-level sway of a crane hall', () => {
    const rail = (doc: CadDocument): number => {
      const frame = frameOf(doc);
      const result = solveCombination(frame, { CLk: 1 })!;
      return Math.max(
        ...frame.craneNodes.map((node) => Math.abs(result.displacements[node.node]![0])),
      );
    };
    const pinned = rail(hall(CRANE_HALL));
    expect(pinned).toBeGreaterThan(0);
    expect(rail(hall({ ...CRANE_HALL, columnBase: 'fixed' }))).toBeLessThan(pinned);
  });

  it('reports the base moment per case, counter-clockwise +', () => {
    const doc = hall({ columnBase: 'fixed' });
    const building = doc.building!;
    const reactions = baseReactions(doc, building, building.levelOrder[0]!, LOADS).filter(
      (reaction) => reaction.frame === 'frame 3',
    );
    expect(reactions).toHaveLength(2);
    const x = (id: string): number =>
      (building.elements[id] as unknown as { start: number[] }).start[0]!;
    const [left, right] = [...reactions].sort((a, b) => x(a.columnId) - x(b.columnId)) as [
      (typeof reactions)[number],
      (typeof reactions)[number],
    ];
    // Gravity: the rafters push the heads outwards; the fixed feet resist mirror-symmetrically.
    expect(left.cases.G!.moment).not.toBe(0);
    expect(left.cases.G!.moment).toBeCloseTo(-right.cases.G!.moment, -1);
    // Wind from the left pushes the frame to +x: the windward foot resists counter-clockwise.
    expect(left.cases.WL!.moment).toBeGreaterThan(0);
    expect(left.cases.WL!.horizontal + right.cases.WL!.horizontal).toBeLessThan(0);
  });

  it('designs a lighter crane hall with fixed bases than with pinned bases', () => {
    const design = (columnBase: 'pinned' | 'fixed'): ReturnType<typeof sections> => {
      const result = execute(hall({ ...CRANE_HALL, columnBase }), 'design_portal_frames', {
        windPressure: 0.7,
      });
      expect((result.data as { failures: number }).failures).toBe(0);
      return sections(result.document);
    };
    const pinned = design('pinned');
    const fixed = design('fixed');
    expect(fixed.tonnes).toBeLessThan(pinned.tonnes);
    expect(`${fixed.column}/${fixed.rafter}`).toBe('HEA400/IPE450');
    expect(`${pinned.column}/${pinned.rafter}`).not.toBe(`${fixed.column}/${fixed.rafter}`);
  });
});

describe('footing eccentricity and overturning with a base moment', () => {
  const worstOf = (list: FoundationRow[], check: string): number =>
    Math.max(...list.filter((row) => row.check.startsWith(check)).map((row) => row.utilisation));

  it('adds the base moment to H·lever (both add under wind) in the footing moment', () => {
    expect(footingMoment(0, -10, 1.5)).toBeCloseTo(15, 9);
    expect(footingMoment(40, -10, 1.5)).toBeCloseTo(55, 9);
    expect(footingMoment(40, 10, 1.5)).toBeCloseTo(25, 9);
  });

  it('raises the soil bearing pressure and adds an overturning EQU row only for fixed bases', () => {
    const pinned = foundationRows(hall());
    const fixed = foundationRows(hall({ columnBase: 'fixed' }));
    expect(pinned.some((row) => row.check.startsWith('overturning'))).toBe(false);
    expect(worstOf(fixed, 'soil bearing')).toBeGreaterThan(worstOf(pinned, 'soil bearing'));
    const overturning = fixed.find((row) => row.check.startsWith('overturning EQU'))!;
    expect(overturning.unit).toBe('kNm');
    expect(overturning.combination).toContain('0.9G');
    expect(overturning.utilisation).toBeCloseTo(overturning.value / overturning.limit, 6);
  });

  it('passes overturning and bearing once the pads are wide enough', () => {
    const doc = hall({ columnBase: 'fixed' });
    expect(worstOf(foundationRows(doc), 'overturning')).toBeGreaterThan(1);
    const wide = foundationRows(withPads(doc, 8000, 1200));
    expect(worstOf(wide, 'overturning')).toBeLessThan(1);
    expect(worstOf(wide, 'soil bearing')).toBeLessThan(1);
  });

  it('designs the footing mat for the eccentric pressure (more steel than pinned)', () => {
    const required = (doc: CadDocument): number => {
      const data = execute(withPads(doc, 4000, 900), 'design_footings', { windPressure: 0.7 })
        .data as { footings: FootingDesignRow[] };
      return Math.max(...data.footings.map((row) => row.asRequired));
    };
    expect(required(hall({ columnBase: 'fixed' }))).toBeGreaterThan(required(hall()));
  });
});

describe('design_footings pad sizing', () => {
  const footingIds = (doc: CadDocument): string[] =>
    Object.values(doc.building!.elements).flatMap((element) =>
      element.category === 'footing' ? [element.id] : [],
    );
  const padSizes = (doc: CadDocument): number[][] =>
    Object.values(doc.building!.elements).flatMap((element) =>
      element.category === 'footing' ? [[element.width, element.length, element.thickness]] : [],
    );

  it('sizes the pads of the fixed-base crane hall so every footing check passes', () => {
    const doc = hall({ columnBase: 'fixed', crane: CRANE_HALL.crane });
    const before = foundationRows(doc).filter((row) => row.check.startsWith('soil bearing'));
    expect(Math.max(...before.map((row) => row.utilisation))).toBeGreaterThan(1);
    const result = execute(doc, 'design_footings', { windPressure: 0.7 });
    const rows = (result.data as { footings: FootingDesignRow[] }).footings;
    expect(rows.every((row) => row.status === 'designed')).toBe(true);
    expect(result.summary).toMatch(/F\d+ 1500×1500×600 → \d+×\d+×\d+ H\d+ @ \d+/);
    const designedIds = rows.map((row) => row.id);
    const after = foundationRows(result.document).filter((row) =>
      designedIds.includes(row.elementId),
    );
    expect(after.some((row) => row.check.startsWith('overturning'))).toBe(true);
    expect(Math.max(...after.map((row) => row.utilisation))).toBeLessThanOrEqual(1);
    for (const row of rows) {
      expect(row.sizeAfter[0]).toBeGreaterThan(row.sizeBefore[0]);
      expect(row.sizeAfter[0]).toBe(row.sizeAfter[1]);
    }
    const volume = (document: CadDocument): number =>
      (
        execute(document, 'quantity_takeoff', {}).data as {
          lines: Array<{ group: string; unit: string; quantity: number }>;
        }
      ).lines.find((line) => line.group === 'footing' && line.unit === 'm3')?.quantity ?? 0;
    expect(volume(result.document)).toBeGreaterThan(volume(doc));
  });

  it('leaves the pinned default hall pads unchanged (reinforcement only)', () => {
    const doc = hall({ crane: CRANE_HALL.crane });
    const result = execute(doc, 'design_footings', { windPressure: 0.7 });
    expect(padSizes(result.document)).toEqual(padSizes(doc));
    expect(footingIds(result.document)).toEqual(footingIds(doc));
    expect(result.summary).not.toContain('→');
  });
});

describe('base plate under M + N', () => {
  const geometry = {
    length: 500,
    width: 450,
    thickness: 40,
    boltCount: 4,
    boltDiameter: 24,
    columnDepth: 300,
  };

  it('carries a small eccentricity by bearing alone (no bolt tension)', () => {
    const verdict = checkPlateMN(geometry, 500, 10, 355);
    expect(verdict.boltTension).toBe(0);
    expect(verdict.bearingLength).toBeCloseTo(500e3 / (450 * BEARING_STRENGTH), 3);
    expect(verdict.utilisation).toBeLessThan(1);
  });

  it('satisfies Ft z + N zc = M and C = N + Ft with tension bolts', () => {
    const [normal, moment] = [200, 150];
    const verdict = checkPlateMN(geometry, normal, moment, 355);
    const tension = verdict.boltTension * 1000 * 2;
    const block = verdict.bearingLength;
    const centroid = 500 / 2 - block / 2;
    const arm = centroid + (500 / 2 - 48);
    expect(tension).toBeGreaterThan(0);
    expect(tension * arm + normal * 1000 * centroid).toBeCloseTo(moment * 1e6, -3);
    expect(block * 450 * BEARING_STRENGTH).toBeCloseTo(normal * 1000 + tension, -1);
    expect(verdict.check).toContain('bolt Ft');
  });

  it('is symmetric in the moment sign and shares uplift with a moment between the bolt groups', () => {
    expect(checkPlateMN(geometry, 200, -150, 355).utilisation).toBeCloseTo(
      checkPlateMN(geometry, 200, 150, 355).utilisation,
      9,
    );
    const uplift = checkPlateMN(geometry, -100, 10, 355);
    expect(uplift.bearingLength).toBe(0);
    const lever = 500 / 2 - 48;
    expect(uplift.boltTension * 1000 * 2).toBeCloseTo((100e3 + 10e6 / lever) / 2, 0);
  });

  it('fails plates without tension bolts that need them', () => {
    expect(checkPlateMN({ ...geometry, boltCount: 2 }, 100, 300, 355).utilisation).toBeGreaterThan(
      1,
    );
  });

  it('sizes the lightest catalogue plate that passes and grows with the demand', () => {
    const column = { depth: 390, width: 300 };
    const demand = { normal: 130, moment: 270 };
    const light = sizeBasePlate(column, [{ normal: 150, moment: 20 }], 355);
    const heavy = sizeBasePlate(column, [demand], 355);
    expect(light.passes).toBe(true);
    expect(heavy.passes).toBe(true);
    expect(light.sizing.boltCount).toBe(4);
    expect(heavy.sizing.boltDiameter).toBeGreaterThan(light.sizing.boltDiameter);
    const size = heavy.sizing;
    const verdict = checkPlateMN(
      {
        length: column.depth + 2 * size.margin,
        width: column.width + 2 * size.margin,
        thickness: size.thickness,
        boltCount: size.boltCount,
        boltDiameter: size.boltDiameter,
        columnDepth: column.depth,
      },
      demand.normal,
      demand.moment,
      355,
    );
    expect(verdict.utilisation).toBeLessThanOrEqual(1);
    expect(sizeBasePlate(column, [{ normal: 50, moment: 5000 }], 355).passes).toBe(false);
  });

  it('is sized by design_portal_frames and reported as "base plate M+N" by check_foundations', () => {
    const doc = hall({ columnBase: 'fixed' });
    const before = plates(doc).find((plate) => plate.fixity === 'fixed')!;
    const designed = execute(doc, 'design_portal_frames', { windPressure: 0.7 });
    expect(designed.summary).toContain('fixed bases: plate');
    const after = plates(designed.document);
    const fixed = after.filter((plate) => plate.fixity === 'fixed');
    expect(fixed).toHaveLength(12);
    expect(fixed[0]!.thickness).toBeGreaterThan(before.thickness);
    expect(fixed[0]!.boltDiameter).toBeGreaterThan(before.boltDiameter);
    const rows = foundationRows(designed.document).filter((row) =>
      row.check.startsWith('base plate M+N'),
    );
    expect(rows).toHaveLength(fixed.length);
    expect(rows.every((row) => row.utilisation <= 1)).toBe(true);
    expect(
      foundationRows(doc).some(
        (row) => row.check.startsWith('base plate M+N') && row.utilisation > 1,
      ),
    ).toBe(true);
  });

  it('adds no M+N row for pinned bases', () => {
    expect(foundationRows(hall()).some((row) => row.check.includes('M+N'))).toBe(false);
  });
});
