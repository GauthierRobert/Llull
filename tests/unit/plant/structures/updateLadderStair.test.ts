/**
 * Plant 06 STA follow-up: update_ladder and update_steel_stair edit in place (same id, mark, level, arrival surface, hosted hand-rails) instead of
 * delete + add. Hand numbers: ladder 3000 mm: pitchMax 280 -> 11 spaces, 10 rungs; stair 3000 / riserMax 150 -> 20 risers of 150 mm; stair
 * 3000 / 180 / 280 has 17 risers (176.47 mm) and a run of 16 x 280 = 4480 mm.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { LadderElement, RailingElement, SteelStairElement } from '@aec/building/types';
import { buildingErrors } from '@aec/building/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { rect } from './accessFixtures';

interface Finding {
  code: string;
  ruleId: string;
  remediation: string;
}
interface Checked {
  findings: Finding[];
}
const check = (doc: CadDocument, include: string[], rulesets = ['iso_14122', 'osha_1910']): Finding[] =>
  data<Checked>(doc, 'check_access', { rulesets, include }).findings;

/** Grade 0 (level-1) and a deck level at 3000 (level-2) with a 3000 x 2000 slab (slab-1). */
function scene(slabLength = 3000): CadDocument {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  doc = apply(doc, 'add_level', { name: 'Deck', elevation: 3000, height: 3000 });
  return ok(doc, 'add_slab', { boundary: rect(0, 0, slabLength, 2000), thickness: 30, levelId: 'level-2' }).document;
}
const ladderOf = (doc: CadDocument, id = 'ladder-1'): LadderElement => {
  const element = doc.building?.elements[id];
  if (element?.category !== 'ladder') throw new Error(`no ladder ${id}`);
  return element;
};
const stairOf = (doc: CadDocument, id = 'steelStair-1'): SteelStairElement => {
  const element = doc.building?.elements[id];
  if (element?.category !== 'steelStair') throw new Error(`no stair ${id}`);
  return element;
};
const railingOf = (doc: CadDocument, id: string): RailingElement => {
  const element = doc.building?.elements[id];
  if (element?.category !== 'railing') throw new Error(`no railing ${id}`);
  return element;
};

describe('update_ladder', () => {
  const LADDER = { base: [1500, -250, 0], facing: [0, 1], attachTo: 'slab-1', levelId: 'level-1' };
  const narrow = (): CadDocument => ok(scene(), 'add_ladder', { ...LADDER, clearWidth: 300, fallProtection: 'none' }).document;

  it('fixes a width finding in place: same id, mark, order and arrival surface, new entities', () => {
    const before = narrow();
    expect(check(before, ['ladders']).map((finding) => finding.code)).toContain('STA_LADDER_WIDTH');
    const result = ok(before, 'update_ladder', { id: 'ladder-1', clearWidth: 450 });
    const after = result.document;
    expect(check(after, ['ladders']).map((finding) => finding.code)).not.toContain('STA_LADDER_WIDTH');
    expect(ladderOf(after)).toMatchObject({ id: 'ladder-1', mark: 'LD1', clearWidth: 450, arrivalSurfaceId: 'slab-1', levelId: 'level-1' });
    expect(ladderOf(after).base).toEqual(ladderOf(before).base);
    expect(after.building?.elementOrder).toEqual(before.building?.elementOrder);
    expect(result.affected).toContain('ladder-1');
    expect(result.affected.length).toBeGreaterThan(1);
    expect(result.data).toMatchObject({ elementIds: ['ladder-1'], clearWidthMm: 450, changed: ['clearWidth'] });
    expect(buildingErrors(after.building)).toEqual([]);
  });

  it('re-spaces the rungs for rungPitchMax (3000 / 280: 11 spaces, 10 rungs at 272.7 mm) and for an explicit rungPitch', () => {
    const before = narrow();
    const planned = ladderOf(apply(before, 'update_ladder', { id: 'ladder-1', rungPitchMax: 280 }));
    expect(planned.rungCount).toBe(10);
    expect(planned.rungPitch).toBeCloseTo(3000 / 11, 9);
    const explicit = ladderOf(apply(before, 'update_ladder', { id: 'ladder-1', rungPitch: 320 }));
    expect(explicit).toMatchObject({ rungCount: 9, rungPitch: 320 });
  });

  it('switches the cage on with the ISO defaults for what is not given, merges cage options, and drops it with another protection', () => {
    const before = narrow();
    const caged = apply(before, 'update_ladder', { id: 'ladder-1', fallProtection: 'cage', cage: { bars: 7 } });
    expect(ladderOf(caged).cage).toEqual({ startHeight: 2200, hoopSpacing: 1500, diameter: 650, bars: 7 });
    const wider = apply(caged, 'update_ladder', { id: 'ladder-1', cage: { diameter: 700 } });
    expect(ladderOf(wider).cage).toEqual({ startHeight: 2200, hoopSpacing: 1500, diameter: 700, bars: 7 });
    const dropped = apply(wider, 'update_ladder', { id: 'ladder-1', fallProtection: 'ladder_safety_system' });
    expect(ladderOf(dropped).cage).toBeUndefined();
  });

  it('re-measures the back clearance and sets landings, extension and installation date', () => {
    const walled = apply(narrow(), 'draw_walls', {
      points: [
        [0, -70],
        [3000, -70],
      ],
      thickness: 20,
      height: 4000,
      levelId: 'level-1',
    });
    const result = ok(walled, 'update_ladder', { id: 'ladder-1', railExtension: 1200, landings: [1500], installedOn: '2015-06-01' });
    expect(ladderOf(result.document)).toMatchObject({ railExtension: 1200, landings: [1500], installedOn: '2015-06-01' });
    expect(ladderOf(result.document).backClearance).toBeCloseTo(170, 6);
    expect((result.data as { backClearanceMm: number }).backClearanceMm).toBeCloseTo(170, 6);
  });

  it('cuts a gated gap when exit becomes through, and keeps it when the ladder is updated again', () => {
    const railed = apply(scene(), 'add_railing', {
      path: [
        [0, 0, 0],
        [3000, 0, 0],
      ],
      levelId: 'level-2',
    });
    const stepped = apply(railed, 'add_ladder', { ...LADDER, fallProtection: 'none', exit: 'side_step' });
    expect(railingOf(stepped, 'railing-1').openings).toEqual([]);
    const through = ok(stepped, 'update_ladder', { id: 'ladder-1', exit: 'through' });
    expect(through.data).toMatchObject({ gate: { status: 'cut', railingId: 'railing-1' } });
    expect(railingOf(through.document, 'railing-1').openings).toHaveLength(1);
    expect(through.affected).toContain('railing-1');
    const again = ok(through.document, 'update_ladder', { id: 'ladder-1', clearWidth: 420 });
    expect(again.data).toMatchObject({ gate: { status: 'existing' } });
  });

  it('refuses what add_ladder refuses, and is a no-op when nothing changes', () => {
    const doc = narrow();
    expectRefusal(doc, 'update_ladder', { id: 'slab-1', clearWidth: 450 }, 'STA_UNKNOWN_ELEMENT', 'id');
    expectRefusal(doc, 'update_ladder', { id: 'nope', clearWidth: 450 }, 'STA_UNKNOWN_ELEMENT');
    expectRefusal(doc, 'update_ladder', { id: 'ladder-1', rungPitch: 300, rungPitchMax: 300 }, 'STA_INVALID_GEOMETRY', 'rungPitch');
    expectRefusal(doc, 'update_ladder', { id: 'ladder-1', cage: { bars: 5 } }, 'STA_INVALID_GEOMETRY', 'cage');
    expectRefusal(doc, 'update_ladder', { id: 'ladder-1', landings: [2000, 1000] }, 'STA_INVALID_GEOMETRY', 'landings');
    expectRefusal(doc, 'update_ladder', { id: 'ladder-1', landings: [3000] }, 'STA_INVALID_GEOMETRY', 'landings');
    expectRefusal(doc, 'update_ladder', { id: 'ladder-1', installedOn: '2015-13-45' }, 'STA_INVALID_GEOMETRY', 'installedOn');
    expectRefusal(doc, 'update_ladder', { id: 'ladder-1', rungPitch: 1 }, 'STA_INVALID_GEOMETRY', 'rungPitch');
    expectRefusal(doc, 'update_ladder', { id: 'ladder-1', rungPitchMax: 50 }, 'STA_LADDER_PITCH_INFEASIBLE');
    expectNoOp(execute(doc, 'update_ladder', { id: 'ladder-1', clearWidth: 300 }), doc, 'nothing changed');
    expectNoOp(execute(doc, 'update_ladder', { id: 'ladder-1' }), doc, 'nothing changed');
  });

  it('is pure', () => {
    const doc = narrow();
    expectPure(doc, () => execute(doc, 'update_ladder', { id: 'ladder-1', clearWidth: 450, fallProtection: 'cage' }));
  });
});

describe('remediation texts', () => {
  it('name the update commands instead of delete + add', () => {
    const narrow = ok(scene(), 'add_ladder', {
      base: [1500, -250, 0],
      facing: [0, 1],
      attachTo: 'slab-1',
      levelId: 'level-1',
      clearWidth: 300,
    }).document;
    expect(check(narrow, ['ladders']).find((finding) => finding.code === 'STA_LADDER_WIDTH')?.remediation).toContain('update_ladder');
    const steep = ok(scene(6000), 'add_steel_stair', {
      start: [0, 0, 0],
      angle: 0,
      rise: 3000,
      riserMax: 180,
      going: 200,
      levelId: 'level-1',
    }).document;
    expect(check(steep, ['stairs']).find((finding) => finding.code === 'STA_STAIR_BLONDEL')?.remediation).toContain('update_steel_stair');
  });
});

describe('update_steel_stair', () => {
  const STAIR = { start: [0, 0, 0], angle: 0, rise: 3000, riserMax: 180, going: 280, levelId: 'level-1' };
  const railed = (extra: Record<string, unknown> = {}): CadDocument =>
    ok(scene(), 'add_steel_stair', { ...STAIR, railings: 'both', ...extra }).document;

  it('re-risers the stair in place: 20 risers of 150 mm, same ids, hand-rails re-laid with their ids and fields', () => {
    const before = railed();
    expect(stairOf(before).riserCount).toBe(17);
    const result = ok(before, 'update_steel_stair', { id: 'steelStair-1', riserMax: 150 });
    const after = result.document;
    expect(stairOf(after)).toMatchObject({
      id: 'steelStair-1',
      mark: 'SS1',
      riserCount: 20,
      riserHeight: 150,
      rise: 3000,
      going: 280,
      levelId: 'level-1',
    });
    expect(stairOf(after).start).toEqual([0, 0, 0]);
    expect(after.building?.elementOrder).toEqual(before.building?.elementOrder);
    expect(railingOf(before, 'railing-1').path).toHaveLength(17);
    expect(railingOf(after, 'railing-1').path).toHaveLength(20);
    expect(railingOf(after, 'railing-1')).toMatchObject({
      host: { hostId: 'steelStair-1' },
      role: 'handrail',
      height: railingOf(before, 'railing-1').height,
    });
    expect(railingOf(after, 'railing-2').host?.edges).toEqual([1]);
    expect(result.affected).toEqual(expect.arrayContaining(['steelStair-1', 'railing-1', 'railing-2']));
    expect(result.data).toMatchObject({ riserCount: 20, riserHeightMm: 150, railingIds: ['railing-1', 'railing-2'], flights: [20] });
    expect(buildingErrors(after.building)).toEqual([]);
  });

  it('fixes a Blondel finding: going 200 fails 2h+g (553 mm), going 280 passes', () => {
    const short = ok(scene(6000), 'add_steel_stair', { ...STAIR, going: 200 }).document;
    expect(check(short, ['stairs']).map((finding) => finding.ruleId)).toContain('ISO-STR-BLONDEL');
    const fixed = apply(short, 'update_steel_stair', { id: 'steelStair-1', going: 280 });
    expect(stairOf(fixed).going).toBe(280);
    expect(check(fixed, ['stairs']).map((finding) => finding.ruleId)).not.toContain('ISO-STR-BLONDEL');
  });

  it('sets width, profile, tread and landings (landingEvery 1500: 2 flights; explicit length)', () => {
    const before = railed();
    const edited = stairOf(
      apply(before, 'update_steel_stair', {
        id: 'steelStair-1',
        width: 1000,
        stringerProfile: 'UPN240',
        tread: { kind: 'checker_plate', thickness: 6 },
        landingEvery: 1500,
      }),
    );
    expect(edited).toMatchObject({ width: 1000, stringerProfile: 'UPN240', tread: { kind: 'checker_plate', thickness: 6 } });
    expect(edited.landings).toEqual([{ afterRiser: 9, length: 1000 }]);
    const explicit = stairOf(
      apply(before, 'update_steel_stair', {
        id: 'steelStair-1',
        landings: [{ afterRiser: 6, length: 900 }, { afterRiser: 12 }],
        landingLength: 800,
      }),
    );
    expect(explicit.landings).toEqual([
      { afterRiser: 6, length: 900 },
      { afterRiser: 12, length: 800 },
    ]);
    const lengthened = stairOf(
      apply(apply(before, 'update_steel_stair', { id: 'steelStair-1', landingEvery: 1500 }), 'update_steel_stair', {
        id: 'steelStair-1',
        landingLength: 1100,
      }),
    );
    expect(lengthened.landings).toEqual([{ afterRiser: 9, length: 1100 }]);
    const cleared = stairOf(
      apply(apply(before, 'update_steel_stair', { id: 'steelStair-1', landingEvery: 1500 }), 'update_steel_stair', {
        id: 'steelStair-1',
        landings: [],
      }),
    );
    expect(cleared.landings).toEqual([]);
  });

  it('keeps the arrival surface and refuses a change that moves the top out of its reach', () => {
    let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    doc = apply(doc, 'add_level', { name: 'Deck', elevation: 3000, height: 3000 });
    doc = ok(doc, 'add_slab', { boundary: rect(4480, -1500, 7000, 1500), thickness: 30, levelId: 'level-2' }).document;
    doc = ok(doc, 'add_steel_stair', { ...STAIR, rise: undefined, toSurfaceId: 'slab-1' }).document;
    expect(stairOf(doc).arrivalSurfaceId).toBe('slab-1');
    const longer = apply(doc, 'update_steel_stair', { id: 'steelStair-1', going: 300 });
    expect(stairOf(longer).arrivalSurfaceId).toBe('slab-1');
    expectRefusal(doc, 'update_steel_stair', { id: 'steelStair-1', going: 150 }, 'STA_NO_ARRIVAL_SURFACE', 'going');
  });

  it('refuses bad input with the reason, and is a no-op when nothing changes', () => {
    const doc = railed();
    expectRefusal(doc, 'update_steel_stair', { id: 'ladder-1', going: 300 }, 'STA_UNKNOWN_ELEMENT', 'id');
    expectRefusal(doc, 'update_steel_stair', { id: 'nope', going: 300 }, 'STA_UNKNOWN_ELEMENT');
    expectRefusal(doc, 'update_steel_stair', { id: 'steelStair-1', stringerProfile: 'ZZ9' }, 'STA_INVALID_GEOMETRY', 'stringerProfile');
    expectRefusal(
      doc,
      'update_steel_stair',
      { id: 'steelStair-1', tread: { kind: 'grating', gratingType: 'nope' } },
      'STA_GRATING_TYPE_UNKNOWN',
      'tread',
    );
    expectRefusal(doc, 'update_steel_stair', { id: 'steelStair-1', tread: { kind: 'grating' } }, 'STA_INVALID_GEOMETRY', 'tread');
    expectRefusal(
      doc,
      'update_steel_stair',
      { id: 'steelStair-1', landings: [{ afterRiser: 6 }], landingEvery: 1500 },
      'STA_INVALID_GEOMETRY',
      'landings',
    );
    expectRefusal(doc, 'update_steel_stair', { id: 'steelStair-1', landings: [{ afterRiser: 17 }] }, 'STA_INVALID_GEOMETRY', 'landings');
    expectRefusal(
      doc,
      'update_steel_stair',
      { id: 'steelStair-1', landings: [{ afterRiser: 8 }, { afterRiser: 6 }] },
      'STA_INVALID_GEOMETRY',
      'landings',
    );
    expectRefusal(doc, 'update_steel_stair', { id: 'steelStair-1', riserMax: 3000 }, 'STA_INVALID_GEOMETRY', 'riserMax');
    expectRefusal(doc, 'update_steel_stair', { id: 'steelStair-1', riserMax: 1 }, 'STA_INVALID_GEOMETRY', 'riserMax');
    expectNoOp(execute(doc, 'update_steel_stair', { id: 'steelStair-1', going: 280 }), doc, 'nothing changed');
    expectNoOp(execute(doc, 'update_steel_stair', { id: 'steelStair-1' }), doc, 'nothing changed');
  });

  it('refuses a riserMax that strands a landing past the last riser', () => {
    const doc = ok(scene(), 'add_steel_stair', { ...STAIR, landingEvery: 1500 }).document;
    expect(stairOf(doc).landings).toHaveLength(1);
    expectRefusal(doc, 'update_steel_stair', { id: 'steelStair-1', riserMax: 1000 }, 'STA_INVALID_GEOMETRY', 'riserMax');
  });

  it('refuses a hand-rail that no longer validates, and is pure', () => {
    const doc = railed();
    const broken = {
      ...doc,
      building: {
        ...(doc.building as NonNullable<CadDocument['building']>),
        elements: { ...doc.building?.elements, 'railing-1': { ...railingOf(doc, 'railing-1'), railProfile: 'ZZ9' } },
      },
    } as CadDocument;
    expectRefusal(broken, 'update_steel_stair', { id: 'steelStair-1', going: 300 }, 'STA_INVALID_GEOMETRY');
    expectPure(doc, () => execute(doc, 'update_steel_stair', { id: 'steelStair-1', riserMax: 150 }));
  });
});
