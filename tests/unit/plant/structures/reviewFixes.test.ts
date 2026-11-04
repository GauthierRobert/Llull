/**
 * Plant 06 STA follow-up review fixes: stair hand-rails against the arrival platform guard-rail, hostile imposedLoadKPa, narrow obstructions over a stair
 * (edge samples), and the gate report of update_ladder.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { buildingErrors } from '@aec/building/validate';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { TYPE, gratedFrame, rect } from './accessFixtures';

const clashes = (doc: CadDocument): Array<{ a: string; b: string }> =>
  data<{ clashes: Array<{ a: string; b: string }> }>(doc, 'check_clashes', {}).clashes;

describe('hand-rails against the platform guard-rail', () => {
  it('a platform railed on all edges with a stair (both hand-rails) arriving on it reports no clash', () => {
    let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
    doc = apply(doc, 'add_access_platform', {
      bounds: [
        [0, 0],
        [6000, 3000],
      ],
      topOffset: 3000,
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      railing: { edges: 'all' },
      levelId: 'level-1',
    });
    doc = apply(doc, 'add_steel_stair', {
      start: [-4480, 1500, 0],
      angle: 0,
      toSurfaceId: 'assembly-1',
      riserMax: 180,
      going: 280,
      railings: 'both',
      levelId: 'level-1',
    });
    expect(clashes(doc)).toEqual([]);
  });
});

describe('imposedLoadKPa is validated on load', () => {
  it('a grating with a negative, non-finite or non-number load is a building error', () => {
    const { doc, ids } = gratedFrame({ imposedLoadKPa: 2 });
    const building = doc.building;
    if (building === undefined) throw new Error('no building');
    expect(buildingErrors(building)).toEqual([]);
    const withLoad = (value: unknown): ReturnType<typeof buildingErrors> =>
      buildingErrors({
        ...building,
        elements: { ...building.elements, [ids[0] as string]: { ...building.elements[ids[0] as string], imposedLoadKPa: value } },
      } as typeof building);
    for (const bad of [-1, 'x', Number.NaN, null]) expect(withLoad(bad).join(' ')).toContain('imposedLoadKPa');
    expect(withLoad(0)).toEqual([]);
  });
});

describe('stair headroom: narrow obstructions', () => {
  it('a 20 mm bar between two 50 mm stations is found: 2174.4 mm over the pitch line at its high edge', () => {
    let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    doc = apply(doc, 'add_steel_stair', { start: [0, 0, 0], angle: 0, rise: 3000, riserMax: 180, going: 280, levelId: 'level-1' });
    doc = apply(doc, 'add_steel_member', {
      profile: 'RD20',
      role: 'beam',
      start: [1020, -1000, 3010],
      end: [1020, 1000, 3010],
      levelId: 'level-1',
    });
    const checked = data<{ stairHeadroom: Array<{ headroomMm: number | null; obstructionId: string | null }> }>(doc, 'check_access', {
      rulesets: ['iso_14122'],
      include: ['stairs'],
    });
    // highest pitch under x 1010..1030 is at 1030: 4h + h x 190 / 280, h = 3000 / 17
    const high = (4 * 3000) / 17 + ((3000 / 17) * 190) / 280;
    expect(checked.stairHeadroom[0]?.obstructionId).toBe('member-1');
    expect(checked.stairHeadroom[0]?.headroomMm).toBeCloseTo(3000 - high, 1);
  });
});

describe('update_ladder gate report', () => {
  const LADDER = { base: [1500, -250, 0], facing: [0, 1], attachTo: 'slab-1', levelId: 'level-1', fallProtection: 'none' };
  function scene(): CadDocument {
    let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    doc = apply(doc, 'add_level', { name: 'Deck', elevation: 3000, height: 3000 });
    return ok(doc, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 30, levelId: 'level-2' }).document;
  }

  it('through -> side_step says that a gate cut earlier stays', () => {
    const doc = apply(scene(), 'add_ladder', LADDER);
    const result = ok(doc, 'update_ladder', { id: 'ladder-1', exit: 'side_step' });
    expect(result.data).toMatchObject({ gate: { status: 'none' } });
    expect((result.data as { gate: { reason: string } }).gate.reason).toContain('side_step');
    expect(result.summary).toContain('gated gap cut earlier stays');
  });

  it('exit through on a ladder without an arrival surface reports a skipped gate with the reason', () => {
    const doc = apply(scene(), 'add_ladder', { ...LADDER, exit: 'side_step' });
    const building = doc.building;
    if (building === undefined) throw new Error('no building');
    const ladder = building.elements['ladder-1'];
    if (ladder?.category !== 'ladder') throw new Error('no ladder');
    const { arrivalSurfaceId: _gone, ...bare } = ladder;
    const orphan = { ...doc, building: { ...building, elements: { ...building.elements, 'ladder-1': bare } } } as CadDocument;
    const result = execute(orphan, 'update_ladder', { id: 'ladder-1', exit: 'through' });
    expect(result.rejected).toBeUndefined();
    expect(result.data).toMatchObject({ gate: { status: 'skipped' } });
    expect((result.data as { gate: { reason: string } }).gate.reason).toContain('no arrival surface');
  });
});
