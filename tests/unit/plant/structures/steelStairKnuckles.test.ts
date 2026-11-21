/**
 * Plant 06 STA-FU2b: turns on `landingEvery` landings (`landingTurn`) and the stringer knuckles at turning landings. Hand numbers: width 800, rise 3000 /
 * riserMax 180 -> 17 risers of h = 176.4706, going 280, landing after riser 9 of 1000 (stations 2240 .. 3240), UPN200 web 8.5 -> stringer centre-lines at
 * +-404.25, flight stringers end at 9h - drop = 1588.235 - 118.204 = 1470.03 (drop = 100 / cos(atan(h / g)) = 100 x 1.18204).
 * Every turn closes the chain in z: horizontal runs at that height, then one vertical leg of h = 176.4706 up to the start of the next flight stringer
 * ((k + 1) h - drop). Quarter_left: left (2240,404.25) -> corner (2435.75,404.25) = 195.75 + leg (inner chain ends at the corner, 4.25 short of the next
 * stringer); right (2240,-404.25) -> (3244.25,-404.25) -> (3244.25,400) = 1004.25 + 804.25 + leg; total 2004.25 + 2h = 2357.19 mm.
 * Half_left (far-edge points at beyond + web / 2 = 3244.25): left (2240,404.25) -> (2240,429.75) = 25.5 (3 webs across the well) + leg; right
 * (2240,-404.25) -> (3244.25,-404.25) -> (3244.25,1238.25) -> (2240,1238.25) = 1004.25 + 1642.5 + 1004.25 + leg; total 3676.5 + 2h = 4029.44 mm.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { SteelStairElement, SteelStairTurn } from '@aec/building/types';
import { findProfile } from '@aec/steel/profiles';
import { stairFlightBoxes } from '@aec/plant/structures/clash/structuresClashBodies';
import { layoutSteelStair } from '@aec/plant/structures/stair/steelStairLayout';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const SIZES = { stringerWeb: 8.5, stringerDepth: 200 };
const STAIR = { start: [0, 0, 0], angle: 0, rise: 3000, riserMax: 180, going: 280 };
const H = 3000 / 17;
const DROP = 100 / Math.cos(Math.atan2(H, 280));
const scene = (): { doc: CadDocument; grade: string } => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  return { doc, grade: Object.keys(doc.building?.levels ?? {})[0] as string };
};
const add = (params: Record<string, unknown>): CadDocument => {
  const f = scene();
  return ok(f.doc, 'add_steel_stair', { ...STAIR, ...params, levelId: f.grade }).document;
};
const stairOf = (doc: CadDocument): SteelStairElement => {
  const element = doc.building?.elements['steelStair-1'];
  if (element?.category !== 'steelStair') throw new Error('no steel stair');
  return element;
};
const length = (run: { from: readonly number[]; to: readonly number[] }): number =>
  Math.hypot(...run.to.map((v, i) => v - (run.from[i] as number)));
const knuckleLength = (turn: SteelStairTurn): number => {
  const layout = layoutSteelStair(
    {
      start: [0, 0, 0],
      angle: 0,
      width: 800,
      riserCount: 17,
      riserHeight: H,
      going: 280,
      landings: [{ afterRiser: 9, length: 1000, turn }],
    },
    SIZES,
  );
  return layout.knuckles.reduce((sum, run) => sum + length(run), 0);
};

describe('stringer knuckles at turning landings', () => {
  const layoutOf = (turn: SteelStairTurn | undefined): ReturnType<typeof layoutSteelStair> =>
    layoutSteelStair(
      {
        start: [0, 0, 0],
        angle: 0,
        width: 800,
        riserCount: 17,
        riserHeight: H,
        going: 280,
        landings: [{ afterRiser: 9, length: 1000, ...(turn === undefined ? {} : { turn }) }],
      },
      SIZES,
    );

  it('a straight stair has no knuckle runs', () => {
    expect(layoutOf(undefined).knuckles).toEqual([]);
  });

  it('quarter_left: horizontal runs at the flight end height, then one riser-high vertical leg per side: 2357.19 mm in five runs', () => {
    const layout = layoutOf('quarter_left');
    expect(layout.knuckles).toHaveLength(5);
    expect(layout.knuckleFlights).toEqual([0, 0, 0, 0, 0]);
    expect(layout.knuckles.map((run) => length(run))).toEqual([
      expect.closeTo(195.75, 6),
      expect.closeTo(H, 6),
      expect.closeTo(1004.25, 6),
      expect.closeTo(804.25, 6),
      expect.closeTo(H, 6),
    ]);
    const z0 = 9 * H - DROP;
    expect(layout.knuckles[0]?.from[2]).toBeCloseTo(z0, 9);
    expect(layout.knuckles[1]?.to[2]).toBeCloseTo(z0 + H, 9);
    expect(knuckleLength('quarter_left')).toBeCloseTo(2008.5 - 4.25 + 2 * H, 6);
    expect(layout.knuckles[2]?.to[0]).toBeCloseTo(3244.25, 6);
    // the outer leg stands exactly on the start of the next flight stringer; the inner one ends at the corner, one half web (4.25) short of it
    expect(layout.knuckles[4]?.to).toEqual(layout.stringers[3]?.from);
    expect(Math.hypot(...[0, 1, 2].map((k) => (layout.knuckles[1]?.to[k] ?? 0) - (layout.stringers[2]?.from[k] ?? 0)))).toBeCloseTo(
      4.25,
      6,
    );
  });

  it('half_left: 25.5 mm across the well on the inner side, the outer one round the far edge (web / 2 past it): 4029.44 mm with the legs', () => {
    const layout = layoutOf('half_left');
    expect(layout.knuckles.map((run) => length(run))).toEqual([
      expect.closeTo(25.5, 6),
      expect.closeTo(H, 6),
      expect.closeTo(1004.25, 6),
      expect.closeTo(1642.5, 6),
      expect.closeTo(1004.25, 6),
      expect.closeTo(H, 6),
    ]);
    expect(knuckleLength('half_left')).toBeCloseTo(25.5 + 1004.25 + 1642.5 + 1004.25 + 2 * H, 6);
  });

  it('every turn: each side is one gap-free chain from the end of its flight stringer up to the start of the next one, all three coordinates', () => {
    for (const turn of ['quarter_left', 'quarter_right', 'half_left', 'half_right'] as const) {
      const layout = layoutOf(turn);
      const [first, second] = [layout.stringers.slice(0, 2), layout.stringers.slice(2, 4)];
      const same = (a: readonly number[], b: readonly number[]): boolean => a.every((v, k) => Math.abs(v - (b[k] ?? NaN)) < 1e-9);
      const chains = layout.knuckles.filter((run) => first.some((stringer) => same(stringer.to, run.from)));
      expect(chains, turn).toHaveLength(2);
      for (let i = 1; i < layout.knuckles.length; i++) {
        const [previous, run] = [layout.knuckles[i - 1], layout.knuckles[i]];
        if (!first.some((stringer) => same(stringer.to, run?.from ?? [])))
          expect(same(run?.from ?? [], previous?.to ?? []), `${turn} ${i}`).toBe(true);
      }
      const ends = layout.knuckles.filter(
        (_run, i) => i === layout.knuckles.length - 1 || first.some((stringer) => same(stringer.to, layout.knuckles[i + 1]?.from ?? [])),
      );
      expect(ends, turn).toHaveLength(2);
      for (const end of ends) {
        const target = second.find((stringer) => stringer.from[2] === end.to[2] && same(stringer.from, end.to));
        const inner = turn.startsWith('quarter') && second.every((stringer) => !same(stringer.from, end.to));
        expect(target !== undefined || inner, `${turn} end`).toBe(true);
        expect(end.to[2], turn).toBeCloseTo(second[0]?.from[2] as number, 9);
      }
    }
  });

  it('the stair mass grows by the knuckle length x the profile mass per metre, and quantities, evaluation, clash and IFC see the runs', () => {
    const straight = add({ landings: [{ afterRiser: 9, length: 1000 }] });
    const turned = add({ landings: [{ afterRiser: 9, length: 1000, turn: 'quarter_left' }] });
    const steelKg = (doc: CadDocument): number =>
      data<{ lines: Array<{ key: string; quantity: number }> }>(doc, 'quantity_takeoff', {}).lines.find(
        (line) => line.key === 'steelStair.steel.kg',
      )?.quantity ?? 0;
    const perMetre = findProfile('UPN200')?.massPerMetre ?? 0;
    expect(steelKg(turned) - steelKg(straight)).toBeCloseTo(((2008.5 - 4.25 + 2 * H) / 1000) * perMetre, 1);
    const [level] = Object.values(turned.building?.levels ?? {});
    const boxes = (doc: CadDocument): number => stairFlightBoxes(doc, stairOf(doc), level!).length;
    expect(boxes(turned) - boxes(straight)).toBe(5);
    const ifc = (doc: CadDocument): string => data<{ ifc: string }>(doc, 'export_ifc', {}).ifc;
    const members = (doc: CadDocument): number => (ifc(doc).match(/\.STRINGER\./g) ?? []).length;
    expect(members(turned) - members(straight)).toBe(5);
    const meshOf = (doc: CadDocument): number => {
      const stringers = Object.values(doc.entities).find((entity) => entity.kind === 'mesh' && entity.name?.startsWith('Stair stringers'));
      return stringers?.kind === 'mesh' ? stringers.mesh.positions.length : 0;
    };
    expect(meshOf(turned)).toBeGreaterThan(meshOf(straight));
  });
});

describe('landingTurn on landingEvery landings', () => {
  it('one turn applies to every generated landing: rise 3000 / landingEvery 1100 = 3 flights of 6 risers, two quarter_left landings', () => {
    const doc = add({ landingEvery: 1100, landingTurn: 'quarter_left' });
    expect(stairOf(doc).landings).toEqual([
      { afterRiser: 6, length: 800, turn: 'quarter_left' },
      { afterRiser: 12, length: 800, turn: 'quarter_left' },
    ]);
  });

  it('an array gives one entry per landing; "straight" leaves that landing without a turn key', () => {
    const doc = add({ landingEvery: 1100, landingTurn: ['half_right', 'straight'] });
    expect(stairOf(doc).landings).toEqual([
      { afterRiser: 6, length: 800, turn: 'half_right' },
      { afterRiser: 12, length: 800 },
    ]);
    expect(ok(scene().doc, 'add_steel_stair', { ...STAIR, landingEvery: 1100, landingTurn: ['half_right', 'straight'] }).summary).toContain(
      '2 landing(s)',
    );
  });

  it('landing length defaults to max(width, 762) >= width, so the turn is always legal; landingLength below the width is refused', () => {
    expect(stairOf(add({ landingEvery: 1100, landingTurn: 'half_left', width: 900 })).landings[0]?.length).toBe(900);
    const f = scene();
    const short = expectRefusal(
      f.doc,
      'add_steel_stair',
      { ...STAIR, landingEvery: 1100, landingTurn: 'quarter_left', landingLength: 700, levelId: f.grade },
      'STA_INVALID_GEOMETRY',
      'landings',
    );
    expect(short.summary).toContain('turning landing needs length >= width');
  });

  it('refuses a turn list of the wrong length, a turn with one flight, a turn without landingEvery and a turn next to explicit landings', () => {
    const f = scene();
    const refuse = (extra: Record<string, unknown>, path: string): string =>
      expectRefusal(f.doc, 'add_steel_stair', { ...STAIR, levelId: f.grade, ...extra }, 'STA_INVALID_GEOMETRY', path).summary;
    expect(refuse({ landingEvery: 1100, landingTurn: ['half_left'] }, 'landingTurn')).toContain('lists 1 turn(s)');
    expect(refuse({ landingEvery: 5000, landingTurn: 'half_left' }, 'landingTurn')).toContain('no landing to turn');
    expect(refuse({ landingTurn: 'half_left' }, 'landingTurn')).toContain('give landingEvery');
    expect(refuse({ landings: [{ afterRiser: 9 }], landingEvery: 1100, landingTurn: 'half_left' }, 'landings')).toContain('not both');
    expect(execute(f.doc, 'add_steel_stair', { ...STAIR, landingEvery: 1100, landingTurn: 'spiral', levelId: f.grade }).rejected).toBe(
      true,
    );
  });

  it('update_steel_stair turns the regenerated landings, re-lays the rails and refuses the same wrong inputs', () => {
    const built = add({ landingEvery: 1100, railings: 'left' });
    const updated = ok(built, 'update_steel_stair', {
      id: 'steelStair-1',
      landingEvery: 1100,
      landingTurn: ['quarter_right', 'half_left'],
    });
    expect(stairOf(updated.document).landings).toEqual([
      { afterRiser: 6, length: 800, turn: 'quarter_right' },
      { afterRiser: 12, length: 800, turn: 'half_left' },
    ]);
    expect(updated.affected).toEqual(expect.arrayContaining(['steelStair-1', 'railing-1']));
    expectRefusal(built, 'update_steel_stair', { id: 'steelStair-1', landingTurn: 'half_left' }, 'STA_INVALID_GEOMETRY', 'landingTurn');
    expectRefusal(
      built,
      'update_steel_stair',
      { id: 'steelStair-1', landingEvery: 1100, landingTurn: ['half_left'] },
      'STA_INVALID_GEOMETRY',
      'landingTurn',
    );
    expectPure(built, () => execute(built, 'update_steel_stair', { id: 'steelStair-1', landingEvery: 1100, landingTurn: 'half_left' }));
  });
});

describe('update_steel_stair landingEvery keeps or names the turns', () => {
  it('the same landing count keeps each previous turn; another count drops them and says so in the summary and data.changed', () => {
    const built = add({ landingEvery: 1100, landingTurn: ['half_right', 'quarter_left'] });
    const kept = ok(built, 'update_steel_stair', { id: 'steelStair-1', landingEvery: 1100, going: 270 });
    expect(stairOf(kept.document).landings.map((landing) => landing.turn)).toEqual(['half_right', 'quarter_left']);
    const dropped = ok(built, 'update_steel_stair', { id: 'steelStair-1', landingEvery: 800 });
    expect(stairOf(dropped.document).landings.every((landing) => landing.turn === undefined)).toBe(true);
    expect(dropped.summary).toContain('dropped turns half_right, quarter_left');
    expect((dropped.data as { changed: string[] }).changed.join(';')).toContain('dropped turns');
    const straight = ok(add({ landingEvery: 1100 }), 'update_steel_stair', { id: 'steelStair-1', landingEvery: 800 });
    expect(straight.summary).not.toContain('dropped turns');
  });
});
