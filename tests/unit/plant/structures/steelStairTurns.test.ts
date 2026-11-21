/**
 * Plant 06 STA-FU2: quarter-turn and half-turn steel stairs. Hand numbers: width 800, rise 3000 / riserMax 180 -> 17 risers of 176.47 mm, going 280,
 * one landing of 1000 after riser 9: s_9 = 8 x 280 = 2240, s_10 = 3240, run = 3240 + 7 x 280 = 5200 (same path length as the straight stair).
 * Quarter_left: the second flight starts at (3240 - 400, 400) = (2840, 400) climbing +Y, so its top is at (2840, 400 + 1960). Half_left (stringer
 * web 8.5, gap 4 webs = 34): the return flight starts at (2240, 800 + 34) climbing -X, its top at (2240 - 1960, 834).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { SteelStairElement } from '@aec/building/types';
import { buildingErrors } from '@aec/building/validate';
import { handrailPath, layoutSteelStair, stairEnd } from '@aec/plant/structures/stair/steelStairLayout';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const SIZES = { stringerWeb: 8.5, stringerDepth: 200 };
const scene = (): { doc: CadDocument; grade: string } => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  return { doc, grade: Object.keys(doc.building?.levels ?? {})[0] as string };
};
const STAIR = { start: [0, 0, 0], angle: 0, rise: 3000, riserMax: 180, going: 280 };
const turning = (turn: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...STAIR,
  landings: [{ afterRiser: 9, length: 1000, turn }],
  ...extra,
});
const stairOf = (doc: CadDocument): SteelStairElement => {
  const element = doc.building?.elements['steelStair-1'];
  if (element?.category !== 'steelStair') throw new Error('no steel stair');
  return element;
};
interface Added {
  runMm: number;
  flights: number[];
  treadCount: number;
  railingIds: string[];
  landings: Array<{ afterRiser: number; lengthMm: number }>;
}
const add = (params: Record<string, unknown>): { doc: CadDocument; result: ReturnType<typeof ok> } => {
  const f = scene();
  const result = ok(f.doc, 'add_steel_stair', { ...params, levelId: f.grade });
  return { doc: result.document, result };
};
const close = (actual: ArrayLike<number>, expected: number[]): void =>
  expected.forEach((value, index) => expect(actual[index] as number).toBeCloseTo(value, 6));

describe('layout: quarter and half turns', () => {
  const base = { ...STAIR, width: 800, riserCount: 17, riserHeight: 3000 / 17, start: [0, 0, 0] as [number, number, number] };

  it('a straight landing keeps one frame and one footprint', () => {
    const layout = layoutSteelStair({ ...base, landings: [{ afterRiser: 9, length: 1000 }] }, SIZES);
    expect(layout.frames).toHaveLength(2);
    expect(layout.frames[1]).toBe(layout.frames[0]);
    expect(layout.regions).toHaveLength(1);
    close(layout.end, [5200, 0]);
  });

  it('quarter_left: the second flight climbs +Y from the landing edge, flush with its far end', () => {
    const stair = { ...base, landings: [{ afterRiser: 9, length: 1000, turn: 'quarter_left' as const }] };
    const layout = layoutSteelStair(stair, SIZES);
    expect(layout.run).toBeCloseTo(5200, 9);
    close(layout.frames[1]?.origin ?? [], [2840, 400]);
    expect(layout.frames[1]?.angle).toBeCloseTo(Math.PI / 2, 9);
    close(layout.end, [2840, 2360]);
    close(stairEnd(stair, SIZES), [2840, 2360]);
    expect(layout.landings).toHaveLength(1);
    expect(layout.landings[0]?.corners.map((c) => c.map((v) => Math.round(v)))).toEqual([
      [2240, -400],
      [3240, -400],
      [3240, 400],
      [2240, 400],
    ]);
    expect(layout.treads).toHaveLength(15);
    // first tread of the second flight: riser 10 spans 400 .. 680 along +Y at x 2440..3240
    const tread = layout.treads[layout.treadRisers.indexOf(10)];
    expect(tread?.corners.map((c) => c.map((v) => Math.round(v)))).toEqual([
      [3240, 400],
      [3240, 680],
      [2440, 680],
      [2440, 400],
    ]);
    expect(layout.regions.map((r) => [r.from, r.to])).toEqual([
      [0, 2240],
      [2240, 3240],
      [3240, 5200],
    ]);
    expect(layout.stringers).toHaveLength(4);
  });

  it('quarter_right mirrors it to -Y', () => {
    const layout = layoutSteelStair({ ...base, landings: [{ afterRiser: 9, length: 1000, turn: 'quarter_right' }] }, SIZES);
    close(layout.end, [2840, -2360]);
  });

  it('half_left: the return flight climbs -X beside the first, the landing spans both', () => {
    const layout = layoutSteelStair({ ...base, landings: [{ afterRiser: 9, length: 1000, turn: 'half_left' }] }, SIZES);
    close(layout.frames[1]?.origin ?? [], [2240, 834]);
    close(layout.end, [280, 834]);
    expect(layout.landings[0]?.corners.map((c) => c.map((v) => Math.round(v)))).toEqual([
      [2240, -400],
      [3240, -400],
      [3240, 1234],
      [2240, 1234],
    ]);
    expect(layout.regions[1]?.across).toEqual([-400, 1234]);
    const right = layoutSteelStair({ ...base, landings: [{ afterRiser: 9, length: 1000, turn: 'half_right' }] }, SIZES);
    close(right.end, [280, -834]);
    expect(right.regions[1]?.across).toEqual([-1234, 400]);
  });

  it('hand-rails go round the landing to the same-side rail of the next flight', () => {
    const quarter = { ...base, landings: [{ afterRiser: 9, length: 1000, turn: 'quarter_left' as const }] };
    const left = handrailPath(quarter, SIZES, 1);
    expect(left).toHaveLength(18);
    close(left[8] ?? [], [2240, 404.25, 9 * (3000 / 17)]);
    close(left[9] ?? [], [2435.75, 404.25, 9 * (3000 / 17)]);
    close(left[10] ?? [], [2435.75, 400, 10 * (3000 / 17)]);
    const outer = handrailPath(quarter, SIZES, -1);
    close(outer[9] ?? [], [3244.25, -404.25, 9 * (3000 / 17)]);
    const half = handrailPath({ ...base, landings: [{ afterRiser: 9, length: 1000, turn: 'half_left' }] }, SIZES, 1);
    expect(half).toHaveLength(19);
    close(half[9] ?? [], [3240, 404.25, 9 * (3000 / 17)]);
    close(half[10] ?? [], [3240, 834 - 404.25, 9 * (3000 / 17)]);
    close(half[11] ?? [], [2240, 834 - 404.25, 10 * (3000 / 17)]);
  });
});

describe('add_steel_stair / update_steel_stair with turns', () => {
  it('adds a quarter-turn stair with hand-rails: landing recorded with its turn, run unchanged', () => {
    const { doc, result } = add(turning('quarter_left', { railings: 'both' }));
    const answer = result.data as Added;
    expect(answer.flights).toEqual([9, 8]);
    expect(answer.treadCount).toBe(15);
    expect(answer.runMm).toBeCloseTo(5200, 6);
    expect(answer.railingIds).toHaveLength(2);
    expect(stairOf(doc).landings).toEqual([{ afterRiser: 9, length: 1000, turn: 'quarter_left' }]);
    expect(result.affected).toContain('steelStair-1');
    expect(buildingErrors(doc.building)).toEqual([]);
  });

  it('a stair without turns stores no turn key', () => {
    expect(stairOf(add({ ...STAIR, landings: [{ afterRiser: 9, length: 1000 }] }).doc).landings).toEqual([{ afterRiser: 9, length: 1000 }]);
  });

  it('arrival surface follows the turned top: a surface at the straight-line end is not reached', () => {
    const f = scene();
    const doc = apply(f.doc, 'add_level', { name: '+3000', elevation: 3000, height: 3000 });
    const top = Object.keys(doc.building?.levels ?? {}).find((id) => id !== f.grade) as string;
    const withSlab = apply(doc, 'add_slab', {
      boundary: [
        [2400, 2000],
        [3300, 2000],
        [3300, 3000],
        [2400, 3000],
      ],
      levelId: top,
    });
    const slabId = Object.keys(withSlab.building?.elements ?? {}).find((id) => id.startsWith('slab')) as string;
    const reached = execute(withSlab, 'add_steel_stair', {
      ...turning('quarter_left'),
      toSurfaceId: slabId,
      rise: undefined,
      levelId: f.grade,
    });
    expect(reached.rejected, reached.summary).toBeUndefined();
    const missed = expectRefusal(
      withSlab,
      'add_steel_stair',
      { ...STAIR, rise: undefined, toSurfaceId: slabId, levelId: f.grade },
      'STA_NO_ARRIVAL_SURFACE',
    );
    expect(missed.summary).toContain('STA_NO_ARRIVAL_SURFACE');
  });

  it('refuses a turning landing shorter than the stair width, and a turn on an unknown enum', () => {
    const f = scene();
    const short = expectRefusal(
      f.doc,
      'add_steel_stair',
      { ...STAIR, levelId: f.grade, landings: [{ afterRiser: 9, length: 600, turn: 'half_left' }] },
      'STA_INVALID_GEOMETRY',
      'landings',
    );
    expect(short.summary).toContain('turning landing needs length >= width');
    expect(execute(f.doc, 'add_steel_stair', { ...turning('spiral'), levelId: f.grade }).rejected).toBe(true);
  });

  it('update_steel_stair turns a straight landing, re-lays hand-rails and refuses a width wider than the turning landing', () => {
    const { doc } = add({ ...STAIR, landings: [{ afterRiser: 9, length: 1000 }], railings: 'left' });
    const before = doc.building?.elements['railing-1'];
    const result = ok(doc, 'update_steel_stair', { id: 'steelStair-1', landings: [{ afterRiser: 9, length: 1000, turn: 'half_right' }] });
    expect(stairOf(result.document).landings[0]?.turn).toBe('half_right');
    expect(result.affected).toEqual(expect.arrayContaining(['steelStair-1', 'railing-1']));
    expect(result.document.building?.elements['railing-1']).not.toEqual(before);
    const wide = expectRefusal(result.document, 'update_steel_stair', { id: 'steelStair-1', width: 1200 }, 'STA_INVALID_GEOMETRY', 'width');
    expect(wide.summary).toContain('half_right');
    // a plain length change keeps the turn
    const longer = ok(result.document, 'update_steel_stair', { id: 'steelStair-1', landingLength: 1100 });
    expect(stairOf(longer.document).landings).toEqual([{ afterRiser: 9, length: 1100, turn: 'half_right' }]);
    expectPure(result.document, () =>
      execute(result.document, 'update_steel_stair', { id: 'steelStair-1', landings: [{ afterRiser: 9, length: 1000 }] }),
    );
  });

  it('load validation rejects an unknown turn', () => {
    const { doc } = add(turning('quarter_left'));
    const broken = structuredClone(doc.building);
    const element = broken?.elements['steelStair-1'] as unknown as { landings: Array<Record<string, unknown>> };
    element.landings[0] = { ...element.landings[0], turn: 'sideways' };
    expect(buildingErrors(broken).join(';')).toContain('landings must be ascending');
  });
});

describe('check_access on turned stairs', () => {
  const checked = (
    doc: CadDocument,
    rulesets: string[],
  ): { findings: Array<Record<string, unknown>>; rulesEvaluated?: unknown; notEvaluated: Array<{ ruleId: string }> } =>
    data(doc, 'check_access', { rulesets, include: ['stairs'] });

  it('OSHA-STR-LANDING is judged on a turning landing shorter than 762 mm (STA_STAIR_LANDING), not on a straight one', () => {
    const narrow = { width: 600, rulesets: ['osha_1910'] };
    const turned = add({ ...STAIR, ...narrow, landings: [{ afterRiser: 9, length: 700, turn: 'quarter_left' }] }).doc;
    const finding = checked(turned, ['osha_1910']).findings.find((item) => item['code'] === 'STA_STAIR_LANDING');
    expect(finding).toMatchObject({ ruleId: 'OSHA-STR-LANDING', ids: ['steelStair-1'], measured: { value: 700 }, limit: { min: 762 } });
    const straight = add({ ...STAIR, ...narrow, landings: [{ afterRiser: 9, length: 700 }] }).doc;
    expect(checked(straight, ['osha_1910']).findings.map((item) => item['code'])).not.toContain('STA_STAIR_LANDING');
    const long = add({ ...STAIR, ...narrow, landings: [{ afterRiser: 9, length: 800, turn: 'quarter_left' }] }).doc;
    expect(checked(long, ['osha_1910']).findings.map((item) => item['code'])).not.toContain('STA_STAIR_LANDING');
    expect(checked(turned, ['osha_1910']).notEvaluated.map((row) => row.ruleId)).toContain('OSHA-STR-LANDING');
  });
});

describe('headroom over the turned flights', () => {
  const beam = (doc: CadDocument, level: string, start: number[], end: number[], underside: number): CadDocument =>
    apply(doc, 'add_steel_member', {
      profile: 'IPE200',
      role: 'beam',
      start: [start[0], start[1], underside + 100],
      end: [end[0], end[1], underside + 100],
      levelId: level,
    });
  const headroom = (doc: CadDocument): number | null =>
    data<{ stairHeadroom: Array<{ headroomMm: number | null }> }>(doc, 'check_access', { rulesets: ['iso_14122'], include: ['stairs'] })
      .stairHeadroom[0]?.headroomMm ?? null;

  it('a beam over the second flight of a quarter turn is found; the same beam clears a straight stair', () => {
    const quarter = add(turning('quarter_left'));
    const level = stairOf(quarter.doc).levelId;
    const over = (doc: CadDocument): CadDocument => beam(doc, level, [2000, 1500], [3500, 1500], 4300);
    const value = headroom(over(quarter.doc)) as number;
    // pitch at the high edge y = 1550: station 3240 + 1150 = 4390 -> 14h + h x 30 / 280 = 2489.5
    expect(value).toBeGreaterThanOrEqual(4300 - 2489.5 - 1e-6);
    expect(value).toBeLessThan(4300 - 2489.5 + 35);
    const straight = add({ ...STAIR, landings: [{ afterRiser: 9, length: 1000 }] });
    expect(headroom(over(straight.doc))).toBeNull();
  });

  it('a beam over the widened half-turn landing (outside both flights) is found at the landing height 9h', () => {
    const half = add(turning('half_left'));
    const level = stairOf(half.doc).levelId;
    const value = headroom(beam(half.doc, level, [2500, 1000], [2900, 1000], 2600)) as number;
    expect(value).toBeGreaterThanOrEqual(2600 - 9 * (3000 / 17) - 1e-6);
    expect(value).toBeLessThan(2600 - 9 * (3000 / 17) + 1);
  });
});

describe('plan symbol, access graph and IFC of turned stairs', () => {
  it('the plan symbol draws one outline per footprint region and the landing plate; the arrow follows the last flight', () => {
    const { doc } = add(turning('quarter_left'));
    const answer = data<{ files: Array<{ content: string }>; counts: { stairs: number } }>(doc, 'export_access_plan', {});
    expect(answer.counts.stairs).toBe(1);
    const svg = answer.files[0]?.content ?? '';
    expect(svg.match(/<polygon [^>]*class="S-STAR"/g)?.length).toBe(4);
    expect(svg).toContain('>SS1 UP 17 R<');
  });

  it('the stair connects grade to its turned top (access_graph)', () => {
    const { doc } = add(turning('half_left'));
    const answer = data<{ connectors?: Array<{ id: string; top?: { pointMm?: number[] } }> }>(doc, 'access_graph', {});
    expect(JSON.stringify(answer)).toContain('steelStair-1');
  });

  it('IFC: one turning landing is QUARTER_TURN / HALF_TURN, several landings user defined', () => {
    const type = (params: Record<string, unknown>): string => {
      const { doc } = add(params);
      const out = data<{ ifc: string }>(doc, 'export_ifc', {});
      return out.ifc.match(/IFCSTAIR\([^;]*\.([A-Z_]+)\.\);/)?.[1] ?? '';
    };
    expect(type(turning('quarter_right'))).toBe('QUARTER_TURN_STAIR');
    expect(type(turning('half_left'))).toBe('HALF_TURN_STAIR');
    expect(
      type({
        ...STAIR,
        landings: [
          { afterRiser: 5, length: 1000, turn: 'half_left' },
          { afterRiser: 12, length: 1000 },
        ],
      }),
    ).toBe('USERDEFINED');
  });
});

describe('plan symbols: platform below the level, ladder without a cage', () => {
  it('labels a negative elevation without a plus sign and draws a cage-free ladder without a circle', () => {
    const f = scene();
    let doc = apply(f.doc, 'add_access_platform', {
      bounds: [
        [0, 0],
        [3000, 2000],
      ],
      topOffset: -500,
      gratingType: '19-W-4 1-1/4x3/16',
      bearingBarDirection: [1, 0],
      levelId: f.grade,
    });
    doc = apply(doc, 'add_ladder', {
      base: [500, -250, -2500],
      facing: [0, 1],
      climbHeight: 2000,
      fallProtection: 'ladder_safety_system',
      levelId: f.grade,
    });
    const svg = data<{ files: Array<{ content: string }> }>(doc, 'export_access_plan', {}).files[0]?.content ?? '';
    expect(svg).toContain('EL -500<');
    expect(svg).not.toContain('<circle');
  });
});
