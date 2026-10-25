/**
 * Plant 06 STA M3: railing layout (VC-STA-05 post counts), defaults from the rule rows, add_railing / update_railing, host edges, gaps and gates,
 * evaluation entities, takeoff, persistence and the move / delete behaviour of a hosted railing. Hand numbers: posts = ceil(L / s) + 1 at equal
 * spacing (4000 mm at 1500 -> 4 posts, 1333.33 mm; 6000 -> 5 posts, 1500 mm); clear space = (h - toe - (k + 1) d) / (k + 1) with d = 48.3 mm:
 * 1100 / 1 knee rail / 100 -> 451.7 mm.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { Vec3 } from '@core/model/types';
import { buildingErrors } from '@aec/building/validate';
import { railingDefaults } from '@aec/plant/structures/railing/railingDefaults';
import { guardedSegments, layoutRailing, postStations, railLevels } from '@aec/plant/structures/railing/railingLayout';
import { hostPaths } from '@aec/plant/structures/railing/railingPath';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { BOTH, deckDoc, gratedFrame, rect } from './accessFixtures';

const line = (length: number, z = 0): Vec3[] => [
  [0, 0, z],
  [length, 0, z],
];
const base = { openings: [], kneeRails: 1, toePlate: 100, height: 1100, postSpacingMax: 1500 };

describe('railing layout', () => {
  it('spaces posts equally at <= the maximum with a post at both ends (VC-STA-05)', () => {
    const four = layoutRailing({ ...base, path: line(4000) }, 48.3);
    expect(four.posts).toHaveLength(4);
    expect(four.posts.map((post) => post[0])).toEqual([0, 4000 / 3, 8000 / 3, 4000]);
    const six = layoutRailing({ ...base, path: line(6000) }, 48.3);
    expect(six.posts.map((post) => post[0])).toEqual([0, 1500, 3000, 4500, 6000]);
    expect(layoutRailing({ ...base, path: line(1000) }, 48.3).posts).toHaveLength(2);
  });

  it('puts a post at every corner and spaces each straight run by itself', () => {
    const corner = layoutRailing(
      {
        ...base,
        path: [
          [0, 0, 0],
          [3000, 0, 0],
          [3000, 2000, 0],
        ],
      },
      48.3,
    );
    expect(corner.posts.map((post) => [post[0], post[1]])).toEqual([
      [0, 0],
      [1500, 0],
      [3000, 0],
      [3000, 1000],
      [3000, 2000],
    ]);
    expect(corner.length).toBe(5000);
  });

  it('closes a loop without a double post at the start', () => {
    const loop = layoutRailing(
      { ...base, path: [...rect(0, 0, 3000, 3000).map(([x, y]): Vec3 => [x as number, y as number, 0]), [0, 0, 0]] },
      48.3,
    );
    expect(loop.posts).toHaveLength(8);
    expect(loop.rails.filter((rail) => rail.level === 0)).toHaveLength(8);
  });

  it('keeps a post at both ends of a gap, drops the rails and toe plate inside it and adds gate leaves for a gate', () => {
    const gap = { from: 1000, to: 2000 };
    const open = layoutRailing({ ...base, path: line(4000), openings: [{ ...gap, gate: false }] }, 48.3);
    expect(open.posts.map((post) => post[0])).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(open.rails.filter((rail) => rail.level === 0)).toHaveLength(3);
    expect(open.toePlates).toHaveLength(3);
    expect(open.gates).toEqual([]);
    const gated = layoutRailing({ ...base, path: line(4000), openings: [{ ...gap, gate: true }] }, 48.3);
    expect(gated.gates).toHaveLength(2);
    expect(gated.gates[0]).toMatchObject({ opening: 0 });
    expect(guardedSegments(line(4000), [{ ...gap, gate: false }]).map(([a, b]) => [a[0], b[0]])).toEqual([
      [0, 1000],
      [2000, 4000],
    ]);
    expect(guardedSegments(line(4000), [{ ...gap, gate: true }]).map(([a, b]) => [a[0], b[0]])).toEqual([[0, 4000]]);
  });

  it('follows a sloped path in 3D and finds the post stations of an interval', () => {
    const ramp = layoutRailing(
      {
        ...base,
        path: [
          [0, 0, 0],
          [3000, 0, 4000],
        ],
      },
      48.3,
    );
    expect(ramp.length).toBe(5000);
    expect(ramp.posts).toHaveLength(5);
    expect(ramp.posts[4]).toEqual([3000, 0, 4000]);
    expect(postStations([0, 2500], [], 1000)).toEqual([0, 2500 / 3, 5000 / 3, 2500]);
  });

  it('computes the rail heights and the clear space (top rail and toe plate counted)', () => {
    const { centres, gap } = railLevels(1100, 1, 100, 48.3);
    expect(gap).toBeCloseTo(451.7, 6);
    expect(centres[0]).toBeCloseTo(1100 - 24.15, 6);
    expect(centres[1]).toBeCloseTo(100 + 451.7 + 24.15, 6);
    expect(railLevels(1000, 0, 0, 48.3).gap).toBeCloseTo(951.7, 6);
  });
});

describe('railing defaults from the rule rows', () => {
  it('derives height, toe plate and knee rails from the active rulesets', () => {
    expect(railingDefaults(['iso_14122', 'osha_1910'], 48.3)).toMatchObject({ heightMm: 1100, toePlateMm: 100, kneeRails: 1 });
    expect(railingDefaults(['iso_14122'], 48.3)).toMatchObject({ heightMm: 1100, toePlateMm: 100, kneeRails: 1 });
    expect(railingDefaults(['osha_1910'], 48.3)).toMatchObject({ heightMm: 1066.8, toePlateMm: 88.9, kneeRails: 1 });
    expect(railingDefaults(['iso_14122'], 48.3).basis[0]).toContain('ISO-GRD-TOP');
    expect(railingDefaults(['iso_14122'], 400).kneeRails).toBe(1);
    expect(railingDefaults(['iso_14122'], 10).kneeRails).toBe(1);
  });
});

describe('add_railing on a path', () => {
  it('adds a defaulted guard-rail and names every default (SC-STA-05 step 4: 4 posts at 1333.33 mm)', () => {
    const { doc, upper } = deckDoc();
    const result = ok(doc, 'add_railing', { path: line(4000), levelId: upper });
    const info = result.data as {
      elementIds: string[];
      posts: number;
      lengthM: number;
      defaults: string[];
      railings: Array<{
        id: string;
        mark: string;
        posts: number;
        postSpacingMm: number;
        clearGapMm: number;
        steelKg: number;
        gates: number;
      }>;
    };
    expect(info.posts).toBe(4);
    expect(info.railings[0]).toMatchObject({ mark: 'RL1', posts: 4, postSpacingMm: 1333.333, clearGapMm: 451.7, gates: 0 });
    expect(info.railings[0]!.steelKg).toBeGreaterThan(0);
    expect(info.lengthM).toBe(4);
    expect(info.defaults.join('|')).toContain('ISO-GRD-TOP');
    expect(info.defaults.join('|')).toContain('postSpacingMax 1500 mm');
    expect(result.affected[0]).toBe('railing-1');
    expect(result.document.building?.elements['railing-1']).toMatchObject({
      category: 'railing',
      height: 1100,
      kneeRails: 1,
      toePlate: 100,
      role: 'guardrail',
      postProfile: 'CHS48.3x3.2',
      levelId: upper,
    });
    const names = Object.keys(result.document.entities).filter((id) => id.startsWith('railing-1:'));
    expect(names).toEqual(['railing-1:posts', 'railing-1:top-rail', 'railing-1:knee-rail-1', 'railing-1:toe-plate']);
    expect(result.document.order).toEqual(expect.arrayContaining(names));
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('takes explicit values without naming them as defaults and builds a handrail without a toe plate', () => {
    const { doc } = deckDoc();
    const result = ok(doc, 'add_railing', {
      path: line(3000),
      height: 900,
      kneeRails: 0,
      toePlate: 0,
      postSpacingMax: 1200,
      postProfile: 'RHS100x50x4',
      railProfile: 'CHS60.3x3.2',
      role: 'handrail',
      rulesets: ['osha_1910'],
    });
    const info = result.data as { defaults: string[]; posts: number };
    expect(info.defaults).toEqual([]);
    expect(info.posts).toBe(4);
    expect(Object.keys(result.document.entities).some((id) => id.endsWith(':toe-plate'))).toBe(false);
    expect(result.document.building?.elements['railing-1']).toMatchObject({ role: 'handrail', postProfile: 'RHS100x50x4' });
  });

  it('cuts a gap with a gate (ladder exit) and the gate leaf becomes its own entity', () => {
    const { doc, upper } = deckDoc();
    const result = ok(doc, 'add_railing', { path: line(4000), levelId: upper, openings: [{ from: 1500, to: 2500, gate: true }] });
    expect((result.data as { railings: Array<{ gates: number; posts: number }> }).railings[0]).toMatchObject({ gates: 1, posts: 4 });
    expect(result.document.entities['railing-1:gates']).toBeDefined();
    const open = ok(doc, 'add_railing', { path: line(4000), levelId: upper, openings: [{ from: 1500, to: 2500 }] });
    expect(open.document.entities['railing-1:gates']).toBeUndefined();
  });

  it('refuses bad input with stable codes', () => {
    const { doc, upper } = deckDoc();
    const ok1 = { path: line(4000), levelId: upper };
    expectRefusal(doc, 'add_railing', {}, 'STA_INVALID_GEOMETRY', 'path');
    expectRefusal(doc, 'add_railing', { ...ok1, hostId: 'slab-1' }, 'STA_INVALID_GEOMETRY', 'hostId');
    expectRefusal(
      doc,
      'add_railing',
      {
        path: [
          [0, 0, 0],
          [0, 0, 0],
        ],
        levelId: upper,
      },
      'STA_INVALID_GEOMETRY',
      'path',
    );
    expectRefusal(doc, 'add_railing', { ...ok1, levelId: 'level-9' }, 'STA_INVALID_GEOMETRY', 'levelId');
    expectRefusal(doc, 'add_railing', { ...ok1, railProfile: 'XX1' }, 'STA_INVALID_GEOMETRY', 'railProfile');
    expectRefusal(doc, 'add_railing', { ...ok1, postProfile: 'XX1' }, 'STA_INVALID_GEOMETRY', 'postProfile');
    expectRefusal(doc, 'add_railing', { ...ok1, height: 100, kneeRails: 3 }, 'STA_INVALID_GEOMETRY', 'height');
    expectRefusal(doc, 'add_railing', { ...ok1, role: 'handrail' }, 'STA_INVALID_GEOMETRY', 'height');
    expectRefusal(doc, 'add_railing', { ...ok1, openings: [{ from: 3000, to: 5000 }] }, 'STA_RAIL_OPENING', 'openings');
    expectRefusal(
      doc,
      'add_railing',
      {
        ...ok1,
        openings: [
          { from: 1000, to: 2000 },
          { from: 1500, to: 2500 },
        ],
      },
      'STA_RAIL_OPENING',
      'openings',
    );
    expectRefusal(doc, 'add_railing', { ...ok1, openings: [{ from: 0, to: 4000 }] }, 'STA_RAIL_OPENING', 'openings');
  });

  it('refuses a twin and is pure', () => {
    const { doc, upper } = deckDoc();
    const first = apply(doc, 'add_railing', { path: line(4000), levelId: upper });
    expectRefusal(first, 'add_railing', { path: [...line(4000)].reverse(), levelId: upper }, 'STA_INVALID_GEOMETRY');
    expectPure(doc, () => execute(doc, 'add_railing', { path: line(4000), levelId: upper }));
  });
});

describe('add_railing on host edges', () => {
  it('follows all edges of a slab as one closed railing (10 posts on 12 m) and records the host', () => {
    const { doc, deck, upper } = deckDoc();
    const result = ok(doc, 'add_railing', { hostId: deck, edges: 'all' });
    const info = result.data as { posts: number; railings: Array<{ id: string }>; lengthM: number };
    expect(info.railings).toHaveLength(1);
    expect(info.posts).toBe(10);
    expect(info.lengthM).toBe(12);
    const element = result.document.building?.elements['railing-1'];
    expect(element).toMatchObject({ levelId: upper, host: { hostId: deck, ring: 'boundary', edges: [0, 1, 2, 3] } });
    expect(element?.category === 'railing' && element.path[0]).toEqual([0, 0, 0]);
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('makes one railing per run of consecutive edges (cyclic) and follows the ring order', () => {
    const { doc, deck } = deckDoc();
    const wrapped = ok(doc, 'add_railing', { hostId: deck, edges: [3, 0] });
    expect((wrapped.data as { railings: unknown[] }).railings).toHaveLength(1);
    const run = wrapped.document.building?.elements['railing-1'];
    expect(run?.category === 'railing' && run.host?.edges).toEqual([0, 3]);
    expect(run?.category === 'railing' && run.path.map((point) => [point[0], point[1]])).toEqual([
      [0, 2000],
      [0, 0],
      [4000, 0],
    ]);
    const apart = ok(doc, 'add_railing', { hostId: deck, edges: [2, 0] });
    const rows = (apart.data as { railings: Array<{ id: string }> }).railings;
    expect(rows).toHaveLength(2);
    const hosts = rows.map((row) => {
      const element = apart.document.building?.elements[row.id];
      return element?.category === 'railing' ? element.host?.edges : undefined;
    });
    expect(hosts).toEqual([[0], [2]]);
  });

  it('guards a slab opening and a grating panel', () => {
    const { doc, deck } = deckDoc();
    const holed = apply(doc, 'add_slab_opening', { slabId: deck, boundary: rect(1000, 500, 2000, 1500) });
    const around = ok(holed, 'add_railing', { hostId: deck, opening: 0, edges: 'all' });
    expect((around.data as { lengthM: number }).lengthM).toBe(4);
    expect(around.document.building?.elements['railing-1']).toMatchObject({ host: { ring: 0 } });
    expectRefusal(holed, 'add_railing', { hostId: deck, opening: 3 }, 'STA_INVALID_GEOMETRY', 'opening');
    const { doc: grated, ids } = gratedFrame();
    const edge = ok(grated, 'add_railing', { hostId: ids[2], edges: [1] });
    expect(edge.document.building?.elements['railing-1']).toMatchObject({ host: { hostId: ids[2], ring: 'boundary', edges: [1] } });
    expectRefusal(grated, 'add_railing', { hostId: ids[2], opening: 0 }, 'STA_INVALID_GEOMETRY', 'opening');
  });

  it('refuses an unknown host, a host that is no surface and an edge outside the ring', () => {
    const { doc, deck } = deckDoc();
    expectRefusal(doc, 'add_railing', { hostId: 'slab-9' }, 'STA_UNKNOWN_ELEMENT', 'hostId');
    const column = apply(doc, 'add_column', { location: [100, 100], width: 300, depth: 300, height: 3000 });
    const columnId = Object.values(column.building?.elements ?? {}).find((element) => element.category === 'column')!.id;
    const bad = expectRefusal(column, 'add_railing', { hostId: columnId }, 'STA_INVALID_GEOMETRY', 'hostId');
    expect(bad.summary).toContain('railings follow slabs and gratings');
    const outside = expectRefusal(doc, 'add_railing', { hostId: deck, edges: [7] }, 'STA_INVALID_GEOMETRY', 'edges');
    expect(outside.summary).toContain('outside 0..3');
    const direct = hostPaths(doc.building!.elements[deck]!, [1], undefined);
    expect(direct.ok && direct.paths[0]?.path).toEqual([
      [4000, 0, 0],
      [4000, 2000, 0],
    ]);
  });

  it('moves with its host, is refused alone, and is deleted with it', () => {
    const { doc, deck } = deckDoc();
    const withRail = apply(doc, 'add_railing', { hostId: deck, edges: [0] });
    const moved = apply(withRail, 'move_building_element', { elementIds: [deck], delta: [500, 100] });
    const rail = moved.building?.elements['railing-1'];
    expect(rail?.category === 'railing' && rail.path[0]).toEqual([500, 100, 0]);
    expectNoOp(
      execute(withRail, 'move_building_element', { elementIds: ['railing-1'], delta: [10, 0] }),
      withRail,
      `railing-1 follows its host ${deck} (a slab or grating`,
    );
    const deleted = apply(withRail, 'delete_building_element', { elementIds: [deck] });
    expect(deleted.building?.elements['railing-1']).toBeUndefined();
    expect(Object.keys(deleted.entities).some((id) => id.startsWith('railing-1:'))).toBe(false);
  });

  it('moves a free railing on its own', () => {
    const { doc, upper } = deckDoc();
    const withRail = apply(doc, 'add_railing', { path: line(2000), levelId: upper });
    const moved = apply(withRail, 'move_building_element', { elementIds: ['railing-1'], delta: [10, 20] });
    const rail = moved.building?.elements['railing-1'];
    expect(rail?.category === 'railing' && rail.path[1]).toEqual([2010, 20, 0]);
  });
});

describe('update_railing', () => {
  const { doc, upper } = deckDoc();
  const start = apply(doc, 'add_railing', { path: line(4000), levelId: upper, height: 1000, kneeRails: 0, toePlate: 0 });

  it('changes the given fields, regenerates the entities and keeps the path', () => {
    const result = ok(start, 'update_railing', { id: 'railing-1', height: 1100, kneeRails: 1, toePlate: 100 });
    expect(result.document.building?.elements['railing-1']).toMatchObject({ height: 1100, kneeRails: 1, toePlate: 100 });
    expect(result.document.entities['railing-1:toe-plate']).toBeDefined();
    expect(result.document.entities['railing-1:knee-rail-1']).toBeDefined();
    expect(result.summary).toContain('height, kneeRails, toePlate');
    const gap = ok(result.document, 'update_railing', { id: 'railing-1', openings: [{ from: 1000, to: 2000, gate: true }] });
    expect(gap.document.building?.elements['railing-1']).toMatchObject({ openings: [{ from: 1000, to: 2000, gate: true }] });
    expect(gap.document.entities['railing-1:gates']).toBeDefined();
  });

  it('refuses unknown ids and invalid results and does nothing when nothing changes', () => {
    expectRefusal(start, 'update_railing', { id: 'slab-1', height: 1100 }, 'STA_UNKNOWN_ELEMENT', 'id');
    expectRefusal(start, 'update_railing', { id: 'railing-1', height: 30, kneeRails: 2 }, 'STA_INVALID_GEOMETRY', 'height');
    expectRefusal(start, 'update_railing', { id: 'railing-1', openings: [{ from: 0, to: 9000 }] }, 'STA_RAIL_OPENING', 'openings');
    expectNoOp(execute(start, 'update_railing', { id: 'railing-1', height: 1000 }), start, 'already has these values');
    expectPure(start, () => execute(start, 'update_railing', { id: 'railing-1', height: 1200 }));
  });
});

describe('railing takeoff, schedule and persistence', () => {
  const { doc, upper } = deckDoc();
  const railed = apply(doc, 'add_railing', { path: line(4000), levelId: upper, openings: [{ from: 1500, to: 2500, gate: true }] });

  it('adds railing.<part> lines: rails 6 m, 4 posts, toe plate 3 m, 1 gate, steel mass', () => {
    const lines = new Map(
      data<{ lines: Array<{ key: string; quantity: number }> }>(railed, 'quantity_takeoff', {}).lines.map((row) => [row.key, row.quantity]),
    );
    expect(lines.get('railing.rail.m')).toBe(6);
    expect(lines.get('railing.post.ea')).toBe(4);
    expect(lines.get('railing.toe-plate.m')).toBe(3);
    expect(lines.get('railing.gate.ea')).toBe(1);
    const tube = ((Math.PI * (48.3 ** 2 - 41.9 ** 2)) / 4 / 1e6) * 7850;
    const expectedKg = 4 * ((1100 - 24.15) / 1000) * tube + (6 + 2 * 1) * tube + 3 * 0.1 * 0.005 * 7850;
    expect(lines.get('railing.steel.kg')).toBeCloseTo(expectedKg, 1);
  });

  it('lists the railing in building_schedule railing', () => {
    const schedule = data<{ rows: Array<Array<string | number>> }>(railed, 'building_schedule', { kind: 'railing' });
    expect(schedule.rows).toHaveLength(1);
    expect(schedule.rows[0]!.slice(0, 7)).toEqual(['RL1', 'guardrail', 4, 4, 1100, 2, 100]);
  });

  it('rejects stored railings that add_railing would refuse: negative or fractional knee rails, negative toe plate, unordered gaps, unknown profile', () => {
    const errorsOf = (changes: Record<string, unknown>): string[] => {
      const copy = JSON.parse(JSON.stringify(railed.building)) as { elements: Record<string, Record<string, unknown>> };
      copy.elements['railing-1'] = { ...copy.elements['railing-1'], ...changes };
      return buildingErrors(copy);
    };
    expect(errorsOf({ kneeRails: -1 })).toContain('building element railing-1: kneeRails must be an integer 0..10');
    expect(errorsOf({ kneeRails: 2.5 })).toContain('building element railing-1: kneeRails must be an integer 0..10');
    expect(errorsOf({ toePlate: -50 })).toContain('building element railing-1: toePlate must be >= 0');
    expect(
      errorsOf({
        openings: [
          { from: 2000, to: 3000, gate: false },
          { from: 500, to: 900, gate: false },
        ],
      }).join('|'),
    ).toContain('ascending and non-overlapping');
    expect(errorsOf({ openings: [{ from: 0, to: 9000, gate: true }] }).join('|')).toContain('not inside 0..');
    expect(errorsOf({ railProfile: 'GONE' }).join('|')).toContain("unknown rail profile 'GONE'");
  });

  it('rejects a malformed stored railing', () => {
    const broken = JSON.parse(JSON.stringify(railed.building)) as { elements: Record<string, Record<string, unknown>> };
    broken.elements['railing-1'] = {
      ...broken.elements['railing-1'],
      path: [[0, 0]],
      role: 'fence',
      openings: [{ from: 0 }],
      host: { hostId: 'nope' },
      railProfile: 2,
    };
    expect(buildingErrors(broken)).toEqual(
      expect.arrayContaining([
        'building element railing-1: path must be ≥ 2 [x, y, z] points',
        'building element railing-1: role must be guardrail or handrail',
        'building element railing-1: railProfile must be a string',
        'building element railing-1: openings must be { from, to, gate } records',
        'building element railing-1: host must be { hostId (a slab or grating), ring, edges }',
      ]),
    );
    expect(buildingErrors(railed.building)).toEqual([]);
  });
});

describe('check_access: railings (VC-STA-05)', () => {
  const { doc, upper } = deckDoc();
  const rail = (params: Record<string, unknown>): typeof doc => apply(doc, 'add_railing', { path: line(4000), levelId: upper, ...params });
  interface Result {
    verdict: string;
    findings: Array<{
      code: string;
      ruleset: string;
      severity: string;
      ids: string[];
      measured: { value: number };
      remediation: string;
      ruleId: string;
    }>;
    checked: { railings: number };
    unverifiedRulesUsed: string[];
    notEvaluated: Array<{ ruleId: string }>;
    byId: Record<string, { verdict: string }>;
  }
  const check = (document: typeof doc, params: Record<string, unknown> = {}): Result =>
    data<Result>(document, 'check_access', { rulesets: BOTH, include: ['railings'], ...params });
  const codes = (result: Result, ruleset: string): string[] =>
    result.findings.filter((f) => f.ruleset === ruleset).map((f) => `${f.code}:${f.severity}`);

  it('passes the 1100 mm / 1 knee rail / 100 mm toe plate guard-rail under both rulesets', () => {
    const result = check(rail({}));
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe('pass');
    expect(result.checked.railings).toBe(1);
    expect(result.byId['railing-1']?.verdict).toBe('pass');
    expect(result.unverifiedRulesUsed).toEqual(['OSHA-GRD-MID', 'OSHA-TOE-HEIGHT']);
    expect(result.notEvaluated.map((row) => row.ruleId)).toEqual([
      'OSHA-GRD-MID',
      'OSHA-GRD-LOAD',
      'OSHA-GRD-DEFL',
      'OSHA-GRD-MIDLOAD',
      'ISO-TOE-GAP',
      'ISO-GRD-POST-SPACING',
    ]);
  });

  it('fails a 1000 mm guard-rail with no knee rail or toe plate under ISO and warns under OSHA (AC-06)', () => {
    const result = check(rail({ height: 1000, kneeRails: 0, toePlate: 0 }));
    expect(codes(result, 'iso_14122')).toEqual(['STA_RAIL_HEIGHT_LOW:fail', 'STA_RAIL_GAP:fail', 'STA_TOE_PLATE_MISSING:fail']);
    expect(codes(result, 'osha_1910')).toEqual([
      'STA_RAIL_GAP:warn',
      'STA_TOE_PLATE_MISSING:warn',
      'STA_RULE_UNVERIFIED:warn',
      'STA_RULE_UNVERIFIED:warn',
    ]);
    expect(result.findings.find((f) => f.code === 'STA_RAIL_HEIGHT_LOW')?.measured.value).toBe(1000);
    expect(result.findings.find((f) => f.code === 'STA_RAIL_GAP')?.measured.value).toBeCloseTo(951.7, 6);
    expect(result.findings.every((f) => f.ids.length > 0 && f.remediation.length > 0)).toBe(true);
    expect(result.verdict).toBe('fail');
  });

  it('applies the OSHA top-rail band: 980 fails low, 1200 only warns high while ISO passes it', () => {
    const low = check(rail({ height: 980, kneeRails: 1 }));
    expect(codes(low, 'osha_1910')).toContain('STA_RAIL_HEIGHT_LOW:fail');
    const high = check(rail({ height: 1200, kneeRails: 2 }));
    expect(codes(high, 'osha_1910')).toEqual(['STA_RAIL_HEIGHT_HIGH:warn']);
    expect(codes(high, 'iso_14122')).toEqual([]);
    expect(high.verdict).toBe('warn');
  });

  it('fails a guard-rail whose profile left the catalogue instead of passing it silently', () => {
    const broken = JSON.parse(JSON.stringify(rail({}))) as typeof doc;
    const element = broken.building?.elements['railing-1'];
    if (element?.category === 'railing') element.railProfile = 'GONE';
    const result = check(broken);
    expect(result.verdict).toBe('fail');
    expect(result.findings.map((finding) => [finding.code, finding.ruleId, finding.severity])).toEqual([
      ['STA_INVALID_GEOMETRY', 'RAILING-PROFILE', 'fail'],
    ]);
  });

  it('only evaluates the requested ruleset and lists hand-rails as not evaluated', () => {
    const only = check(rail({ height: 1000, kneeRails: 0, toePlate: 0 }), { rulesets: ['osha_1910'] });
    expect(only.findings.every((f) => f.ruleset === 'osha_1910')).toBe(true);
    const hand = check(rail({ role: 'handrail', height: 900 }));
    expect(hand.findings).toEqual([]);
    expect(hand.notEvaluated.map((row) => row.ruleId)).toContain('handrail');
  });

  it('lists other element kinds as skipped and refuses non-building ids', () => {
    const railed = rail({});
    expectRefusal(railed, 'check_access', { rulesets: BOTH, ids: ['nope'] }, 'STA_UNKNOWN_ELEMENT', 'ids');
    const withColumn = apply(railed, 'add_column', { location: [100, 100], width: 300, depth: 300, height: 3000, levelId: upper });
    const columnId = Object.values(withColumn.building?.elements ?? {}).find((element) => element.category === 'column')!.id;
    const only = data<{ skipped: string[]; checked: { railings: number } }>(withColumn, 'check_access', {
      rulesets: BOTH,
      ids: ['railing-1', columnId],
    });
    expect(only.checked.railings).toBe(1);
    expect(only.skipped).toEqual([columnId]);
  });

  interface EdgeResult {
    verdict: string;
    findings: Array<{ code: string; location?: string }>;
    edges: Array<{ location: string; protected: boolean }>;
  }
  const edgeCheck = (document: typeof doc, params: Record<string, unknown> = {}): EdgeResult =>
    data<EdgeResult>(document, 'check_access', { rulesets: BOTH, include: ['edges'], edgeDropThresholdMm: 500, ...params });

  it('credits a railing around the deck to its open edges (drop 4000 mm > 500)', () => {
    const { doc: deck, deck: deckId } = deckDoc();
    expect(edgeCheck(deck).findings).toHaveLength(4);
    const guarded = apply(deck, 'add_railing', { hostId: deckId, edges: 'all' });
    const result = edgeCheck(guarded);
    expect(result.edges.map((edge) => edge.protected)).toEqual([true, true, true, true]);
    expect(result.verdict).toBe('pass');
    const partial = edgeCheck(apply(deck, 'add_railing', { hostId: deckId, edges: [0, 1] }));
    expect(partial.edges.map((edge) => edge.protected)).toEqual([true, true, false, false]);
  });

  it('does not credit a railing below the guard minimum, a gap without a gate, or a railing at another height', () => {
    const { doc: deck, deck: deckId } = deckDoc();
    const low = apply(deck, 'add_railing', { hostId: deckId, edges: 'all', height: 1000 });
    expect(edgeCheck(low).findings).toHaveLength(4);
    expect(edgeCheck(low, { rulesets: ['osha_1910'] }).findings).toHaveLength(0);
    const gap = apply(deck, 'add_railing', { hostId: deckId, edges: [0], openings: [{ from: 1000, to: 2000 }] });
    expect(edgeCheck(gap).edges[0]?.protected).toBe(false);
    const gate = apply(deck, 'add_railing', { hostId: deckId, edges: [0], openings: [{ from: 1000, to: 2000, gate: true }] });
    expect(edgeCheck(gate).edges[0]?.protected).toBe(true);
    const raised = apply(deck, 'add_railing', {
      path: [
        [0, 0, 300],
        [4000, 0, 300],
      ],
      levelId: Object.keys(deck.building?.levels ?? {})[1],
    });
    expect(edgeCheck(raised).edges[0]?.protected).toBe(false);
    const away = apply(deck, 'add_railing', {
      path: [
        [0, -400, 0],
        [4000, -400, 0],
      ],
      levelId: Object.keys(deck.building?.levels ?? {})[1],
    });
    expect(edgeCheck(away).edges[0]?.protected).toBe(false);
  });

  it('checks the open edges of a grating platform and credits its railing', () => {
    const { doc: grated, ids } = gratedFrame();
    const raised = apply(grated, 'add_level', { name: 'Ground', elevation: -4000, height: 3000 });
    const result = edgeCheck(raised, { ids });
    expect(result.edges).toHaveLength(12);
    expect(result.findings.length).toBeGreaterThan(0);
    const guarded = apply(raised, 'add_railing', { hostId: ids[2], edges: [1] });
    expect(edgeCheck(guarded, { ids: [ids[2]!] }).edges.find((edge) => edge.location === 'boundary edge 1')?.protected).toBe(true);
  });
});
