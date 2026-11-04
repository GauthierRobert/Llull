/**
 * Plant 06 STA follow-up: ISO-STR-HEADROOM over the pitch line of a steel stair (STA_STAIR_HEADROOM). Stair: rise 3000, riserMax 180, going 280 ->
 * 17 risers of 176.47 mm, stations s_i = (i - 1) x 280, nosing i at height i x 176.47; the stair plan is sampled every 50 mm (headroom error <= 50 mm
 * x slope 0.63 = 31.5 mm on an obstruction edge, never an overestimate of the clearance by more than that).
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { stairHeadroom } from '@aec/plant/structures/access/stairHeadroom';
import { getBuilding } from '@aec/building/model';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document } from '../piping/rteFixtures';
import { rect } from './accessFixtures';

interface Finding {
  code: string;
  ruleId: string;
  severity: string;
  ids: string[];
  location?: string;
  measured: { value: number; unit: string };
  limit: { min?: number };
}
interface Checked {
  findings: Finding[];
  stairHeadroom: Array<{ stairId: string; headroomMm: number | null; obstructionId: string | null }>;
  notEvaluated: Array<{ ruleId: string; reason: string }>;
  unverifiedRulesUsed: string[];
}
const check = (doc: CadDocument, rulesets = ['iso_14122']): Checked =>
  data<Checked>(doc, 'check_access', { rulesets, include: ['stairs'] });
const headroomFindings = (checked: Checked): Finding[] => checked.findings.filter((finding) => finding.code === 'STA_STAIR_HEADROOM');

const H = 3000 / 17;
function stairScene(rise = 3000): { doc: CadDocument; grade: string } {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  const grade = Object.keys(doc.building?.levels ?? {})[0] as string;
  doc = apply(doc, 'add_steel_stair', { start: [0, 0, 0], angle: 0, rise, riserMax: 180, going: 280, levelId: grade });
  return { doc, grade };
}
const beamAt = (doc: CadDocument, level: string, x: number, underside: number): CadDocument =>
  apply(doc, 'add_steel_member', {
    profile: 'IPE200',
    role: 'beam',
    start: [x, -1500, underside + 100],
    end: [x, 1500, underside + 100],
    levelId: level,
  });

describe('check_access: steel stair headroom (ISO-STR-HEADROOM)', () => {
  it('nothing above the stair: headroom null, no finding, the row is no longer under notEvaluated', () => {
    const { doc } = stairScene();
    const checked = check(doc);
    expect(checked.stairHeadroom).toEqual([{ stairId: 'steelStair-1', headroomMm: null, obstructionId: null }]);
    expect(headroomFindings(checked)).toEqual([]);
    expect(checked.notEvaluated.map((row) => row.ruleId)).not.toContain('ISO-STR-HEADROOM');
  });

  it('a beam 1815.8 mm over the pitch line at its high edge is a warning (grade B) naming the beam, and an UNVERIFIED companion', () => {
    const { doc, grade } = stairScene();
    // beam over x 1975..2075; the pitch line is highest at x = 2075: 8h + h x 115 / 280 = 1484.24 mm
    const high = 8 * H + (H * 115) / 280;
    const checked = check(beamAt(doc, grade, 2025, 3300));
    const [finding] = headroomFindings(checked);
    expect(finding).toMatchObject({ ruleId: 'ISO-STR-HEADROOM', severity: 'warn', ids: ['steelStair-1'], location: 'under member-1' });
    expect(finding?.limit.min).toBe(2300);
    expect(finding?.measured.value).toBeGreaterThanOrEqual(3300 - high - 1e-6);
    expect(finding?.measured.value).toBeLessThan(3300 - high + 16.5);
    expect(checked.stairHeadroom[0]?.obstructionId).toBe('member-1');
    expect(checked.unverifiedRulesUsed).toContain('ISO-STR-HEADROOM');
    expect(checked.findings.some((entry) => entry.code === 'STA_RULE_UNVERIFIED' && entry.ruleId === 'ISO-STR-HEADROOM')).toBe(true);
  });

  it('a beam 3900 mm over the nosings clears 2300 mm: reported, not a finding', () => {
    const { doc, grade } = stairScene();
    const checked = check(beamAt(doc, grade, 2025, 3900));
    expect(headroomFindings(checked)).toEqual([]);
    expect(checked.stairHeadroom[0]?.headroomMm).toBeGreaterThan(2300);
  });

  it('a beam beside the stair, and a beam below the pitch line, are not obstructions', () => {
    const { doc, grade } = stairScene();
    const beside = apply(doc, 'add_steel_member', {
      profile: 'IPE200',
      role: 'beam',
      start: [2025, 1000, 3200],
      end: [2025, 3000, 3200],
      levelId: grade,
    });
    expect(check(beside).stairHeadroom[0]?.headroomMm).toBeNull();
    const below = apply(doc, 'add_steel_member', {
      profile: 'IPE200',
      role: 'beam',
      start: [2025, -300, 100],
      end: [2025, 300, 100],
      levelId: grade,
    });
    expect(check(below).stairHeadroom[0]?.headroomMm).toBeNull();
  });

  it('a slab above the top of the stair reads 700 mm exactly; a well cut over the stair removes it', () => {
    const { doc } = stairScene();
    let upper = apply(doc, 'add_level', { name: 'Upper', elevation: 4000, height: 3000 });
    const level = Object.keys(upper.building?.levels ?? {}).find((id) => id !== 'level-1') as string;
    upper = apply(upper, 'add_slab', { boundary: rect(-1000, -2000, 6000, 2000), thickness: 300, levelId: level });
    const checked = check(upper);
    const [finding] = headroomFindings(checked);
    expect(finding?.measured.value).toBeCloseTo(700, 6);
    expect(finding?.location).toBe('under slab-1');
    const welled = apply(upper, 'add_slab_opening', { slabId: 'slab-1', boundary: rect(-500, -1000, 5500, 1000) });
    expect(check(welled).stairHeadroom[0]?.headroomMm).toBeNull();
  });

  it('the surface a stair arrives on is not an obstruction: a stair to a slab at its top reports null', () => {
    let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    doc = apply(doc, 'add_level', { name: 'Deck', elevation: 3000, height: 3000 });
    doc = ok(doc, 'add_slab', { boundary: rect(4480, -1500, 7000, 1500), thickness: 30, levelId: 'level-2' }).document;
    doc = ok(doc, 'add_steel_stair', {
      start: [0, 0, 0],
      angle: 0,
      toSurfaceId: 'slab-1',
      riserMax: 180,
      going: 280,
      levelId: 'level-1',
    }).document;
    expect(check(doc).stairHeadroom[0]).toMatchObject({ headroomMm: null });
  });

  it('a hot line over the stair is judged on its insulation: 905.55 mm to the envelope (DN80, 50 mm), not 955.55 mm to the bare pipe', () => {
    const a = addTie(cs150Document(), 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
    const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
    const created = ok(b.doc, 'create_pipeline', {
      service: 'HO',
      sequence: '4001',
      spec: 'CS150',
      dn: 80,
      designTempC: 180,
      insulation: { code: 'H', thickness: 'fromSpec' },
    });
    const routed = apply(created.document, 'route_pipe', {
      lineId: created.affected[0] as string,
      from: { portId: a.id },
      to: { portId: b.id },
    });
    const withLevel = apply(routed, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    const stair = apply(withLevel, 'add_steel_stair', {
      start: [0, 0, 0],
      angle: 0,
      rise: 2000,
      riserMax: 180,
      going: 280,
      levelId: 'level-1',
    });
    const checked = check(stair);
    const [finding] = headroomFindings(checked);
    expect(finding?.measured.value).toBeCloseTo(905.55, 6);
    expect(finding?.location).toMatch(/^under run-\d+(\.\d+)?\/pipe-1$/);
  });

  it('is judged only under iso_14122: osha_1910 alone lists the row as not evaluated and raises nothing', () => {
    const { doc, grade } = stairScene();
    const checked = check(beamAt(doc, grade, 2025, 3300), ['osha_1910']);
    expect(headroomFindings(checked)).toEqual([]);
    expect(checked.notEvaluated).toContainEqual({ ruleId: 'ISO-STR-HEADROOM', reason: 'judged only under iso_14122 (not requested)' });
  });

  it('a concrete stair keeps the row under notEvaluated, pointing at check_clashes', () => {
    let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    doc = apply(doc, 'add_level', { name: 'Ground', elevation: 0, height: 3500 });
    doc = apply(doc, 'add_level', { name: 'Level 1', elevation: 3500, height: 3500, makeActive: false });
    doc = apply(doc, 'add_stair', { start: [500, 1000], angle: 0, width: 1000, levelId: 'level-1' });
    const row = check(doc).notEvaluated.find((entry) => entry.ruleId === 'ISO-STR-HEADROOM');
    expect(row?.reason).toContain('check_clashes');
  });

  it('a stair whose level is gone has no report, and the check is pure', () => {
    const { doc, grade } = stairScene();
    const building = getBuilding(doc);
    const stair = building.elements['steelStair-1'];
    if (stair?.category !== 'steelStair') throw new Error('no stair');
    expect(stairHeadroom(doc, { ...building, levels: {} }, stair)).toBeNull();
    const scene = beamAt(doc, grade, 2025, 3300);
    expectPure(scene, () => check(scene));
  });
});
