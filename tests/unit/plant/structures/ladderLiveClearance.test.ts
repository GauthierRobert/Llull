/**
 * Plant 06 STA follow-up: the back clearance of a ladder is measured against the model as it is now (`check_access` no longer reads only the value
 * stored when the ladder was added), and pipes, trays and the insulation of spec-driven runs count as objects behind the rungs.
 * Hand numbers: ladder base [1500, -250] facing +y, 5000 mm: 17 spaces, pitch 294.1, rung 10 at 2941 mm; a wall of 20 mm at y = -70 is 170 mm
 * from the rung centreline; a DN80 line at y = 0, z = 3000 is 155.55 mm away with its 50 mm insulation (radius 94.45) (the bare pipe bottom, 2955.55 mm, is above the 2941 mm rung).
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { liveBackClearance } from '@aec/plant/structures/ladder/ladderClearance';
import { boxFootprint } from '@aec/plant/structures/ladder/boxFootprint';
import { getBuilding } from '@aec/building/model';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document } from '../piping/rteFixtures';
import { rect } from './accessFixtures';

interface Checked {
  findings: Array<{ code: string; ruleset: string; measured: { value: number } }>;
  notEvaluated: Array<{ ruleId: string }>;
}
const checked = (doc: CadDocument): Checked => data<Checked>(doc, 'check_access', { rulesets: ['osha_1910'], include: ['ladders'] });
const backFindings = (doc: CadDocument): Checked['findings'] =>
  checked(doc).findings.filter((finding) => finding.code === 'STA_LADDER_BACK_CLEARANCE');

function levels(doc: CadDocument): CadDocument {
  let next = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 6000 });
  next = apply(next, 'add_level', { name: 'Platform', elevation: 5000, height: 3000 });
  return ok(next, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 30, levelId: 'level-2' }).document;
}
const LADDER = { base: [1500, -250, 0], facing: [0, 1], attachTo: 'slab-1', fallProtection: 'cage', levelId: 'level-1' };
const withLadder = (doc: CadDocument): CadDocument => ok(doc, 'add_ladder', LADDER).document;

function hotLine(insulated: boolean): CadDocument {
  const a = addTie(cs150Document(), 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
  const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
  const created = ok(b.doc, 'create_pipeline', {
    service: 'HO',
    sequence: '4001',
    spec: 'CS150',
    dn: 80,
    designTempC: 180,
    ...(insulated ? { insulation: { code: 'H', thickness: 'fromSpec' } } : {}),
  });
  return apply(created.document, 'route_pipe', { lineId: created.affected[0] as string, from: { portId: a.id }, to: { portId: b.id } });
}
const ladderOf = (doc: CadDocument): Parameters<typeof liveBackClearance>[2] => {
  const element = getBuilding(doc).elements['ladder-1'];
  if (element?.category !== 'ladder') throw new Error('no ladder');
  return element;
};

describe('check_access: ladder back clearance is measured now', () => {
  const walled = (doc: CadDocument): CadDocument =>
    apply(doc, 'draw_walls', {
      points: [
        [0, -70],
        [3000, -70],
      ],
      thickness: 20,
      height: 6000,
      levelId: 'level-1',
    });

  it('a wall added after the ladder is found: 170 mm fails OSHA 177.8 mm although the stored value is 2000 mm', () => {
    const ladder = withLadder(levels(apply(createEmptyDocument(), 'set_units', { units: 'mm' })));
    expect(ladderOf(ladder).backClearance).toBe(2000);
    expect(backFindings(ladder)).toEqual([]);
    const after = walled(ladder);
    expect(ladderOf(after).backClearance).toBe(2000);
    const [finding] = backFindings(after);
    expect(finding?.ruleset).toBe('osha_1910');
    expect(finding?.measured.value).toBeCloseTo(170, 6);
    expect(checked(after).notEvaluated.map((row) => row.ruleId)).not.toContain('ladder-back-clearance');
  });

  it('a wall removed later is no longer a finding', () => {
    const base = levels(apply(createEmptyDocument(), 'set_units', { units: 'mm' }));
    const near = withLadder(walled(base));
    expect(backFindings(near)).toHaveLength(1);
    const cleared = apply(near, 'delete_building_element', { elementIds: ['wall-1'] });
    expect(backFindings(cleared)).toEqual([]);
    expect(liveBackClearance(cleared, getBuilding(cleared), ladderOf(cleared))).toBe(2000);
  });

  it('a pipe line with insulation counts: the envelope (155.55 mm, reaches the 2941 mm rung) fails, the bare pipe (bottom 2955.55 mm) misses every rung', () => {
    const insulated = withLadder(levels(hotLine(true)));
    const [finding] = backFindings(insulated);
    expect(finding?.measured.value).toBeCloseTo(155.55, 6);
    expect(ladderOf(insulated).backClearance).toBeCloseTo(155.55, 6);
    const bare = withLadder(levels(hotLine(false)));
    expect(backFindings(bare)).toEqual([]);
    expect(ladderOf(bare).backClearance).toBe(2000);
  });

  it('a ladder whose level is gone falls back to the stored value', () => {
    const doc = withLadder(levels(apply(createEmptyDocument(), 'set_units', { units: 'mm' })));
    const building = getBuilding(doc);
    expect(liveBackClearance(doc, { ...building, levels: {} }, ladderOf(doc))).toBe(2000);
  });
});

describe('boxFootprint', () => {
  it('is the hull of the projected corners: a box turned 45 degrees is a diamond, z range from its half height', () => {
    const c = Math.SQRT1_2;
    const { ring, zMin, zMax } = boxFootprint({
      center: [10, 20, 5],
      axes: [
        [c, c, 0],
        [-c, c, 0],
        [0, 0, 1],
      ],
      half: [2, 2, 3],
    });
    expect(ring).toHaveLength(4);
    expect(Math.min(...ring.map((point) => point[0]))).toBeCloseTo(10 - 2 * Math.SQRT2, 9);
    expect(Math.max(...ring.map((point) => point[1]))).toBeCloseTo(20 + 2 * Math.SQRT2, 9);
    expect([zMin, zMax]).toEqual([2, 8]);
  });
});
