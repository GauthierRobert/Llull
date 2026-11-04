/**
 * Plant 06 STA follow-up (FR-STA-15): grating panels are load surfaces of check_steel_members. Dead load = the catalogue kg/m² of the type x 9.80665 / 1000
 * (not floorDeadLoad), imposed = the panel imposedLoadKPa (add_grating, update_grating, the platform commands) else the imposedLoad default (5 kN/m²).
 * Hand numbers: the SC-STA-06 frame is 3324 x 3000 mm = 9.972 m²; raising the imposed load by 5 kPa adds 1.5 x 5 x 9.972 = 74.79 kN to the ULS end reactions of the beams (the frame's beams do not meet its columns).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { findGratingType } from '@aec/plant/structures/grating/gratingTypes';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { gratedFrame, gratingFrame, TYPE } from './accessFixtures';

interface Floor {
  slabId: string;
  kind: string;
  imposedKnM2: number;
  areaM2: number;
  deadKn: number;
  imposedKn: number;
}
interface Steel {
  loads: { floors: Floor[] };
  members: Array<{ role: string; forces?: { reactionStart?: number; reactionEnd?: number } }>;
}
const steel = (doc: CadDocument, params: Record<string, unknown> = {}): Steel => data<Steel>(doc, 'check_steel_members', params);
/** ULS reactions of every beam end, kN: what the beams deliver, the grating load included. */
const beamReactions = (result: Steel): number =>
  result.members
    .filter((member) => member.role === 'beam')
    .reduce((sum, member) => sum + (member.forces?.reactionStart ?? 0) + (member.forces?.reactionEnd ?? 0), 0);
const GRAVITY = 9.80665;
const mass = findGratingType(TYPE)?.massKgM2 ?? 0;

describe('check_steel_members: grating panels as load surfaces', () => {
  it('lists each panel with kind "grating", the catalogue self-weight and the 5 kN/m2 default imposed load', () => {
    const { doc, ids } = gratedFrame();
    const { floors } = steel(doc).loads;
    expect(floors.map((floor) => floor.slabId)).toEqual(ids);
    expect(floors.every((floor) => floor.kind === 'grating' && floor.imposedKnM2 === 5)).toBe(true);
    const area = floors.reduce((sum, floor) => sum + floor.areaM2, 0);
    expect(area).toBeCloseTo(9.972, 4);
    expect(floors.reduce((sum, floor) => sum + floor.deadKn, 0)).toBeCloseTo((area * mass * GRAVITY) / 1000, 6);
    expect(floors.reduce((sum, floor) => sum + floor.imposedKn, 0)).toBeCloseTo(area * 5, 3);
  });

  it('a frame with no grating and no slab has no surfaces', () => {
    expect(steel(gratingFrame()).loads.floors).toEqual([]);
  });

  it('the imposedLoad default of the check applies to panels without their own value', () => {
    const { doc } = gratedFrame();
    const { floors } = steel(doc, { imposedLoad: 3 }).loads;
    expect(floors.every((floor) => floor.imposedKnM2 === 3)).toBe(true);
  });

  it('add_grating imposedLoadKPa wins over the default, and reaches the beams: +5 kPa adds 74.79 kN of ULS reactions', () => {
    const light = gratedFrame({ imposedLoadKPa: 2.5 });
    const heavy = gratedFrame({ imposedLoadKPa: 7.5 });
    const lightResult = steel(light.doc);
    expect(lightResult.loads.floors.every((floor) => floor.imposedKnM2 === 2.5)).toBe(true);
    const gain = beamReactions(steel(heavy.doc)) - beamReactions(lightResult);
    expect(gain).toBeGreaterThan(74.3);
    expect(gain).toBeLessThan(75.3);
  });

  it('update_grating sets the imposed load of the given panels only, alone or with a type', () => {
    const { doc, ids } = gratedFrame();
    const result = ok(doc, 'update_grating', { ids: [ids[0] as string], imposedLoadKPa: 1.5 });
    expect(result.data).toMatchObject({ elementIds: [ids[0]], imposedLoadKPa: 1.5 });
    const floors = steel(result.document).loads.floors;
    expect(floors.map((floor) => floor.imposedKnM2)).toEqual([1.5, 5, 5]);
    expectNoOp(
      execute(result.document, 'update_grating', { ids: [ids[0] as string], imposedLoadKPa: 1.5 }),
      result.document,
      'nothing changed',
    );
  });

  it('refuses update_grating without a field and a negative load; is pure', () => {
    const { doc, ids } = gratedFrame();
    expectRefusal(doc, 'update_grating', { ids }, 'STA_INVALID_GEOMETRY', 'imposedLoadKPa');
    const negative = execute(doc, 'update_grating', { ids, imposedLoadKPa: -1 });
    expect(negative.rejected).toBe(true);
    expect(negative.document).toBe(doc);
    expectPure(doc, () => execute(doc, 'update_grating', { ids, imposedLoadKPa: 2 }));
  });
});

describe('platforms carry imposedLoadKPa to their panels', () => {
  const deck = (extra: Record<string, unknown> = {}): CadDocument => {
    const grade = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
      name: 'Grade',
      elevation: 0,
      height: 4000,
    });
    return apply(grade, 'add_access_platform', {
      bounds: [
        [0, 0],
        [4000, 2000],
      ],
      topOffset: 3000,
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      levelId: 'level-1',
      ...extra,
    });
  };

  it('add_access_platform stores it and every generated panel gets it', () => {
    const doc = deck({ imposedLoadKPa: 4 });
    const assembly = doc.building?.elements['assembly-1'];
    expect(assembly?.category === 'assembly' && assembly.params['imposedLoadKPa']).toBe(4);
    const panels = Object.values(doc.building?.elements ?? {}).filter((element) => element.category === 'grating');
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every((panel) => panel.category === 'grating' && panel.imposedLoadKPa === 4)).toBe(true);
    const { floors } = steel(doc).loads;
    expect(floors).toHaveLength(panels.length);
    expect(floors.every((floor) => floor.kind === 'grating' && floor.imposedKnM2 === 4)).toBe(true);
    expect(floors.reduce((sum, floor) => sum + floor.areaM2, 0)).toBeCloseTo(8, 6);
  });

  it('update_access_platform changes it in place without making the platform stale; the same value is a no-op', () => {
    const doc = deck({ imposedLoadKPa: 4 });
    const result = ok(doc, 'update_access_platform', { assemblyId: 'assembly-1', imposedLoadKPa: 6 });
    expect(steel(result.document).loads.floors.every((floor) => floor.imposedKnM2 === 6)).toBe(true);
    const findings = data<{ findings: Array<{ code: string }> }>(result.document, 'check_access', {
      rulesets: ['iso_14122'],
      include: ['platforms'],
    }).findings;
    expect(findings.map((finding) => finding.code)).not.toContain('STA_PLATFORM_STALE');
    expectNoOp(
      execute(result.document, 'update_access_platform', { assemblyId: 'assembly-1', imposedLoadKPa: 6 }),
      result.document,
      'already matches',
    );
  });

  it('a platform without the field keeps the check default', () => {
    expect(steel(deck()).loads.floors.every((floor) => floor.imposedKnM2 === 5)).toBe(true);
  });
});
