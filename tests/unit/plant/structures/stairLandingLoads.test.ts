/**
 * Plant 06 STA-FU2b: steel-stair landings are load surfaces of check_steel_members once a live-load source is cited (`stairLandingLoad`).
 * Hand numbers: width 800, landing after riser 9 of length 1000 = 0.8 m^2, tread grating 19-W-4 1-1/4x3/16 (catalogue kg/m^2 x 9.80665 / 1000 kN/m^2);
 * imposed 3 kPa -> 2.4 kN. Landing top = 9 x 3000 / 17 = 1588.235, grating bars 31.75 deep, so IPE200 beams with the axis at 1450 (top of steel 1550)
 * lie in the -60 / +20 band under the plate.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { findGratingType } from '@aec/plant/structures/grating/gratingTypes';
import { apply, data } from '../../../helpers/commandAssertions';
import { TYPE } from './accessFixtures';

interface Floor {
  slabId: string;
  kind: string;
  imposedKnM2: number;
  areaM2: number;
  deadKn: number;
  imposedKn: number;
  supportingBeams: number;
}
interface Steel {
  loads: { floors: Floor[]; stairFlights: Array<{ carriedDeadKn: number; carriedImposedKn: number }> };
  warnings: string[];
  members: Array<{ role: string; forces?: { reactionStart?: number; reactionEnd?: number } }>;
}
const STAIR = { start: [0, 0, 0], angle: 0, rise: 3000, riserMax: 180, going: 280 };
const GRAVITY = 9.80665;
const MASS = findGratingType(TYPE)?.massKgM2 ?? 0;

const frame = (turn?: string, beams = true): CadDocument => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  const level = Object.keys(doc.building?.levels ?? {})[0] as string;
  const bars = beams
    ? [
        { x: 2300, z: 1450 },
        { x: 3180, z: 1450 },
      ]
    : [{ x: 8000, z: 100 }];
  for (const { x, z } of bars)
    doc = apply(doc, 'add_steel_member', { profile: 'IPE200', role: 'beam', start: [x, -600, z], end: [x, 600, z], levelId: level });
  const landings = [{ afterRiser: 9, length: 1000, ...(turn === undefined ? {} : { turn }) }];
  return apply(doc, 'add_steel_stair', { ...STAIR, landings, tread: { kind: 'grating', gratingType: TYPE }, levelId: level });
};
const steel = (doc: CadDocument, params: Record<string, unknown> = {}): Steel => data<Steel>(doc, 'check_steel_members', params);
const landing = { imposedKPa: 3, source: 'project load schedule LS-12 rev B, stair landings' };
const reactions = (result: Steel): number =>
  result.members
    .filter((member) => member.role === 'beam')
    .reduce((sum, member) => sum + (member.forces?.reactionStart ?? 0) + (member.forces?.reactionEnd ?? 0), 0);

describe('check_steel_members: stair landings', () => {
  it('lists the landing as a surface with the tread self weight and the cited imposed load on the beams under it', () => {
    const { floors } = steel(frame(), { stairLandingLoad: landing }).loads;
    expect(floors).toHaveLength(1);
    expect(floors[0]).toMatchObject({ slabId: 'steelStair-1:landing-1', kind: 'landing', imposedKnM2: 3, supportingBeams: 2 });
    expect(floors[0]?.areaM2).toBeCloseTo(0.8, 9);
    expect(floors[0]?.imposedKn).toBeCloseTo(2.4, 9);
    expect(floors[0]?.deadKn).toBeCloseTo((0.8 * MASS * GRAVITY) / 1000, 9);
  });

  it('a turning landing is loaded the same: a half turn spans both flights, 1000 x (2 x 800 + 4 x 8.5) mm', () => {
    const { floors } = steel(frame('half_left'), { stairLandingLoad: landing }).loads;
    expect(floors[0]?.kind).toBe('landing');
    expect(floors[0]?.areaM2).toBeCloseTo(1.634, 9);
  });

  it('without stairLandingLoad the landings are not loaded and a warning names the parameter', () => {
    const result = steel(frame());
    expect(result.loads.floors).toEqual([]);
    expect(result.warnings.join(';')).toContain('stairLandingLoad');
  });

  it('a landing with no beam at its level is reported as carried by nothing', () => {
    const none = steel(frame(undefined, false), { stairLandingLoad: landing });
    expect(none.loads.floors[0]).toMatchObject({ deadKn: 0, imposedKn: 0, supportingBeams: 0 });
  });

  it('refuses by name a blank live-load source and a negative load, leaving the document unchanged', () => {
    const doc = frame();
    for (const bad of [
      { imposedKPa: 3, source: '  ' },
      { imposedKPa: -1, source: 'schedule' },
    ]) {
      const result = execute(doc, 'check_steel_members', { stairLandingLoad: bad });
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('stairLandingLoad');
    }
    expect(execute(doc, 'check_steel_members', { stairLandingLoad: { imposedKPa: 3 } }).rejected).toBe(true);
  });

  it('loading the landing (and the flights it carries) raises the ULS reactions by 1.35 x dead + 1.5 x imposed', () => {
    const doc = frame();
    const loaded = steel(doc, { stairLandingLoad: landing });
    const flights = loaded.loads.stairFlights.reduce((sum, f) => sum + 1.35 * f.carriedDeadKn + 1.5 * f.carriedImposedKn, 0);
    const gain = reactions(loaded) - reactions(steel(doc));
    expect(gain).toBeCloseTo(1.35 * ((0.8 * MASS * GRAVITY) / 1000) + 1.5 * 2.4 + flights, 2);
  });
});

describe('check_steel_members: stair landings, plan filter, plate treads, units', () => {
  const build = (units: 'mm' | 'm', tread: Record<string, unknown>, beamX: number[]): CadDocument => {
    const k = units === 'mm' ? 1 : 0.001;
    let doc = apply(createEmptyDocument(), 'set_units', { units });
    doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 * k });
    const level = Object.keys(doc.building?.levels ?? {})[0] as string;
    for (const x of beamX)
      doc = apply(doc, 'add_steel_member', {
        profile: 'IPE200',
        role: 'beam',
        start: [x * k, -600 * k, 1450 * k],
        end: [x * k, 600 * k, 1450 * k],
        levelId: level,
      });
    return apply(doc, 'add_steel_stair', {
      start: [0, 0, 0],
      angle: 0,
      rise: 3000 * k,
      riserMax: 180 * k,
      going: 280 * k,
      landings: [{ afterRiser: 9, length: 1000 * k }],
      tread,
      levelId: level,
    });
  };
  const plate = { kind: 'checker_plate', thickness: 6 };

  it('a checker-plate landing weighs 0.8 m2 x 6 mm x 7850 kg/m3, the same in a document in metres', () => {
    const dead = (0.8 * (6 / 1000) * 7850 * GRAVITY) / 1000;
    for (const units of ['mm', 'm'] as const) {
      const thickness = units === 'mm' ? 6 : 0.006;
      const floor = steel(build(units, { kind: 'checker_plate', thickness }, [2300, 3180]), { stairLandingLoad: landing }).loads.floors[0];
      expect(floor?.deadKn, units).toBeCloseTo(dead, 6);
      expect(floor?.imposedKn, units).toBeCloseTo(2.4, 6);
      expect(floor?.supportingBeams, units).toBe(2);
    }
  });

  it('a beam at the right height but 10 m away in plan carries nothing: the landing is reported as not carried', () => {
    const far = steel(build('mm', plate, [10000, 10600]), { stairLandingLoad: landing });
    expect(far.loads.floors[0]).toMatchObject({ deadKn: 0, imposedKn: 0, supportingBeams: 0 });
    expect(far.warnings.join(';')).toContain('stair landing');
  });

  it('equipment standing at the landing level does not reduce the cited imposed load', () => {
    const base = build('mm', plate, [2300, 3180]);
    const doc = apply(base, 'add_equipment', {
      name: 'Skid',
      location: [2740, 0],
      size: [500, 400, 300],
      weight: 100,
      levelId: Object.keys(base.building?.levels ?? {})[0],
    });
    expect(steel(doc, { stairLandingLoad: landing }).loads.floors[0]?.imposedKn).toBeCloseTo(2.4, 6);
  });
});
