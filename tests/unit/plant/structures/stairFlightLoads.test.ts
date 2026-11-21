/**
 * Plant 06 STA-FU2c: the flights of a steel stair (treads + stringers + imposed) are carried to the beams under the stringer ends.
 * Hand calculation (same stair as stairLandingLoads): rise 3000 / 17 risers, h = 176.4706; width 800; going 280; landing after riser 9 (1000 long);
 * UPN200 stringers. Flight 1: 8 treads of 0.8 x 0.28 m, stringers from riser 1 to riser 9: 2240 horizontal, 8h vertical. Flight 2: 7 treads,
 * stringers 1960 horizontal, 7h vertical. Foot of flight 1 stands on grade (no beam, not warned); the top of flight 1 (x 2240) and the foot of
 * flight 2 (x 3240) bear on the landing beams at x 2300 and 3180; the top of flight 2 (z 3000) has no beam.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { findGratingType } from '@aec/plant/structures/grating/gratingTypes';
import { findProfile } from '@aec/steel/profiles';
import { apply, data } from '../../../helpers/commandAssertions';
import { TYPE } from './accessFixtures';

interface Flight {
  flightId: string;
  treadAreaM2: number;
  deadKn: number;
  imposedKn: number;
  carriedDeadKn: number;
  carriedImposedKn: number;
  endsOnBeams: number;
  unsupportedEnds: number;
}
interface Result {
  loads: { stairFlights: Flight[] };
  warnings: string[];
  members: Array<{ role: string; forces?: { reactionStart?: number; reactionEnd?: number } }>;
}
const G = 9.80665;
const H = 3000 / 17;
const MASS = findGratingType(TYPE)?.massKgM2 ?? 0;
const UPN = findProfile('UPN200')?.massPerMetre ?? 0;
const LOAD = { imposedKPa: 3, source: 'project load schedule LS-12 rev B, stair treads and landings' };

const frame = (beams = true): CadDocument => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  const level = Object.keys(doc.building?.levels ?? {})[0] as string;
  for (const x of beams ? [2300, 3180] : [8000]) {
    const z = beams ? 1450 : 100;
    doc = apply(doc, 'add_steel_member', { profile: 'IPE200', role: 'beam', start: [x, -600, z], end: [x, 600, z], levelId: level });
  }
  return apply(doc, 'add_steel_stair', {
    start: [0, 0, 0],
    angle: 0,
    rise: 3000,
    riserMax: 180,
    going: 280,
    landings: [{ afterRiser: 9, length: 1000 }],
    tread: { kind: 'grating', gratingType: TYPE },
    levelId: level,
  });
};
const check = (doc: CadDocument, params: Record<string, unknown> = {}): Result => data<Result>(doc, 'check_steel_members', params);
const total = (r: Result): number =>
  r.members.filter((m) => m.role === 'beam').reduce((sum, m) => sum + (m.forces?.reactionStart ?? 0) + (m.forces?.reactionEnd ?? 0), 0);

describe('check_steel_members: stair flights carried to the beams', () => {
  const dead = (area: number, run: number, rise: number): number => (area * MASS * G) / 1000 + (2 * Math.hypot(run, rise) * UPN * G) / 1e6;

  it('matches the hand calculation per flight', () => {
    const [one, two] = check(frame(), { stairLandingLoad: LOAD }).loads.stairFlights as [Flight, Flight];
    expect(one.flightId).toBe('steelStair-1:flight-1');
    expect(one.treadAreaM2).toBeCloseTo(8 * 0.8 * 0.28, 9);
    expect(one.deadKn).toBeCloseTo(dead(8 * 0.224, 2240, 8 * H), 6);
    expect(one.imposedKn).toBeCloseTo(3 * 8 * 0.224, 9);
    expect(two.treadAreaM2).toBeCloseTo(7 * 0.224, 9);
    expect(two.deadKn).toBeCloseTo(dead(7 * 0.224, 1960, 7 * H), 6);
  });

  it('carries half of each flight (top of flight 1, foot of flight 2 on the landing beams) and warns for the free top end', () => {
    const result = check(frame(), { stairLandingLoad: LOAD });
    const [one, two] = result.loads.stairFlights as [Flight, Flight];
    expect([one.endsOnBeams, one.unsupportedEnds, two.endsOnBeams, two.unsupportedEnds]).toEqual([2, 0, 2, 2]);
    expect(one.carriedDeadKn).toBeCloseTo(one.deadKn / 2, 9);
    expect(two.carriedImposedKn).toBeCloseTo(two.imposedKn / 2, 9);
    expect(result.warnings.join(';')).toContain('flight 2: 2 stringer end(s) bear on no beam');
    expect(result.warnings.join(';')).not.toContain('flight 1: ');
  });

  it('raises the ULS beam reactions by the carried flight loads plus the landing', () => {
    const doc = frame();
    const loaded = check(doc, { stairLandingLoad: LOAD });
    const [one, two] = loaded.loads.stairFlights as [Flight, Flight];
    const landing = 1.35 * ((0.8 * MASS * G) / 1000) + 1.5 * 3 * 0.8;
    const flights = (1.35 * (one.deadKn + two.deadKn)) / 2 + (1.5 * (one.imposedKn + two.imposedKn)) / 2;
    expect(total(loaded) - total(check(doc))).toBeCloseTo(landing + flights, 2);
  });

  it('without stairLandingLoad no flight is loaded (no live load is assumed); with no beams nothing is carried', () => {
    expect(check(frame()).loads.stairFlights).toEqual([]);
    const none = check(frame(false), { stairLandingLoad: LOAD }).loads.stairFlights;
    expect(none.every((f) => f.carriedDeadKn === 0 && f.carriedImposedKn === 0)).toBe(true);
  });

  it('is pure and refuses a blank live-load source', () => {
    const doc = frame();
    const before = JSON.stringify(doc);
    check(doc, { stairLandingLoad: LOAD });
    expect(JSON.stringify(doc)).toBe(before);
    const bad = execute(doc, 'check_steel_members', { stairLandingLoad: { imposedKPa: 3, source: ' ' } });
    expect(bad.document).toBe(doc);
    expect(bad.summary).toContain('stairLandingLoad');
  });
});
