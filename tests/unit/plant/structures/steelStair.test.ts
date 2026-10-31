/**
 * Plant 06 STA M5: add_steel_stair (VC-STA-04 closed form: n = ceil(rise / riserMax), h = rise / n, treads = n - 1 - landings, run, 2h + g, pitch),
 * landings, hosted hand-rails, the stair rules of check_access, evaluation, takeoff, schedule, persistence, IFC and budgets.
 * Hand numbers: 3000 / 180 -> 17 risers of 176.4706 mm; with landingEvery 2000 -> 2 flights of 9 + 8 risers, one 800 mm landing,
 * 15 treads, run 15 x 280 + 800 = 5000 mm; 4500 / 190 -> 24 risers of 187.5 mm (flight rise 4500 > 3000).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { SteelStairElement } from '@aec/building/types';
import { buildingErrors } from '@aec/building/validate';
import { handrailPath, layoutSteelStair } from '@aec/plant/structures/stair/steelStairLayout';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { BOTH, rect } from './accessFixtures';

const base = (): { doc: CadDocument; grade: string; top: string } => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  const grade = Object.keys(doc.building?.levels ?? {})[0] as string;
  doc = apply(doc, 'add_level', { name: '+3000', elevation: 3000, height: 3000 });
  const top = Object.keys(doc.building?.levels ?? {}).find((id) => id !== grade) as string;
  return { doc, grade, top };
};
const STAIR = { start: [0, 0, 0], angle: 0, rise: 3000, riserMax: 180, going: 280 };
const stairOf = (doc: CadDocument, id = 'steelStair-1'): SteelStairElement => {
  const element = doc.building?.elements[id];
  if (element?.category !== 'steelStair') throw new Error(`no steel stair ${id}`);
  return element;
};
interface StairData {
  elementIds: string[];
  stairId: string;
  railingIds: string[];
  riserCount: number;
  treadCount: number;
  riserHeightMm: number;
  blondelMm: number;
  pitchDeg: number;
  runMm: number;
  flights: number[];
  steelKg: number;
  defaults: string[];
  arrivalSurfaceId: string | null;
}
const add = (f: { doc: CadDocument; grade: string }, extra: Record<string, unknown> = {}): CommandResult =>
  ok(f.doc, 'add_steel_stair', { ...STAIR, levelId: f.grade, ...extra });
const stairData = (result: { data?: unknown }): StairData => result.data as StairData;

describe('add_steel_stair: closed form (VC-STA-04)', () => {
  const f = base();

  it('3000 / 180 / 280: 17 risers, 16 treads, 2h+g 632.94, 32.22 deg, run 4480', () => {
    const answer = stairData(add(f));
    expect(answer.riserCount).toBe(17);
    expect(answer.treadCount).toBe(16);
    expect(answer.riserHeightMm).toBeCloseTo(176.4706, 3);
    expect(answer.blondelMm).toBeCloseTo(632.9412, 3);
    expect(answer.pitchDeg).toBeCloseTo(32.2213, 3);
    expect(answer.runMm).toBeCloseTo(4480, 3);
    expect(answer.flights).toEqual([17]);
    expect(answer.railingIds).toEqual([]);
    expect(answer.defaults.join(';')).toContain('width 800 mm');
  });

  it('4500 / 190 / 250: 24 risers of 187.5 mm, pitch 36.87, run 5750', () => {
    const answer = stairData(add(f, { rise: 4500, riserMax: 190, going: 250 }));
    expect([answer.riserCount, answer.treadCount, answer.riserHeightMm, answer.runMm]).toEqual([24, 23, 187.5, 5750]);
    expect(answer.pitchDeg).toBeCloseTo(36.8699, 3);
  });

  it('2400 / 220 / 200: 11 risers of 218.18 mm, 2h+g 636.36, 47.49 deg', () => {
    const answer = stairData(add(f, { rise: 2400, riserMax: 220, going: 200 }));
    expect([answer.riserCount, answer.treadCount, answer.runMm]).toEqual([11, 10, 2000]);
    expect(answer.blondelMm).toBeCloseTo(636.3636, 3);
    expect(answer.pitchDeg).toBeCloseTo(47.4896, 3);
  });

  it('inserts landings: flights 9 + 8, 15 treads, run 15 x 280 + 800', () => {
    const answer = stairData(add(f, { landingEvery: 2000 }));
    expect(answer.flights).toEqual([9, 8]);
    expect(answer.treadCount).toBe(15);
    expect(answer.runMm).toBeCloseTo(5000, 6);
    expect(answer.defaults.join(';')).toContain('landing length 800');
  });

  it('takes explicit landings with their own length and rotates with the angle', () => {
    const result = add(f, { landings: [{ afterRiser: 6, length: 1000 }, { afterRiser: 12 }], angle: Math.PI / 2 });
    const stair = stairOf(result.document);
    expect(stair.landings).toEqual([
      { afterRiser: 6, length: 1000 },
      { afterRiser: 12, length: 800 },
    ]);
    const layout = layoutSteelStair(stair, { stringerWeb: 8.5, stringerDepth: 200 });
    expect(layout.treads).toHaveLength(14);
    expect(layout.landings).toHaveLength(2);
    expect(layout.run).toBeCloseTo(14 * 280 + 1800, 6);
    expect(layout.stringers[0]?.from[0]).toBeCloseTo(-(400 + 4.25), 6);
  });

  it('rise from a slab: toSurfaceId', () => {
    const slab = ok(f.doc, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 30, levelId: f.top });
    const slabId = slab.affected[0] as string;
    const answer = stairData(
      ok(slab.document, 'add_steel_stair', { ...STAIR, rise: undefined, start: [-4480, 1000, 0], toSurfaceId: slabId, levelId: f.grade }),
    );
    expect(answer.riserCount).toBe(17);
    expect(answer.arrivalSurfaceId).toBe(slabId);
    expectRefusal(
      slab.document,
      'add_steel_stair',
      { ...STAIR, rise: undefined, start: [-9000, 1000, 0], toSurfaceId: slabId, levelId: f.grade },
      'STA_NO_ARRIVAL_SURFACE',
    );
  });
});

describe('add_steel_stair: refusals', () => {
  const f = base();
  it('refuses bad input and leaves the document unchanged', () => {
    expectRefusal(f.doc, 'add_steel_stair', { ...STAIR, rise: undefined, levelId: f.grade }, 'STA_INVALID_GEOMETRY', 'rise');
    expectRefusal(f.doc, 'add_steel_stair', { ...STAIR, toSurfaceId: 'slab-1', levelId: f.grade }, 'STA_INVALID_GEOMETRY');
    expectRefusal(f.doc, 'add_steel_stair', { ...STAIR, toSurfaceId: 'nope', rise: undefined, levelId: f.grade }, 'STA_UNKNOWN_ELEMENT');
    expectRefusal(
      f.doc,
      'add_steel_stair',
      { ...STAIR, stringerProfile: 'XX1', levelId: f.grade },
      'STA_INVALID_GEOMETRY',
      'stringerProfile',
    );
    expectRefusal(
      f.doc,
      'add_steel_stair',
      { ...STAIR, tread: { kind: 'grating', gratingType: 'nope' }, levelId: f.grade },
      'STA_GRATING_TYPE_UNKNOWN',
    );
    expectRefusal(f.doc, 'add_steel_stair', { ...STAIR, rise: 40000, levelId: f.grade }, 'STA_INVALID_GEOMETRY', 'rise');
    expectRefusal(f.doc, 'add_steel_stair', { ...STAIR, rise: 150, levelId: f.grade }, 'STA_INVALID_GEOMETRY', 'riserMax');
    expectRefusal(f.doc, 'add_steel_stair', { ...STAIR, rise: 29000, riserMax: 100, levelId: f.grade }, 'STA_INVALID_GEOMETRY', 'riserMax');
    expectRefusal(
      f.doc,
      'add_steel_stair',
      { ...STAIR, landings: [{ afterRiser: 3 }], landingEvery: 1000, levelId: f.grade },
      'STA_INVALID_GEOMETRY',
    );
    expectRefusal(
      f.doc,
      'add_steel_stair',
      { ...STAIR, landings: [{ afterRiser: 16 }], levelId: f.grade },
      'STA_INVALID_GEOMETRY',
      'landings',
    );
    expectRefusal(
      f.doc,
      'add_steel_stair',
      { ...STAIR, landings: [{ afterRiser: 8 }, { afterRiser: 6 }], levelId: f.grade },
      'STA_INVALID_GEOMETRY',
      'landings',
    );
    expectRefusal(f.doc, 'add_steel_stair', { ...STAIR, levelId: 'ghost' }, 'STA_INVALID_GEOMETRY', 'levelId');
  });

  it('refuses a twin, is pure and replays to the same document', () => {
    expectPure(f.doc, () => execute(f.doc, 'add_steel_stair', { ...STAIR, levelId: f.grade }));
    const built = add(f, { railings: 'both' }).document;
    expectRefusal(built, 'add_steel_stair', { ...STAIR, levelId: f.grade }, 'STA_INVALID_GEOMETRY');
    const replayed = execute(built, 'replay_history', {}).document;
    expect(replayed.building?.elements['steelStair-1']).toEqual(built.building?.elements['steelStair-1']);
    expect(Object.keys(replayed.entities).sort()).toEqual(Object.keys(built.entities).sort());
  });
});

describe('add_steel_stair: hand-rails', () => {
  const f = base();
  const built = add(f, { railings: 'both', railingHeight: 1100, landingEvery: 2000 });

  it('creates one hosted handrail per side along the nosing line', () => {
    const ids = stairData(built).railingIds;
    expect(ids).toHaveLength(2);
    const [left, right] = ids.map((id) => built.document.building?.elements[id]);
    expect(left?.category === 'railing' && left.role).toBe('handrail');
    expect(left?.category === 'railing' && left.host).toEqual({ hostId: 'steelStair-1', ring: 'boundary', edges: [0] });
    expect(right?.category === 'railing' && right.host?.edges).toEqual([1]);
    expect(left?.category === 'railing' && left.path).toHaveLength(18);
    expect(left?.category === 'railing' && left.height).toBe(1100);
    expect(built.affected).toContain('steelStair-1');
  });

  it('left and right paths mirror each other about the axis', () => {
    const stair = stairOf(built.document);
    const sizes = { stringerWeb: 8.5, stringerDepth: 200 };
    const [left, right] = [handrailPath(stair, sizes, 1), handrailPath(stair, sizes, -1)];
    expect(left[0]?.[1]).toBeCloseTo(404.25, 6);
    expect(right[0]?.[1]).toBeCloseTo(-404.25, 6);
    expect(left.map((point) => point[2])).toEqual(right.map((point) => point[2]));
  });

  it('only one side, default height from the rulesets (1100 mm) and the named knee rails', () => {
    const one = add(f, { railings: 'left' });
    expect(stairData(one).railingIds).toHaveLength(1);
    const railing = one.document.building?.elements[stairData(one).railingIds[0] as string];
    expect(railing?.category === 'railing' && railing.height).toBe(1100);
    expect(railing?.category === 'railing' && railing.kneeRails).toBe(2);
    expect(stairData(one).defaults.join(';')).toContain('railingHeight');
    const right = add(f, { railings: 'right', railingHeight: 1000 });
    expect(stairData(right).railingIds).toHaveLength(1);
  });

  it('refuses a hand-rail height that cannot hold the rails', () => {
    expectRefusal(
      f.doc,
      'add_steel_stair',
      { ...STAIR, levelId: f.grade, railings: 'both', railingHeight: 60 },
      'STA_INVALID_GEOMETRY',
      'railingHeight',
    );
  });

  it('moves with the stair and is deleted with it; the rail alone cannot move', () => {
    const moved = apply(built.document, 'move_building_element', { elementIds: ['steelStair-1'], delta: [100, 50] });
    expect(stairOf(moved).start).toEqual([100, 50, 0]);
    const railing = moved.building?.elements['railing-1'];
    const before = built.document.building?.elements['railing-1'];
    expect(railing?.category === 'railing' && railing.path[0]?.[0]).toBeCloseTo(
      ((before?.category === 'railing' ? before.path[0]?.[0] : NaN) as number) + 100,
      6,
    );
    const alone = execute(built.document, 'move_building_element', { elementIds: ['railing-1'], delta: [1, 1] });
    expect(alone.affected).toEqual([]);
    const removed = apply(built.document, 'delete_building_element', { elementIds: ['steelStair-1'] });
    expect(Object.keys(removed.building?.elements ?? {}).filter((id) => id.startsWith('railing'))).toEqual([]);
  });
});

describe('check_access on steel stairs (VC-STA-04 rule part)', () => {
  const f = base();
  interface Check {
    verdict: string;
    findings: Array<{ code: string; ruleset: string; severity: string; ids: string[] }>;
    byId: Record<string, { verdict: string }>;
    checked: { stairs: number };
    notEvaluated: Array<{ ruleId: string }>;
  }
  it('passes the 3000 / 180 / 280 stair under both rulesets', () => {
    const doc = add(f).document;
    const checked = data<Check>(doc, 'check_access', { rulesets: BOTH });
    expect(checked.verdict).toBe('pass');
    expect(checked.checked.stairs).toBe(1);
    expect(checked.byId['steelStair-1']?.verdict).toBe('pass');
    expect(checked.notEvaluated.map((row) => row.ruleId)).toContain('ISO-STR-HEADROOM');
  });

  it('fails OSHA tread for going 200 and keeps Blondel inside 600..660', () => {
    const doc = add(f, { rise: 2400, riserMax: 220, going: 200 }).document;
    const checked = data<Check>(doc, 'check_access', { rulesets: BOTH, ids: ['steelStair-1'] });
    const tread = checked.findings.find((finding) => finding.code === 'STA_STAIR_TREAD');
    expect(tread?.ruleset).toBe('osha_1910');
    expect(tread?.severity).toBe('fail');
    expect(checked.findings.some((finding) => finding.code === 'STA_STAIR_BLONDEL')).toBe(false);
  });

  it('warns on a 4500 mm flight (B rule) and a landing fixes it', () => {
    const tall = add(f, { rise: 4500, riserMax: 190, going: 250 }).document;
    const warned = data<Check>(tall, 'check_access', { rulesets: ['iso_14122'] });
    expect(warned.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['STA_STAIR_FLIGHT_RISE', 'STA_RULE_UNVERIFIED']),
    );
    expect(warned.verdict).toBe('warn');
    const landed = add(f, { rise: 4500, riserMax: 190, going: 250, landingEvery: 3000 }).document;
    expect(data<Check>(landed, 'check_access', { rulesets: ['iso_14122'] }).findings).toEqual([]);
  });

  it('flags a narrow stair against both width rows', () => {
    const doc = add(f, { width: 500 }).document;
    const codes = data<Check>(doc, 'check_access', { rulesets: BOTH }).findings.map((finding) => finding.code);
    expect(codes.filter((code) => code === 'STA_STAIR_WIDTH')).toHaveLength(2);
  });
});

describe('steel stair evaluation, takeoff, schedule, persistence, IFC', () => {
  const f = base();
  const built = add(f, { railings: 'both', railingHeight: 1100, landingEvery: 2000 }).document;

  it('derives stringers, treads and landings on layer S-STAR', () => {
    const element = stairOf(built);
    expect(element.entityIds).toHaveLength(3);
    for (const id of element.entityIds) {
      expect(built.entities[id]?.kind).toBe('mesh');
      expect(built.entities[id]?.layerId).toBe('layer-S-STAR');
    }
    const plate = add(f, { tread: { kind: 'checker_plate', thickness: 6 } }).document;
    expect(stairOf(plate).entityIds).toHaveLength(2);
  });

  it('lists steelStair lines in quantity_takeoff and a stair_steel schedule', () => {
    const lines = data<{ lines: Array<{ key: string; quantity: number }> }>(built, 'quantity_takeoff', {}).lines;
    const byKey = Object.fromEntries(lines.map((line) => [line.key, line.quantity]));
    expect(byKey['steelStair.tread.ea']).toBe(15);
    expect(byKey['steelStair.landing.ea']).toBe(1);
    expect(byKey['steelStair.stringer.m']).toBeCloseTo(9.929, 2);
    expect(byKey['steelStair.steel.kg']).toBeGreaterThan(200);
    expect(byKey['railing.rail.m']).toBeGreaterThan(10);
    const schedule = data<{ rows: Array<Array<string | number>> }>(built, 'building_schedule', { kind: 'stair_steel' });
    expect(schedule.rows).toHaveLength(1);
    expect(schedule.rows[0]?.slice(0, 3)).toEqual(['SS1', 3000, 17]);
  });

  it('weighs a plate stair from the plate thickness', () => {
    const plate = add(f, { tread: { kind: 'checker_plate', thickness: 8 } });
    expect(stairData(plate).steelKg).toBeGreaterThan(stairData(add(f, { tread: { kind: 'checker_plate', thickness: 4 } })).steelKg);
  });

  it('validates a loaded steel stair and its hosted railing', () => {
    expect(buildingErrors(built.building)).toEqual([]);
    const damage = (edit: (elements: Record<string, Record<string, unknown>>) => void): string[] => {
      const copy = JSON.parse(JSON.stringify(built.building)) as { elements: Record<string, Record<string, unknown>> };
      edit(copy.elements);
      return buildingErrors(copy);
    };
    const stair = (elements: Record<string, Record<string, unknown>>): Record<string, unknown> =>
      elements['steelStair-1'] as Record<string, unknown>;
    expect(damage((e) => (stair(e)['start'] = [1, 2])).join()).toContain('start');
    expect(damage((e) => (stair(e)['stringerProfile'] = 'ZZ')).join()).toContain('stringerProfile');
    expect(damage((e) => (stair(e)['riserCount'] = 1.5)).join()).toContain('riserCount');
    expect(damage((e) => (stair(e)['tread'] = { kind: 'grating', gratingType: 'x' })).join()).toContain('tread');
    expect(damage((e) => (stair(e)['tread'] = { kind: 'checker_plate' })).join()).toContain('tread');
    expect(damage((e) => (stair(e)['landings'] = [{ afterRiser: 1, length: 5 }])).join()).toContain('landings');
    expect(damage((e) => (stair(e)['landings'] = 'x')).join()).toContain('landings');
    expect(damage((e) => (stair(e)['arrivalSurfaceId'] = 3)).join()).toContain('arrivalSurfaceId');
    expect(damage((e) => (stair(e)['going'] = -1)).length).toBeGreaterThan(0);
    expect(damage((e) => delete e['steelStair-1']).join()).toContain('host');
  });

  it('exports IfcStair with flights, stringers and a landing', () => {
    const ifc = data<{ ifc: string }>(built, 'export_ifc', {}).ifc;
    expect(ifc.match(/=IFCSTAIR\([^\n]*\.TWO_STRAIGHT_RUN_STAIR\.\);/g)).toHaveLength(1);
    expect(ifc.match(/=IFCSTAIRFLIGHT\([^\n]*\.STRAIGHT\.\);/g)).toHaveLength(2);
    expect(ifc.match(/=IFCMEMBER\([^\n]*\.STRINGER\.\);/g)).toHaveLength(4);
    expect(ifc.match(/=IFCSLAB\([^\n]*\.LANDING\.\);/g)).toHaveLength(1);
    expect(ifc.match(/=IFCRAILING\([^\n]*\.HANDRAIL\.\);/g)).toHaveLength(2);
    expect(ifc).toContain("'Pset_llullSteelStair'");
    const straight = data<{ ifc: string }>(add(f).document, 'export_ifc', {}).ifc;
    expect(straight).toMatch(/=IFCSTAIR\([^\n]*\.STRAIGHT_RUN_STAIR\.\);/);
    const multi = data<{ ifc: string }>(add(f, { landings: [{ afterRiser: 4 }, { afterRiser: 9 }] }).document, 'export_ifc', {}).ifc;
    expect(multi).toMatch(/=IFCSTAIR\([^\n]*'MULTI_FLIGHT_STRAIGHT_STAIR'[^\n]*\.USERDEFINED\.\);/);
  });

  it('uses only enum strings of the IFC 4.3 pack', () => {
    const dir = path.resolve(__dirname, '../../../../docs/plant/06-plant-structures-access/validation/data/ifc4x3_enums');
    const stairs = readFileSync(path.join(dir, 'IfcStairTypeEnum.md'), 'utf8');
    for (const name of ['STRAIGHT_RUN_STAIR', 'TWO_STRAIGHT_RUN_STAIR', 'USERDEFINED']) expect(stairs).toContain(`### ${name}`);
    expect(readFileSync(path.join(dir, 'IfcStairFlightTypeEnum.md'), 'utf8')).toContain('### STRAIGHT');
    expect(readFileSync(path.join(dir, 'IfcMemberTypeEnum.md'), 'utf8')).toContain('### STRINGER');
    expect(readFileSync(path.join(dir, 'IfcSlabTypeEnum.md'), 'utf8')).toContain('### LANDING');
  });

  it('does not export a stair whose tread type left the catalogue', () => {
    const copy = JSON.parse(JSON.stringify(built)) as CadDocument;
    (copy.building?.elements['steelStair-1'] as unknown as { tread: unknown }).tread = { kind: 'grating', gratingType: 'gone' };
    expect(data<{ ifc: string }>(copy, 'export_ifc', {}).ifc).not.toContain('Pset_llullSteelStair');
  });

  it('stays within generous time budgets (200 risers)', () => {
    const started = performance.now();
    const doc = add(f, { rise: 30000, riserMax: 150, going: 280, landingEvery: 3000, railings: 'both', railingHeight: 1100 }).document;
    data(doc, 'check_access', { rulesets: BOTH });
    data(doc, 'export_ifc', {});
    expect(performance.now() - started).toBeLessThan(10000);
  });
});
