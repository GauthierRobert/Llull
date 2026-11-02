/**
 * Plant 06 STA M6 (circular platform): add_circular_access_platform around a vertical vessel, its follow-the-vessel update, takeoff and edge protection.
 * Hand numbers (VC-STA-07): OD 3000, gap 150, width 1000, sweep 180 -> ri 1650, ro 2650, A = (pi/2)(2.65^2 - 1.65^2) = 6.754424 m2,
 * 6.754424 x 43.4536 = 293.504 kg, outer arc pi x 2.65 = 8.325221 m, inner arc 5.183628 m; bracketSpacingMax 1500 -> ceil(8325.2 / 1500) + 1 = 7 brackets,
 * 7 outer-rail posts; outer arc + two 1 m ends = 10.325221 m of rail.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { buildingErrors } from '@aec/building/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { BOTH, TYPE } from './accessFixtures';

const vesselDoc = (size: number[] = [3000, 3000, 18000], location: number[] = [0, 0]): CadDocument => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 6000 });
  return apply(doc, 'add_equipment', { name: 'Column', mark: 'C-101', location, size, shape: 'vertical_vessel' });
};
/** The edge and railing checks only: the platform egress check (no ladder here) has its own tests in reachability.test.ts. */
const EDGES_ONLY = ['stairs', 'edges', 'railings', 'ladders'];
const PACK = {
  equipmentId: 'equipment-1',
  elevation: 6000,
  startAngleDeg: 0,
  sweepDeg: 180,
  gap: 150,
  width: 1000,
  gratingType: TYPE,
  bracketProfile: 'UPN160',
  bracketSpacingMax: 1500,
  railing: { edges: ['outer', 'ends'], height: 1100, postSpacingMax: 1500, kneeRails: 1, toePlate: 100 },
};

interface Quantities {
  innerRadiusMm: number;
  outerRadiusMm: number;
  gratingAreaM2: number;
  panelAreaM2: number;
  gratingMassKg: number;
  outerArcM: number;
  innerArcM: number;
  railingLengthM: number;
  outerRailPosts: number;
  bracketCount: number;
  panels: number;
  railings: number;
  stale?: boolean;
}
interface CircularData {
  assemblyId: string;
  memberIds: string[];
  gratingIds: string[];
  railingIds: string[];
  quantities: Quantities;
  notes: string[];
  defaults: string[];
}
const answer = (result: { data?: unknown }): CircularData => result.data as CircularData;
const staleOf = (doc: CadDocument): { stale: boolean; staleReason: string | null } =>
  data<{ platforms: Array<{ stale: boolean; staleReason: string | null }> }>(doc, 'access_platform_takeoff', {}).platforms[0] as {
    stale: boolean;
    staleReason: string | null;
  };

describe('add_circular_access_platform: closed form (VC-STA-07)', () => {
  const doc = vesselDoc();
  const built = ok(doc, 'add_circular_access_platform', PACK);
  const got = answer(built);

  it('meets the pack numbers: radii, sector area, grating mass, arcs, rail length, posts and brackets', () => {
    expect(got.quantities.innerRadiusMm).toBe(1650);
    expect(got.quantities.outerRadiusMm).toBe(2650);
    expect(got.quantities.gratingAreaM2).toBeCloseTo(6.754424, 6);
    expect(got.quantities.gratingMassKg).toBeCloseTo(293.504, 2);
    expect(got.quantities.outerArcM).toBeCloseTo(8.325221, 6);
    expect(got.quantities.innerArcM).toBeCloseTo(5.183628, 6);
    expect(got.quantities.railingLengthM).toBeCloseTo(10.325221, 6);
    expect(got.quantities.outerRailPosts).toBe(7);
    expect(got.quantities.bracketCount).toBe(7);
    expect(got.memberIds).toHaveLength(7);
    expect(got.gratingIds).toHaveLength(6);
    expect(got.railingIds).toHaveLength(3);
  });

  it('models the chord polygons slightly under the true sector area, and says so', () => {
    expect(got.quantities.panelAreaM2).toBeLessThan(got.quantities.gratingAreaM2);
    expect(got.quantities.panelAreaM2).toBeGreaterThan(got.quantities.gratingAreaM2 * 0.998);
    expect(got.notes.join(' ')).toContain('bars skewed 15.00 deg');
  });

  it('stores the assembly on the vessel with brackets of role bracket welded at the shell and ending at ro', () => {
    const assembly = built.document.building?.elements['assembly-1'];
    expect(assembly?.category === 'assembly' && assembly.kind).toBe('circular_platform');
    expect(assembly?.category === 'assembly' && assembly.hostId).toBe('equipment-1');
    const first = built.document.building?.elements['member-1'];
    expect(first?.category === 'member' && first.role).toBe('bracket');
    expect(first?.category === 'member' && first.mark).toBe('BK1');
    expect(first?.category === 'member' && first.start.slice(0, 2)).toEqual([1500, 0]);
    expect(first?.category === 'member' && first.end.slice(0, 2)).toEqual([2650, 0]);
    // top of steel = underside of the grating (6000 - 31.75)
    expect(first?.category === 'member' && first.start[2]).toBeCloseTo(6000 - 31.75 - 80, 6);
    const last = built.document.building?.elements['member-7'];
    expect(last?.category === 'member' && last.end[0]).toBeCloseTo(-2650, 6);
    expect(buildingErrors(built.document.building)).toEqual([]);
  });

  it('bears each segment on its two brackets with the bars along the tangent at mid-angle', () => {
    const panel = built.document.building?.elements['grating-2'];
    expect(panel?.category === 'grating' && panel.supportIds).toEqual([['member-2'], ['member-3']]);
    expect(panel?.category === 'grating' && panel.bearingBarAngle).toBeCloseTo((45 * Math.PI) / 180 + Math.PI / 2, 9);
    expect(panel?.category === 'grating' && panel.topOffset).toBe(6000);
    // outer arc forwards then inner arc back: counter-clockwise, 2 x 7 points at 5 deg chords
    expect(panel?.category === 'grating' && panel.boundary).toHaveLength(14);
  });

  it('SC-STA-03: the railed outer edge and ends protect the platform; the 150 mm gap to the shell closes the inner edge', () => {
    const checked = data<{ findings: Array<{ code: string }>; checked: { gratings: number; railings: number } }>(
      built.document,
      'check_access',
      { ids: ['assembly-1'], rulesets: ['iso_14122'], edgeDropThresholdMm: 500, include: EDGES_ONLY },
    );
    expect(checked.findings.map((finding) => finding.code)).toEqual([]);
    expect(checked.checked).toMatchObject({ gratings: 6, railings: 3 });
  });

  it('is pure and replays to the same ids and elements', () => {
    expectPure(doc, () => execute(doc, 'add_circular_access_platform', PACK));
    const replayed = execute(built.document, 'replay_history', {}).document;
    expect(replayed.building?.elements['assembly-1']).toEqual(built.document.building?.elements['assembly-1']);
    expect(Object.keys(replayed.building?.elements ?? {})).toEqual(Object.keys(built.document.building?.elements ?? {}));
  });
});

describe('add_circular_access_platform: edge protection depends on the railing and the gap', () => {
  it('leaves the end edges unprotected without the ends railing', () => {
    const doc = apply(vesselDoc(), 'add_circular_access_platform', { ...PACK, railing: { edges: ['outer'], height: 1100 } });
    const checked = data<{ findings: Array<{ code: string; location?: string }> }>(doc, 'check_access', {
      ids: ['assembly-1'],
      rulesets: ['iso_14122'],
      edgeDropThresholdMm: 500,
    });
    const unprotected = checked.findings.filter((finding) => finding.code === 'STA_EDGE_UNPROTECTED');
    expect(unprotected.length).toBe(2);
  });

  it('leaves the inner edge unprotected when the gap to the shell exceeds the guard-rail opening (600 mm)', () => {
    const doc = apply(vesselDoc(), 'add_circular_access_platform', { ...PACK, gap: 600 });
    const checked = data<{ findings: Array<{ code: string }> }>(doc, 'check_access', {
      ids: ['assembly-1'],
      rulesets: ['iso_14122'],
      edgeDropThresholdMm: 500,
      include: EDGES_ONLY,
    });
    expect(checked.findings.filter((finding) => finding.code === 'STA_EDGE_UNPROTECTED').length).toBeGreaterThanOrEqual(6);
    const narrow = apply(vesselDoc(), 'add_circular_access_platform', { ...PACK, gap: 450 });
    expect(
      data<{ findings: unknown[] }>(narrow, 'check_access', {
        ids: ['assembly-1'],
        rulesets: ['iso_14122'],
        edgeDropThresholdMm: 500,
        include: EDGES_ONLY,
      }).findings,
    ).toEqual([]);
  });

  it('a low platform does not need guarding: drop 400 mm is under the threshold', () => {
    const doc = apply(vesselDoc(), 'add_circular_access_platform', { ...PACK, elevation: 400, gap: 900, railing: undefined });
    expect(
      data<{ findings: unknown[] }>(doc, 'check_access', {
        ids: ['assembly-1'],
        rulesets: BOTH,
        edgeDropThresholdMm: 500,
        include: EDGES_ONLY,
      }).findings,
    ).toEqual([]);
  });
});

describe('add_circular_access_platform: defaults and the full ring', () => {
  const doc = vesselDoc([2000, 2000, 8000]);

  it('a full ring with defaults: 8 deg steps give 45 brackets and 45 segments, one closed outer railing, ends ignored', () => {
    const result = ok(doc, 'add_circular_access_platform', { equipmentId: 'equipment-1', elevation: 3000, width: 800, railing: {} });
    const got = answer(result);
    expect(got.memberIds).toHaveLength(45);
    expect(got.gratingIds).toHaveLength(45);
    expect(got.railingIds).toHaveLength(1);
    expect(got.quantities.innerRadiusMm).toBe(1050);
    expect(got.quantities.outerRadiusMm).toBe(1850);
    expect(got.quantities.gratingAreaM2).toBeCloseTo(Math.PI * (1.85 ** 2 - 1.05 ** 2), 5);
    expect(got.quantities.railingLengthM).toBeCloseTo(2 * Math.PI * 1.85, 5);
    const railing = result.document.building?.elements[got.railingIds[0] as string];
    expect(railing?.category === 'railing' && railing.path[0]).toEqual(
      railing?.category === 'railing' && railing.path[railing.path.length - 1],
    );
    expect(got.defaults.join(';')).toContain('gap 50 mm');
    expect(got.defaults.join(';')).toContain('sweepDeg 360');
    expect(got.defaults.join(';')).toContain('8 deg steps');
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('a 90 degree sector with 1500 spacing: ceil(pi/2 x 1850 / 1500) + 1 = 3 brackets and 2 segments', () => {
    const got = answer(
      ok(doc, 'add_circular_access_platform', {
        equipmentId: 'equipment-1',
        elevation: 3000,
        width: 800,
        sweepDeg: 90,
        bracketSpacingMax: 1500,
      }),
    );
    expect(got.memberIds).toHaveLength(3);
    expect(got.gratingIds).toHaveLength(2);
    expect(got.railingIds).toEqual([]);
    expect(got.quantities.outerArcM).toBeCloseTo((Math.PI / 2) * 1.85, 6);
    expect(got.quantities.gratingAreaM2).toBeCloseTo((Math.PI / 4) * (1.85 ** 2 - 1.05 ** 2), 6);
  });

  it('passes the supports of check_grating with the default step, and reports the skew for a wide spacing', () => {
    const fine = apply(doc, 'add_circular_access_platform', { equipmentId: 'equipment-1', elevation: 3000, width: 800, sweepDeg: 120 });
    const codes = (target: CadDocument): string[] =>
      data<{ panels: Array<{ findings: Array<{ code: string }> }> }>(target, 'check_grating', {
        uniformLoadKPa: 2,
        deflectionRatio: 100,
      }).panels.flatMap((panel) => panel.findings.map((finding) => finding.code));
    expect(codes(fine).filter((code) => code === 'STA_GRATING_SPAN_DIRECTION' || code === 'STA_NO_SUPPORT_FOUND')).toEqual([]);
    const wide = apply(doc, 'add_circular_access_platform', {
      equipmentId: 'equipment-1',
      elevation: 3000,
      width: 800,
      sweepDeg: 120,
      bracketSpacingMax: 1500,
    });
    expect(codes(wide)).toContain('STA_GRATING_SPAN_DIRECTION');
  });

  it('passes the supports of check_grating on a large vessel too (OD 3000, width 1000)', () => {
    const big = apply(vesselDoc(), 'add_circular_access_platform', {
      equipmentId: 'equipment-1',
      elevation: 6000,
      width: 1000,
      gap: 150,
      sweepDeg: 180,
    });
    const findings = data<{ panels: Array<{ findings: Array<{ code: string }> }> }>(big, 'check_grating', {
      uniformLoadKPa: 2,
      deflectionRatio: 100,
    }).panels.flatMap((panel) => panel.findings.map((finding) => finding.code));
    expect(findings.filter((code) => code === 'STA_NO_SUPPORT_FOUND' || code === 'STA_GRATING_SPAN_DIRECTION')).toEqual([]);
  });

  it('a full ring of 24 brackets (spec budget case) and the caps against a unit mistake', () => {
    const result = ok(doc, 'add_circular_access_platform', {
      equipmentId: 'equipment-1',
      elevation: 3000,
      width: 800,
      bracketSpacingMax: 485,
    });
    expect(answer(result).memberIds).toHaveLength(24);
    expectRefusal(
      doc,
      'add_circular_access_platform',
      { equipmentId: 'equipment-1', elevation: 3000, width: 800, bracketSpacingMax: 0.5 },
      'STA_INVALID_GEOMETRY',
      'bracketSpacingMax',
    );
    expectRefusal(
      doc,
      'add_circular_access_platform',
      { equipmentId: 'equipment-1', elevation: 3000, width: 800, railing: { postSpacingMax: 0.5 } },
      'STA_INVALID_GEOMETRY',
      'railing',
    );
  });
});

describe('add_circular_access_platform: refusals leave the document unchanged', () => {
  const doc = vesselDoc();

  it('rejects a missing element, a box, a vessel with a wrong elevation, bad types and profiles', () => {
    expectRefusal(doc, 'add_circular_access_platform', { ...PACK, equipmentId: 'equipment-9' }, 'STA_UNKNOWN_ELEMENT', 'equipmentId');
    const withBox = apply(doc, 'add_equipment', { name: 'Pump', location: [20000, 0], size: [1000, 1000, 1000] });
    expectRefusal(
      withBox,
      'add_circular_access_platform',
      { ...PACK, equipmentId: 'equipment-2' },
      'STA_EQUIPMENT_NOT_VESSEL',
      'equipmentId',
    );
    const horizontal = apply(doc, 'add_equipment', {
      name: 'Drum',
      location: [20000, 0],
      size: [4000, 1500, 1500],
      shape: 'horizontal_vessel',
    });
    expectRefusal(horizontal, 'add_circular_access_platform', { ...PACK, equipmentId: 'equipment-2' }, 'STA_EQUIPMENT_NOT_VESSEL');
    const slab = apply(doc, 'add_slab', {
      boundary: [
        [0, 5000],
        [4000, 5000],
        [4000, 7000],
        [0, 7000],
      ],
      thickness: 100,
    });
    expectRefusal(slab, 'add_circular_access_platform', { ...PACK, equipmentId: 'slab-1' }, 'STA_EQUIPMENT_NOT_VESSEL');
    expectRefusal(doc, 'add_circular_access_platform', { ...PACK, elevation: 18001 }, 'STA_OUTSIDE_SHELL', 'elevation');
    expectRefusal(doc, 'add_circular_access_platform', { ...PACK, elevation: 0 }, 'STA_OUTSIDE_SHELL', 'elevation');
    expectRefusal(doc, 'add_circular_access_platform', { ...PACK, gratingType: 'nope' }, 'STA_GRATING_TYPE_UNKNOWN', 'gratingType');
    expectRefusal(doc, 'add_circular_access_platform', { ...PACK, bracketProfile: 'ZZ9' }, 'STA_INVALID_GEOMETRY', 'bracketProfile');
    expectRefusal(doc, 'add_circular_access_platform', { ...PACK, railing: { railProfile: 'ZZ9' } }, 'STA_INVALID_GEOMETRY', 'railing');
    expectRefusal(doc, 'add_circular_access_platform', { ...PACK, railing: { height: 40 } }, 'STA_INVALID_GEOMETRY', 'railing');
    expectRefusal(
      doc,
      'add_circular_access_platform',
      { ...PACK, railing: { edges: ['inner', 'outer'], openings: [{ from: 10, to: 100 }] } },
      'STA_RAIL_OPENING',
    );
  });

  it('refuses a second platform over the first at the same elevation, accepts the other half and another elevation', () => {
    const first = apply(doc, 'add_circular_access_platform', PACK);
    expectRefusal(first, 'add_circular_access_platform', { ...PACK, startAngleDeg: 90 }, 'STA_PLATFORM_OVERLAP', 'elevation');
    const other = ok(first, 'add_circular_access_platform', { ...PACK, startAngleDeg: 180 });
    expect(answer(other).assemblyId).toBe('assembly-2');
    expect(answer(other).quantities.bracketCount).toBe(7);
    expect(answer(ok(first, 'add_circular_access_platform', { ...PACK, elevation: 9000 })).gratingIds).toHaveLength(6);
  });
});

describe('circular platform follows the vessel', () => {
  const built = apply(vesselDoc(), 'add_circular_access_platform', PACK);

  it('is current after the add, and stale once the vessel is resized or moved', () => {
    expect(staleOf(built)).toMatchObject({ stale: false, staleReason: null });
    const wider = apply(built, 'update_equipment', { elementId: 'equipment-1', size: [3600, 3600, 18000] });
    expect(staleOf(wider).stale).toBe(true);
    expect(staleOf(wider).staleReason).toContain('vessel');
    const moved = apply(built, 'update_equipment', { elementId: 'equipment-1', location: [500, 200] });
    expect(staleOf(moved).stale).toBe(true);
  });

  it('update_access_platform with no field re-derives it: radii grow, part ids are kept', () => {
    const wider = apply(built, 'update_equipment', { elementId: 'equipment-1', size: [3600, 3600, 18000] });
    const before = (built.building?.elements['assembly-1'] as { partIds: string[] }).partIds;
    const refreshed = ok(wider, 'update_access_platform', { assemblyId: 'assembly-1' });
    const got = answer(refreshed);
    expect(got.quantities.innerRadiusMm).toBe(1950);
    expect(got.quantities.outerRadiusMm).toBe(2950);
    const after = (refreshed.document.building?.elements['assembly-1'] as { partIds: string[] }).partIds;
    expect(before.every((id) => after.includes(id))).toBe(true);
    expect(after).toHaveLength(before.length + 2);
    expect(staleOf(refreshed.document).stale).toBe(false);
    const bracket = refreshed.document.building?.elements['member-1'];
    expect(bracket?.category === 'member' && bracket.start[0]).toBeCloseTo(1800, 6);
  });

  it('moving the vessel and re-deriving moves the brackets with it', () => {
    const moved = apply(built, 'update_equipment', { elementId: 'equipment-1', location: [1000, 500] });
    const refreshed = apply(moved, 'update_access_platform', { assemblyId: 'assembly-1' });
    const bracket = refreshed.building?.elements['member-1'];
    expect(bracket?.category === 'member' && bracket.start.slice(0, 2)).toEqual([2500, 500]);
  });

  it('refuses to re-derive when the vessel no longer reaches the elevation, and leaves the document unchanged', () => {
    const short = apply(built, 'update_equipment', { elementId: 'equipment-1', size: [3000, 3000, 5000] });
    expectRefusal(short, 'update_access_platform', { assemblyId: 'assembly-1' }, 'STA_OUTSIDE_SHELL', 'elevation');
    expect(staleOf(short).staleReason).toContain('outside the shell');
  });

  it('is a no-op when the platform is already current', () => {
    const result = execute(built, 'update_access_platform', { assemblyId: 'assembly-1' });
    expect(result.document).toBe(built);
    expect(result.summary).toContain('already matches');
  });

  it('deleting the vessel deletes the platform and every part', () => {
    const removed = apply(built, 'delete_building_element', { elementIds: ['equipment-1'] });
    expect(Object.keys(removed.building?.elements ?? {})).toEqual([]);
  });

  it('the platform cannot be moved by itself: the vessel is its host', () => {
    const result = execute(built, 'move_building_element', { elementIds: ['assembly-1'], delta: [10, 0] });
    expect(result.document).toBe(built);
    expect(result.summary).toContain('update_access_platform');
  });
});

describe('update_access_platform: circular fields', () => {
  const built = apply(vesselDoc(), 'add_circular_access_platform', PACK);

  it('changes width, sweep and railing edges; adds and removes parts while keeping ids', () => {
    const wide = ok(built, 'update_access_platform', { assemblyId: 'assembly-1', width: 1500, sweepDeg: 270 });
    const got = answer(wide);
    expect(got.quantities.outerRadiusMm).toBe(3150);
    expect(got.memberIds.length).toBeGreaterThan(7);
    expect(got.memberIds.slice(0, 7)).toEqual(['member-1', 'member-2', 'member-3', 'member-4', 'member-5', 'member-6', 'member-7']);
    const back = ok(wide.document, 'update_access_platform', {
      assemblyId: 'assembly-1',
      width: 1000,
      sweepDeg: 90,
      railing: { edges: ['outer', 'inner'] },
    });
    expect(answer(back).memberIds).toHaveLength(4);
    expect(answer(back).railingIds).toHaveLength(2);
    expect(Object.keys(back.document.building?.elements ?? {}).filter((id) => id.startsWith('member'))).toHaveLength(4);
  });

  it('changes elevation, bracket profile and spacing', () => {
    const tuned = ok(built, 'update_access_platform', {
      assemblyId: 'assembly-1',
      elevation: 7000,
      bracketProfile: 'UPN200',
      bracketSpacingMax: 800,
      gratingType: '19-W-4 1-1/2x3/16',
    });
    const member = tuned.document.building?.elements['member-1'];
    expect(member?.category === 'member' && member.profile).toBe('UPN200');
    expect(answer(tuned).memberIds.length).toBeGreaterThan(7);
    const panel = tuned.document.building?.elements['grating-1'];
    expect(panel?.category === 'grating' && [panel.topOffset, panel.gratingType]).toEqual([7000, '19-W-4 1-1/2x3/16']);
  });

  it('refuses deck fields, a bad elevation and a railing with deck edges', () => {
    expectRefusal(built, 'update_access_platform', { assemblyId: 'assembly-1', topOffset: 1 }, 'STA_INVALID_GEOMETRY', 'topOffset');
    expectRefusal(built, 'update_access_platform', { assemblyId: 'assembly-1', elevation: 99999 }, 'STA_OUTSIDE_SHELL');
    expectRefusal(
      built,
      'update_access_platform',
      { assemblyId: 'assembly-1', railing: { edges: [0, 1] } },
      'STA_INVALID_GEOMETRY',
      'railing',
    );
    expectRefusal(
      built,
      'update_access_platform',
      { assemblyId: 'assembly-1', railing: { edges: 'all' } },
      'STA_INVALID_GEOMETRY',
      'railing',
    );
    expectPure(built, () => execute(built, 'update_access_platform', { assemblyId: 'assembly-1', width: 1200 }));
  });

  it('guards the circular parts like the deck parts', () => {
    for (const [name, params] of [
      ['update_grating', { ids: ['grating-1'], gratingType: '19-W-4 1-1/2x3/16' }],
      ['update_railing', { id: 'railing-1', height: 1200 }],
      ['delete_building_element', { elementIds: ['member-2'] }],
    ] as const) {
      const result = execute(built, name, params);
      expect(result.error?.code, name).toBe('CMD_DERIVED_GEOMETRY');
      expect(result.document, name).toBe(built);
    }
  });
});

describe('circular platform: takeoff, schedule and IFC', () => {
  const built = apply(vesselDoc(), 'add_circular_access_platform', PACK);

  it('lists the platform in access_platform_takeoff and the platform schedule', () => {
    const takeoff = data<{ platforms: Array<Quantities & { id: string }>; totals: { gratingMassKg: number; posts: number } }>(
      built,
      'access_platform_takeoff',
      { ids: ['assembly-1'] },
    );
    expect(takeoff.platforms[0]?.railings).toBe(3);
    expect(takeoff.platforms[0]?.panels).toBe(6);
    expect(takeoff.totals.gratingMassKg).toBeCloseTo(293.504, 2);
    const schedule = data<{ rows: Array<Array<string | number>> }>(built, 'building_schedule', { kind: 'platform' });
    expect(schedule.rows[0]?.slice(0, 4)).toEqual(['AS1', 'circular_platform', 7, 6]);
    expect(schedule.rows[0]?.[4]).toBeCloseTo(6.754, 3);
  });

  it('exports the platform as an IfcElementAssembly with its parts', () => {
    const ifc = data<{ ifc: string }>(built, 'export_ifc', {}).ifc;
    expect(ifc.match(/IFCELEMENTASSEMBLY\(/g)).toHaveLength(1);
    expect(ifc).toContain("'circular_platform'");
    expect(ifc.match(/IFCPLATE\(/g)).toHaveLength(6);
    expect(ifc.match(/IFCRAILING\(/g)).toHaveLength(3);
  });

  it('validates a loaded circular assembly and its stored vessel snapshot', () => {
    const copy = JSON.parse(JSON.stringify(built.building)) as { elements: Record<string, { params: Record<string, unknown> }> };
    expect(buildingErrors(copy)).toEqual([]);
    (copy.elements['assembly-1'] as { params: Record<string, unknown> }).params['sweepDeg'] = 0;
    expect(buildingErrors(copy).join()).toContain('params are not the resolved generator parameters');
  });
});
