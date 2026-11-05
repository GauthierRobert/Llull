/**
 * Plant 06 STA M7: add_pipe_rack, update_pipe_rack, the pipe rack assembly (shared guard, regeneration and staleness machinery of M6) and its integration in
 * check_steel_members (moment frames across, braced bays along, pipe load on the tier beams, `data.racks`). Hand numbers (VC-STA-09): 60 m at 6 m bents,
 * 6 m wide, tiers +5000 / +7000, HEB300 columns (117 kg/m), IPE300 beams and struts (42.2 kg/m): 11 bents, 22 columns of 7.0 m (154 m), 22 tier
 * beams of 6.0 m (132 m), 2 x 10 x 2 = 40 struts of 6.0 m (240 m), mass 154 x 117 + 372 x 42.2 = 33 716.4 kg.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { AssemblyElement, SteelMemberElement } from '@aec/building/types';
import { buildingErrors } from '@aec/building/validate';
import { pipeWeightPerMetre } from '@aec/industrial/piping/pipeWeight';
import { findProfile } from '@aec/steel/profiles';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const PLAN_RACK = {
  origin: [0, 0],
  direction: [1, 0],
  length: 60000,
  bentSpacing: 6000,
  width: 6000,
  tiers: [5000, 7000],
  columnProfile: 'HEB300',
  tierBeamProfile: 'IPE300',
  strutProfile: 'IPE300',
  struts: 'every_tier',
  bracingBays: [1, 10],
  bracingProfile: 'L100x10',
  baseFixity: 'fixed',
  gridPrefix: 'PR',
};
const SMALL = {
  origin: [0, 0],
  direction: [1, 0],
  length: 6000,
  bentSpacing: 3000,
  width: 3000,
  tiers: [2500],
  columnProfile: 'HEB200',
  tierBeamProfile: 'IPE200',
};

const base = (): CadDocument => {
  const doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  return apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 7000 });
};

interface RackData {
  assemblyId: string;
  partCount: number;
  bents: number;
  columnLines: number;
  tiers: number;
  columns: number;
  tierBeams: number;
  struts: number;
  braces: number;
  columnLengthM: number;
  tierBeamLengthM: number;
  strutLengthM: number;
  braceLengthM: number;
  steelMassKgExBracing: number;
  steelKg: number;
  stations: number[];
  columnLineOffsets: number[];
  defaults: string[];
  notes: string[];
}
const build = (params: Record<string, unknown>, doc: CadDocument = base()): { doc: CadDocument; got: RackData } => {
  const result = ok(doc, 'add_pipe_rack', params);
  return { doc: result.document, got: result.data as RackData };
};
const members = (doc: CadDocument, assemblyId = 'assembly-1'): SteelMemberElement[] =>
  Object.values(doc.building?.elements ?? {}).filter(
    (element): element is SteelMemberElement => element.category === 'member' && element.assemblyId === assemblyId,
  );
const assemblyOf = (doc: CadDocument, id = 'assembly-1'): AssemblyElement => {
  const element = doc.building?.elements[id];
  if (element?.category !== 'assembly') throw new Error(`no assembly ${id}`);
  return element;
};
const byRole = (list: SteelMemberElement[], role: string): SteelMemberElement[] => list.filter((member) => member.role === role);
const struts = (list: SteelMemberElement[]): SteelMemberElement[] =>
  byRole(list, 'beam').filter((member) => member.startJoint !== 'rigid' && member.endJoint !== 'rigid');
const tierBeams = (list: SteelMemberElement[]): SteelMemberElement[] =>
  byRole(list, 'beam').filter((member) => member.startJoint === 'rigid');

describe('add_pipe_rack: closed form (VC-STA-09)', () => {
  const { doc, got } = build(PLAN_RACK);
  const parts = members(doc);

  it('uses the catalogue masses of the pack', () => {
    expect(findProfile('HEB300')?.massPerMetre).toBe(117);
    expect(findProfile('IPE300')?.massPerMetre).toBe(42.2);
  });

  it('counts bents, columns, tier beams, struts and braces', () => {
    expect([got.bents, got.columnLines, got.tiers]).toEqual([11, 2, 2]);
    expect([got.columns, got.tierBeams, got.struts, got.braces]).toEqual([22, 22, 40, 16]);
    expect(got.partCount).toBe(100);
    expect(parts).toHaveLength(100);
    expect(got.stations).toEqual([0, 6000, 12000, 18000, 24000, 30000, 36000, 42000, 48000, 54000, 60000]);
    expect(got.columnLineOffsets).toEqual([0, 6000]);
  });

  it('has the axis lengths and the steel mass of the pack', () => {
    expect(got.columnLengthM).toBeCloseTo(154, 6);
    expect(got.tierBeamLengthM).toBeCloseTo(132, 6);
    expect(got.strutLengthM).toBeCloseTo(240, 6);
    expect(got.steelMassKgExBracing / 33716.4 - 1).toBeLessThan(1e-6);
    expect(Math.abs(got.steelMassKgExBracing - 33716.4)).toBeLessThan(1e-3);
    expect(got.steelKg).toBeGreaterThan(got.steelMassKgExBracing);
  });

  it('places columns on both lines from grade to the top tier, strong axis across the rack, fixed bases', () => {
    const columns = byRole(parts, 'column');
    expect(columns[0]?.start).toEqual([0, 0, 0]);
    expect(columns[0]?.end).toEqual([0, 0, 7000]);
    expect(columns[1]?.start).toEqual([0, 6000, 0]);
    expect(columns.every((column) => column.baseFixity === 'fixed' && column.roll === Math.PI / 2)).toBe(true);
    expect(columns.map((column) => column.mark).slice(0, 3)).toEqual(['SC1', 'SC2', 'SC3']);
    expect(columns[0]?.note).toBe('PRA1');
  });

  it('puts the tier beams (rigid both ends) and struts (pinned) with their top of steel at the tier', () => {
    const beams = tierBeams(parts);
    expect(beams).toHaveLength(22);
    expect(beams.every((beam) => beam.startJoint === 'rigid' && beam.endJoint === 'rigid' && beam.profile === 'IPE300')).toBe(true);
    expect(beams.map((beam) => beam.start[2]).sort((a, b) => a - b)).toEqual([...Array(11).fill(4850), ...Array(11).fill(6850)]);
    const bars = struts(parts);
    expect(bars).toHaveLength(40);
    expect(bars.every((bar) => bar.startJoint === undefined && bar.endJoint === undefined && bar.end[0] - bar.start[0] === 6000)).toBe(
      true,
    );
  });

  it('braces bays 1 and 10 in both column-line planes with X pairs per storey', () => {
    const braces = byRole(parts, 'brace');
    expect(braces).toHaveLength(2 * 2 * 2 * 2);
    expect(braces[0]?.start).toEqual([0, 0, 0]);
    expect(braces[0]?.end).toEqual([6000, 0, 4850]);
    expect(braces[1]?.start).toEqual([6000, 0, 0]);
    expect(braces.every((brace) => brace.profile === 'L100x10')).toBe(true);
    expect(braces.some((brace) => brace.start[0] === 54000 || brace.end[0] === 54000)).toBe(true);
  });

  it('is an assembly with the resolved parameters, generation 1, valid in the building model', () => {
    const assembly = assemblyOf(doc);
    expect(assembly.kind).toBe('pipe_rack');
    expect(assembly.generation).toBe(1);
    expect(assembly.partIds).toHaveLength(100);
    expect(assembly.mark).toBe('AS1');
    expect(buildingErrors(doc.building)).toEqual([]);
  });

  it('names the defaults it used', () => {
    expect(build(SMALL).got.defaults).toEqual([
      'strutProfile IPE200 (the tier beam profile)',
      'struts every_tier',
      'baseFixity unset (pinned unless a base plate fixes it)',
      'gridPrefix PR',
    ]);
  });

  it('is pure and deterministic: the same call on the same document gives the same ids and parts', () => {
    const start = base();
    expectPure(start, () => execute(start, 'add_pipe_rack', PLAN_RACK));
    const again = build(PLAN_RACK).doc;
    expect(JSON.stringify(again.building?.elements)).toBe(JSON.stringify(doc.building?.elements));
  });
});

describe('add_pipe_rack: layouts', () => {
  it('rounds the bays up and equalises them: 10 m at <= 3 m is 4 bays of 2.5 m', () => {
    const { got } = build({ ...SMALL, length: 10000, bentSpacing: 3000 });
    expect(got.stations).toEqual([0, 2500, 5000, 7500, 10000]);
    expect(got.columns).toBe(10);
  });

  it('takes explicit stations', () => {
    const { got, doc } = build({ ...SMALL, length: undefined, bentSpacing: undefined, stations: [500, 2500, 7000] });
    expect(got.stations).toEqual([500, 2500, 7000]);
    expect(got.struts).toBe(4);
    expect(byRole(members(doc), 'column')[0]?.start[0]).toBe(500);
  });

  it('extends to the left of the direction: a rack along +Y with its origin at [1000, 2000] has its second line at x = -2000', () => {
    const { doc } = build({ ...SMALL, origin: [1000, 2000], direction: [0, 3] });
    const columns = byRole(members(doc), 'column');
    expect(columns[0]?.start.slice(0, 2)).toEqual([1000, 2000]);
    expect(columns[1]?.start.slice(0, 2)).toEqual([-2000, 2000]);
    expect(columns[2]?.start.slice(0, 2)).toEqual([1000, 5000]);
    expect(columns.every((column) => column.roll === 0)).toBe(true);
  });

  it('builds three column lines from baysAcross with a beam per bay and labelled notes', () => {
    const { got, doc } = build({ ...SMALL, width: undefined, baysAcross: [3000, 2000] });
    expect(got.columnLines).toBe(3);
    expect(got.columns).toBe(9);
    expect(got.tierBeams).toBe(6);
    expect(got.columnLineOffsets).toEqual([0, 3000, 5000]);
    expect(tierBeams(members(doc)).map((beam) => beam.note)).toContain('PR1 T1 B-C');
  });

  it('struts: top only, none, and every tier', () => {
    expect(build({ ...PLAN_RACK, bracingBays: [], struts: 'top' }).got.struts).toBe(20);
    expect(build({ ...PLAN_RACK, bracingBays: [], struts: 'none' }).got.struts).toBe(0);
    expect(build({ ...PLAN_RACK, bracingBays: [] }).got.struts).toBe(40);
  });

  it('a rack not parallel to X or Y says so, and check_steel_members reports its frames not analysed', () => {
    const { doc, got } = build({ ...SMALL, direction: [1, 1], bracingBays: [1], bracingProfile: 'L100x10' });
    expect(got.notes[0]).toContain('not parallel to X or Y');
    const checked = data<{ ok: boolean; racks: Array<{ notAnalysed: string[] }> }>(doc, 'check_steel_members', {});
    expect(checked.ok).toBe(false);
    expect(checked.racks[0]?.notAnalysed.length).toBeGreaterThan(0);
  });

  it('an axis-parallel rack along +Y is analysed in full (frames in y = const planes are the bracing planes)', () => {
    const { doc } = build({ ...SMALL, direction: [0, 1], bracingBays: [1], bracingProfile: 'L100x10' });
    const checked = data<{ racks: Array<{ members: number; analysed: number }> }>(doc, 'check_steel_members', {});
    expect(checked.racks[0]?.analysed).toBe(checked.racks[0]?.members);
  });
});

describe('add_pipe_rack: refusals leave the document unchanged', () => {
  const doc = base();
  const refuseWith = (changes: Record<string, unknown>, code: string, path?: string): void => {
    expectRefusal(doc, 'add_pipe_rack', { ...PLAN_RACK, ...changes }, code, path);
  };

  it('bentSpacing above the length, too many bents, bays no wider than a column', () => {
    refuseWith({ length: 3000, bentSpacing: 6000 }, 'STA_RACK_SPACING', 'bentSpacing');
    refuseWith({ length: 600000, bentSpacing: 1000 }, 'STA_RACK_SPACING', 'bentSpacing');
    refuseWith({ bentSpacing: 200 }, 'STA_RACK_SPACING');
    refuseWith({ width: 250 }, 'STA_RACK_SPACING', 'width');
    refuseWith({ width: undefined, baysAcross: Array(9).fill(1000) }, 'STA_RACK_SPACING', 'baysAcross');
  });

  it('stations out of order, length and stations together, no run, width with baysAcross, no width', () => {
    refuseWith({ length: undefined, bentSpacing: undefined, stations: [0, 3000, 2000] }, 'STA_RACK_SPACING', 'stations');
    refuseWith({ stations: [0, 6000] }, 'STA_RACK_SPACING', 'stations');
    refuseWith({ length: undefined, bentSpacing: undefined }, 'STA_RACK_SPACING');
    refuseWith({ length: 60000, bentSpacing: undefined }, 'STA_RACK_SPACING', 'bentSpacing');
    refuseWith({ baysAcross: [3000] }, 'STA_RACK_SPACING', 'baysAcross');
    refuseWith({ width: undefined }, 'STA_RACK_SPACING', 'width');
  });

  it('tiers descending, too close, too low', () => {
    refuseWith({ tiers: [7000, 5000] }, 'STA_RACK_TIERS', 'tiers');
    refuseWith({ tiers: [5000, 5100] }, 'STA_RACK_TIERS', 'tiers');
    refuseWith({ tiers: [200] }, 'STA_RACK_TIERS', 'tiers');
    refuseWith({ tiers: Array.from({ length: 13 }, (_, index) => 1000 * (index + 1)) }, 'STA_RACK_TIERS', 'tiers');
  });

  it('bracing: a bay beyond the last, a repeated bay, no profile, no struts to act as chords', () => {
    refuseWith({ bracingBays: [11] }, 'STA_RACK_BRACING', 'bracingBays');
    refuseWith({ bracingBays: [2, 2] }, 'STA_RACK_BRACING', 'bracingBays');
    refuseWith({ bracingBays: [0] }, 'CMD_INVALID_PARAMS');
    refuseWith({ bracingProfile: undefined }, 'STA_RACK_BRACING', 'bracingProfile');
    refuseWith({ struts: 'none' }, 'STA_RACK_BRACING', 'struts');
  });

  it('an unknown profile, a zero direction, a rack of more than 5000 members, an unknown level', () => {
    refuseWith({ columnProfile: 'HEB999' }, 'STA_INVALID_GEOMETRY', 'columnProfile');
    refuseWith({ bracingProfile: 'NOPE' }, 'STA_INVALID_GEOMETRY', 'bracingProfile');
    refuseWith({ direction: [0, 0] }, 'STA_INVALID_GEOMETRY', 'direction');
    refuseWith(
      {
        length: 200000,
        bentSpacing: 1000,
        width: undefined,
        baysAcross: Array(8).fill(1000),
        tiers: [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000],
      },
      'STA_INVALID_GEOMETRY',
    );
    refuseWith({ levelId: 'level-99' }, 'STA_INVALID_GEOMETRY', 'levelId');
  });
});

describe('update_pipe_rack: regeneration keeps ids and marks', () => {
  const { doc: built } = build({ ...PLAN_RACK, bracingBays: [] });
  const idsOf = (doc: CadDocument): Map<string, string> => new Map(members(doc).map((member) => [member.note ?? '', member.id]));

  it('a new tier beam section changes the profile only: same ids, same marks, generation 2', () => {
    const result = ok(built, 'update_pipe_rack', { assemblyId: 'assembly-1', tierBeamProfile: 'IPE360' });
    expect(idsOf(result.document)).toEqual(idsOf(built));
    expect(tierBeams(members(result.document)).every((beam) => beam.profile === 'IPE360')).toBe(true);
    expect(members(result.document).map((member) => member.mark)).toEqual(members(built).map((member) => member.mark));
    expect(assemblyOf(result.document).generation).toBe(2);
    expect(result.affected).toContain('assembly-1');
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('an extra bent keeps every existing member id; the new members get new ids and the surplus is removed on the way back', () => {
    const longer = ok(built, 'update_pipe_rack', { assemblyId: 'assembly-1', length: 66000 });
    const before = idsOf(built);
    const after = idsOf(longer.document);
    for (const [note, id] of before) expect(after.get(note), note).toBe(id);
    expect((longer.data as RackData).bents).toBe(12);
    expect(after.size).toBe(before.size + 2 + 2 + 4);
    const back = ok(longer.document, 'update_pipe_rack', { assemblyId: 'assembly-1', length: 60000 });
    expect(idsOf(back.document)).toEqual(before);
    expect(Object.keys(back.document.building?.elements ?? {}).sort()).toEqual(Object.keys(built.building?.elements ?? {}).sort());
  });

  it('adds bracing and takes it away again with an empty list', () => {
    const braced = ok(built, 'update_pipe_rack', { assemblyId: 'assembly-1', bracingBays: [3], bracingProfile: 'L100x10' });
    expect((braced.data as RackData).braces).toBe(8);
    const plain = ok(braced.document, 'update_pipe_rack', { assemblyId: 'assembly-1', bracingBays: [] });
    expect((plain.data as RackData).braces).toBe(0);
    expect(members(plain.document)).toHaveLength(members(built).length);
  });

  it('is pure and refuses the same invalid results as the add command (the document is unchanged)', () => {
    expectPure(built, () => execute(built, 'update_pipe_rack', { assemblyId: 'assembly-1', length: 66000 }));
    expectRefusal(built, 'update_pipe_rack', { assemblyId: 'assembly-1', tiers: [7000, 5000] }, 'STA_RACK_TIERS');
    expectRefusal(built, 'update_pipe_rack', { assemblyId: 'assembly-1', bracingBays: [3] }, 'STA_RACK_BRACING', 'bracingProfile');
    expectRefusal(built, 'update_pipe_rack', { assemblyId: 'assembly-1', width: 200 }, 'STA_RACK_SPACING');
  });

  it('refuses an id that is not a pipe rack, and a no-change update is a no-op', () => {
    expectRefusal(built, 'update_pipe_rack', { assemblyId: 'member-1' }, 'STA_UNKNOWN_ELEMENT', 'assemblyId');
    const deck = apply(base(), 'add_access_platform', {
      bounds: [
        [20000, 0],
        [23000, 2000],
      ],
      gratingType: '19-W-4 1-1/4x3/16',
      bearingBarDirection: [1, 0],
    });
    expectRefusal(deck, 'update_pipe_rack', { assemblyId: 'assembly-1' }, 'STA_UNKNOWN_ELEMENT');
    const same = execute(built, 'update_pipe_rack', { assemblyId: 'assembly-1' });
    expect(same.document).toBe(built);
    expect(same.affected).toEqual([]);
    expect(same.summary).toContain('nothing changed');
  });

  it('access_platform_takeoff and update_access_platform do not take a rack', () => {
    expectRefusal(built, 'access_platform_takeoff', { ids: ['assembly-1'] }, 'STA_UNKNOWN_ELEMENT');
    expect(data<{ platforms: unknown[] }>(built, 'access_platform_takeoff', {}).platforms).toEqual([]);
  });
});

describe('derivation guard and generic building commands with a rack present', () => {
  const { doc } = build(SMALL);
  const withSlab = apply(doc, 'add_slab', {
    boundary: [
      [20000, 0],
      [22000, 0],
      [22000, 2000],
      [20000, 2000],
    ],
    thickness: 100,
  });

  it('refuses an edit or a delete of one member, naming update_pipe_rack', () => {
    const edited = execute(doc, 'update_steel_member', { memberId: 'member-1', profile: 'HEB300' });
    expect(edited.error?.code).toBe('CMD_DERIVED_GEOMETRY');
    expect(edited.summary).toContain('update_pipe_rack');
    expect(edited.document).toBe(doc);
    const deleted = execute(doc, 'delete_building_element', { elementIds: ['member-2'] });
    expect(deleted.error?.code).toBe('CMD_DERIVED_GEOMETRY');
    expect(deleted.document).toBe(doc);
  });

  it('deleting the assembly removes the rack with all its members, leaving a valid document', () => {
    const result = ok(doc, 'delete_building_element', { elementIds: ['assembly-1'] });
    expect(Object.keys(result.document.building?.elements ?? {})).toEqual([]);
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('move_building_element refuses the assembly and any member, atomically', () => {
    for (const ids of [['assembly-1'], ['member-1'], ['member-1', 'slab-1']]) {
      const moved = execute(withSlab, 'move_building_element', { elementIds: ids, delta: [100, 0] });
      expect(moved.document, ids.join()).toBe(withSlab);
      expect(moved.summary).toContain('update_pipe_rack');
    }
  });

  it('copy_level_elements skips the rack members and says so; the copy validates', () => {
    const upper = apply(withSlab, 'add_level', { name: '+7000', elevation: 7000, height: 3000 });
    const upperId = Object.keys(upper.building?.levels ?? {}).find((id) => id !== 'level-1') as string;
    const result = ok(upper, 'copy_level_elements', { sourceLevelId: 'level-1', targetLevelIds: [upperId] });
    expect(result.summary).toContain('Skipped 13 generated assembly part(s)');
    expect(buildingErrors(result.document.building)).toEqual([]);
    expect(members(result.document)).toHaveLength(13);
    const onlyRack = execute(doc, 'copy_level_elements', { sourceLevelId: 'level-1', targetLevelIds: [upperId] });
    expect(onlyRack.document).toBe(doc);
  });

  it('delete_level takes the rack with its level and leaves a valid document', () => {
    const result = ok(withSlab, 'delete_level', { levelId: 'level-1', deleteElements: true });
    expect(Object.values(result.document.building?.elements ?? {}).filter((element) => element.category === 'assembly')).toEqual([]);
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('survives a save and load of the document and a replay of the same plan', () => {
    const loaded = JSON.parse(JSON.stringify(doc)) as CadDocument;
    expect(buildingErrors(loaded.building)).toEqual([]);
    const checked = data<{ racks: Array<{ stale: boolean }> }>(loaded, 'check_steel_members', {});
    expect(checked.racks[0]?.stale).toBe(false);
    const replay = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'set_units', params: { units: 'mm' } },
        { command: 'add_level', params: { name: 'Grade', elevation: 0, height: 7000 } },
        { command: 'add_pipe_rack', params: SMALL },
      ],
    });
    expect(JSON.stringify(replay.document.building?.elements)).toBe(JSON.stringify(doc.building?.elements));
  });

  it('rejects stored rack data that does not parse or points at nothing', () => {
    const tamper = (change: (elements: Record<string, Record<string, unknown>>) => void): string[] => {
      const copy = JSON.parse(JSON.stringify(doc)) as CadDocument;
      change(copy.building?.elements as unknown as Record<string, Record<string, unknown>>);
      return buildingErrors(copy.building);
    };
    expect(tamper((elements) => ((elements['assembly-1'] as Record<string, unknown>)['params'] = { kind: 'pipe_rack' })).join()).toContain(
      'params are not the resolved generator parameters of a pipe_rack',
    );
    expect(tamper((elements) => ((elements['assembly-1'] as Record<string, unknown>)['kind'] = 'tower')).join()).toContain(
      'kind must be platform, circular_platform or pipe_rack',
    );
    expect(tamper((elements) => delete elements['member-3']).join()).toContain('member-3');
    expect(tamper((elements) => ((elements['assembly-1'] as Record<string, unknown>)['hostId'] = 'equipment-1')).join()).toContain(
      'a pipe rack has no host',
    );
    const deck = apply(base(), 'add_access_platform', {
      bounds: [
        [20000, 0],
        [23000, 2000],
      ],
      gratingType: '19-W-4 1-1/4x3/16',
      bearingBarDirection: [1, 0],
    });
    const asRack = JSON.parse(JSON.stringify(deck)) as CadDocument;
    const platform = asRack.building?.elements['assembly-1'] as unknown as { kind: string; params: unknown };
    platform.kind = 'pipe_rack';
    platform.params = (doc.building?.elements['assembly-1'] as AssemblyElement).params;
    expect(buildingErrors(asRack.building).join()).toContain('of a pipe rack must be a steel member');
  });
});

describe('a stale rack is never green', () => {
  const { doc } = build(SMALL);
  const tampered = (): CadDocument => {
    const copy = JSON.parse(JSON.stringify(doc)) as CadDocument;
    (copy.building?.elements['member-1'] as unknown as { profile: string }).profile = 'HEB400';
    return copy;
  };

  it('check_access reports STA_RACK_STALE as a fail with the reason and the remedy', () => {
    const checked = data<{
      verdict: string;
      findings: Array<{ code: string; severity: string; ids: string[]; source: string; remediation: string }>;
    }>(tampered(), 'check_access', { rulesets: ['iso_14122'], ids: ['assembly-1'] });
    expect(checked.verdict).toBe('fail');
    const finding = checked.findings.find((entry) => entry.code === 'STA_RACK_STALE');
    expect(finding?.severity).toBe('fail');
    expect(finding?.ids).toEqual(['assembly-1']);
    expect(finding?.source).toContain('differs');
    expect(finding?.remediation).toContain('update_pipe_rack');
    expect(data<{ findings: unknown[] }>(doc, 'check_access', { rulesets: ['iso_14122'], ids: ['assembly-1'] }).findings).toEqual([]);
  });

  it('check_steel_members flags it in data.racks, data.ok, the summary and the warnings; the members are still checked as they are', () => {
    const result = ok(tampered(), 'check_steel_members', {});
    const checked = result.data as {
      ok: boolean;
      racks: Array<{ stale: boolean; staleReason: string; members: number }>;
      warnings: string[];
    };
    expect(checked.racks[0]?.stale).toBe(true);
    expect(checked.racks[0]?.members).toBe(members(doc).length);
    expect(checked.ok).toBe(false);
    expect(checked.warnings.join()).toContain('pipe rack AS1');
    expect(result.summary).toContain('STALE pipe rack');
    const fresh = data<{ ok: boolean; racks: Array<{ stale: boolean }> }>(doc, 'check_steel_members', {});
    expect([fresh.ok, fresh.racks[0]?.stale]).toEqual([true, false]);
  });

  it('update_pipe_rack with no field re-derives it and clears both findings', () => {
    const fixed = ok(tampered(), 'update_pipe_rack', { assemblyId: 'assembly-1' });
    expect(members(fixed.document)[0]?.profile).toBe('HEB200');
    expect(
      data<{ findings: unknown[] }>(fixed.document, 'check_access', { rulesets: ['iso_14122'], ids: ['assembly-1'] }).findings,
    ).toEqual([]);
    expect(data<{ racks: Array<{ stale: boolean }> }>(fixed.document, 'check_steel_members', {}).racks[0]?.stale).toBe(false);
  });

  it('unparseable stored parameters are stale too, and cannot be silently regenerated', () => {
    const copy = tampered();
    (copy.building?.elements['assembly-1'] as unknown as { params: unknown }).params = { kind: 'pipe_rack' };
    const checked = data<{ racks: Array<{ stale: boolean; staleReason: string }> }>(copy, 'check_steel_members', {});
    expect(checked.racks[0]?.staleReason).toContain('no longer parse');
    expectRefusal(copy, 'update_pipe_rack', { assemblyId: 'assembly-1' }, 'STA_INVALID_GEOMETRY');
  });
});

describe('check_steel_members integration (SC-STA-04): moment frames across, braced bays along, pipe load on the tier beams', () => {
  const { doc, got } = build(PLAN_RACK);
  const checked = data<{
    ok: boolean;
    members: Array<{ id: string; analysed: boolean; role: string; ok: boolean }>;
    frames: unknown[];
    racks: Array<{ members: number; analysed: number; pipeLoadKn: number; failing: string[]; maxUtilisation: number; steelMassKg: number }>;
    totals: { notAnalysed: number };
  }>(doc, 'check_steel_members', {});

  it('stores the explicit grade S355 on every generated member (no unparseable generic material)', () => {
    const materials = new Set(
      Object.values(doc.building?.elements ?? {}).flatMap((element) => (element.category === 'member' ? [element.material] : [])),
    );
    expect([...materials]).toEqual(['S355']);
  });

  it('analyses every member: 11 moment frames, columns, tier beams, struts and braces', () => {
    expect(checked.members).toHaveLength(100);
    expect(checked.members.every((row) => row.analysed)).toBe(true);
    expect(checked.frames).toHaveLength(11);
    expect(checked.ok).toBe(true);
    expect(checked.totals.notAnalysed).toBe(0);
  });

  it('reports the rack: members, analysed, utilisation, steel mass (including bracing), no pipe load yet', () => {
    const [rack] = checked.racks;
    expect(rack?.members).toBe(100);
    expect(rack?.analysed).toBe(100);
    expect(rack?.failing).toEqual([]);
    expect(rack?.maxUtilisation).toBeGreaterThan(0);
    expect(rack?.pipeLoadKn).toBe(0);
    expect(Math.abs((rack?.steelMassKg ?? 0) - got.steelKg)).toBeLessThan(0.1);
  });

  // A DN100 pipe along the rack on the lower tier: underside on the tier beams' top of steel (5000 mm), one support per bent.
  const pipeAt = (z: number): CadDocument =>
    apply(doc, 'add_pipe_run', {
      levelId: 'level-1',
      diameter: 114.3,
      service: 'water',
      points: [
        [0, 3000, z + 57.15],
        [60000, 3000, z + 57.15],
      ],
    });

  it('a pipe resting on the tier beams loads them: pipeLoadKn is its weight over the whole length, on 11 beams', () => {
    const result = ok(pipeAt(5000), 'check_steel_members', {});
    const withPipe = result.data as {
      racks: Array<{ pipeLoadKn: number; maxUtilisation: number }>;
      loads: { lines: Array<{ supports: number; carriedKn: number; bearers: Array<{ memberId: string; kn: number }> }> };
    };
    const weight = pipeWeightPerMetre(114.3, 1000) * 60;
    expect(withPipe.loads.lines[0]?.supports).toBe(11);
    expect(withPipe.loads.lines[0]?.carriedKn).toBeCloseTo(weight, 6);
    expect(withPipe.racks[0]?.pipeLoadKn).toBeCloseTo(weight, 2);
    expect(withPipe.loads.lines[0]?.bearers).toHaveLength(11);
    expect(withPipe.racks[0]?.maxUtilisation).toBeGreaterThanOrEqual(checked.racks[0]?.maxUtilisation ?? 0);
    expect(result.summary).toContain('1 pipe rack(s)');
  });

  it('a pipe 100 mm above the beams rests on nothing: no rack load, and the model gap is a warning', () => {
    const result = ok(pipeAt(5100), 'check_steel_members', {});
    const floating = result.data as { racks: Array<{ pipeLoadKn: number }>; warnings: string[] };
    expect(floating.racks[0]?.pipeLoadKn).toBe(0);
    expect(floating.warnings.join()).toContain('rests on no steel beam');
  });

  it('the level filter keeps the racks of that level', () => {
    const upper = apply(doc, 'add_level', { name: 'Upper', elevation: 7000, height: 3000 });
    expect(data<{ racks: unknown[] }>(upper, 'check_steel_members', { levelId: 'level-1' }).racks).toHaveLength(1);
  });
});

describe('takeoff, schedule and IFC of a rack', () => {
  const { doc } = build(PLAN_RACK);

  it('quantity_takeoff counts the rack and the steel by profile', () => {
    const lines = data<{ lines: Array<{ key: string; quantity: number }> }>(doc, 'quantity_takeoff', {}).lines;
    expect(lines.find((line) => line.key === 'platform.pipe_rack.ea')?.quantity).toBe(1);
    expect(lines.find((line) => line.key === 'member.HEB300.kg')?.quantity).toBeCloseTo(154 * 117, 6);
  });

  it('building_schedule kind platform lists the rack with its member count and steel kg', () => {
    const rows = data<{ rows: Array<Array<string | number>> }>(doc, 'building_schedule', { kind: 'platform' }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slice(0, 3)).toEqual(['AS1', 'pipe_rack', 100]);
    expect(rows[0]?.[8]).toBeCloseTo(35392.2, 1);
  });

  it('exports an IfcElementAssembly (USERDEFINED PIPE_RACK) aggregating its 100 members under one assembly, 40 of them .STRUT.', () => {
    const ifc = data<{ ifc: string }>(doc, 'export_ifc', {}).ifc;
    expect(ifc.match(/IFCELEMENTASSEMBLY\(/g)).toHaveLength(1);
    expect(ifc).toContain("'PIPE_RACK'");
    expect(ifc).toContain('.USERDEFINED.');
    expect(ifc.match(/\.STRUT\.\)/g)).toHaveLength(40);
    expect(ifc.match(/IFCCOLUMN\(/g)).toHaveLength(22);
    expect(ifc.match(/\.BRACE\.\)/g)).toHaveLength(16);
    const aggregates = ifc.split('\n').filter((line) => line.includes('IFCRELAGGREGATES'));
    expect(aggregates.some((line) => (line.match(/#\d+/g) ?? []).length === 102)).toBe(true);
  });
});

describe('hostile sizes never allocate before the cap (review fix)', () => {
  const { doc } = build(SMALL);

  it('refuses a run whose bay count is astronomical or not finite, without throwing', () => {
    const start = base();
    expectRefusal(start, 'add_pipe_rack', { ...SMALL, length: 1e12, bentSpacing: 1 }, 'STA_RACK_SPACING', 'bentSpacing');
    expectRefusal(start, 'add_pipe_rack', { ...SMALL, length: 1e300, bentSpacing: 1e-300 }, 'STA_RACK_SPACING', 'bentSpacing');
    expectRefusal(start, 'add_pipe_rack', { ...SMALL, length: 1e9, bentSpacing: 0.001 }, 'STA_RACK_SPACING', 'bentSpacing');
  });

  it('a loaded rack with a tiny bentSpacing is stale, not a crash, in every reader', () => {
    const copy = JSON.parse(JSON.stringify(doc)) as CadDocument;
    (copy.building?.elements['assembly-1'] as unknown as { params: { along: unknown } }).params.along = { length: 6000, bentSpacing: 1e-9 };
    expect(buildingErrors(copy.building)).toEqual([]);
    const checked = data<{ racks: Array<{ stale: boolean }> }>(copy, 'check_steel_members', {});
    expect(checked.racks[0]?.stale).toBe(true);
    expect(
      data<{ findings: Array<{ code: string }> }>(copy, 'check_access', { rulesets: ['iso_14122'] }).findings.map((f) => f.code),
    ).toContain('STA_RACK_STALE');
    expect(execute(copy, 'quantity_takeoff', {}).error).toBeUndefined();
    expectRefusal(copy, 'update_pipe_rack', { assemblyId: 'assembly-1' }, 'STA_RACK_SPACING');
  });

  it('the stored spec is bounded: too many tiers, bays across, bracing bays, an empty or long gridPrefix fail to load', () => {
    const errors = (change: (params: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(doc)) as CadDocument;
      change((copy.building?.elements['assembly-1'] as unknown as { params: Record<string, unknown> }).params);
      return buildingErrors(copy.building).join();
    };
    expect(errors((p) => (p['tiers'] = Array.from({ length: 13 }, (_, i) => 1000 * (i + 1))))).toContain('params are not');
    expect(errors((p) => (p['across'] = { baysAcross: Array(9).fill(1000) }))).toContain('params are not');
    expect(errors((p) => (p['bracingBays'] = Array.from({ length: 202 }, (_, i) => i + 1)))).toContain('params are not');
    expect(errors((p) => (p['gridPrefix'] = ''))).toContain('params are not');
    expect(errors((p) => (p['gridPrefix'] = 'ABCDEFGHI'))).toContain('params are not');
  });

  it('a circular platform with a tiny bracketSpacingMax is refused, not allocated', () => {
    const vessel = apply(base(), 'add_equipment', {
      name: 'Column',
      location: [0, 0],
      size: [3000, 3000, 18000],
      shape: 'vertical_vessel',
    });
    expectRefusal(
      vessel,
      'add_circular_access_platform',
      { equipmentId: 'equipment-1', elevation: 6000, width: 1000, bracketSpacingMax: 1e-9 },
      'STA_INVALID_GEOMETRY',
    );
  });
});
