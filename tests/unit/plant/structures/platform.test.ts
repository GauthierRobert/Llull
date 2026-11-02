/**
 * Plant 06 STA M6 (deck platform): add_access_platform, update_access_platform, access_platform_takeoff, the platform assembly, its derivation guard,
 * persistence, schedule, check_access and IFC. Hand numbers (VC-STA-08): a 6000 x 3000 deck with bars along x and beams every <= 1000 mm has
 * 6 bays, 7 beams of 3000 mm and 6 panels of 1000 x 3000 mm = 18 m2, 18 x 43.4536 = 782.165 kg of 19-W-4 1-1/4x3/16; all four edges railed
 * (perimeter 18 m) with one 800 mm gate opening leave 17.2 m of rail.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { AssemblyElement } from '@aec/building/types';
import { buildingErrors } from '@aec/building/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { BOTH, TYPE, gratingFrame, rect } from './accessFixtures';

const DECK = {
  bounds: [
    [0, 0],
    [6000, 3000],
  ],
  gratingType: TYPE,
  bearingBarDirection: [1, 0],
};
const RAILED = { ...DECK, topOffset: 3000, railing: { openings: [{ from: 2000, to: 2800, gate: true }] } };

const base = (): CadDocument => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  return doc;
};

interface PlatformData {
  assemblyId: string;
  partIds: string[];
  memberIds: string[];
  gratingIds: string[];
  railingIds: string[];
  quantities: {
    panels: number;
    gratingAreaM2: number;
    gratingMassKg: number;
    members: number;
    memberLengthM: number;
    railingLengthM: number;
    posts: number;
    steelKg: number;
  };
  defaults: string[];
}
const answer = (result: { data?: unknown }): PlatformData => result.data as PlatformData;
const assemblyOf = (doc: CadDocument, id = 'assembly-1'): AssemblyElement => {
  const element = doc.building?.elements[id];
  if (element?.category !== 'assembly') throw new Error(`no assembly ${id}`);
  return element;
};
const partIds = (doc: CadDocument, category: string): string[] =>
  Object.values(doc.building?.elements ?? {})
    .filter((element) => element.category === category)
    .map((element) => element.id);

describe('add_access_platform: closed form (VC-STA-08)', () => {
  const doc = base();
  const built = ok(doc, 'add_access_platform', RAILED);
  const got = answer(built);

  it('generates 7 beams, 6 panels and one railing with the hand-calculated quantities', () => {
    expect(got.assemblyId).toBe('assembly-1');
    expect(got.memberIds).toHaveLength(7);
    expect(got.gratingIds).toHaveLength(6);
    expect(got.railingIds).toHaveLength(1);
    expect(got.quantities.gratingAreaM2).toBeCloseTo(18, 6);
    expect(got.quantities.gratingMassKg).toBeCloseTo(782.165, 2);
    expect(got.quantities.memberLengthM).toBeCloseTo(21, 6);
    expect(got.quantities.railingLengthM).toBeCloseTo(17.2, 6);
    expect(got.quantities.posts).toBe(14);
    expect(got.quantities.steelKg).toBeGreaterThan(470.4);
    expect(got.defaults.join(';')).toContain('framing profile IPE200');
    expect(built.affected.slice(0, 3)).toEqual(['assembly-1', 'member-1', 'member-2']);
  });

  it('puts the assembly in the model with its parts, marks and back references', () => {
    const assembly = assemblyOf(built.document);
    expect(assembly.kind).toBe('platform');
    expect(assembly.mark).toBe('AS1');
    expect(assembly.generation).toBe(1);
    expect(assembly.partIds).toEqual(got.partIds);
    expect(assembly.entityIds).toEqual([]);
    for (const id of assembly.partIds) {
      const part = built.document.building?.elements[id];
      expect(part && 'assemblyId' in part && part.assemblyId, id).toBe('assembly-1');
    }
    const marks = got.partIds.map((id) => built.document.building?.elements[id]?.mark);
    expect(marks).toEqual(['SB1', 'SB2', 'SB3', 'SB4', 'SB5', 'SB6', 'SB7', 'GR1', 'GR2', 'GR3', 'GR4', 'GR5', 'GR6', 'RL1']);
    expect(buildingErrors(built.document.building)).toEqual([]);
  });

  it('bears each panel on two beams with the top of steel at the grating underside', () => {
    const panel = built.document.building?.elements['grating-1'];
    expect(panel?.category === 'grating' && panel.supportIds).toEqual([['member-1'], ['member-2']]);
    const beam = built.document.building?.elements['member-1'];
    // underside = 3000 - 31.75; top of steel = centre + 100 (IPE200 h/2)
    expect(beam?.category === 'member' && beam.start[2]).toBeCloseTo(3000 - 31.75 - 100, 6);
    expect(beam?.category === 'member' && beam.role).toBe('beam');
    const second = built.document.building?.elements['grating-6'];
    expect(second?.category === 'grating' && second.supportIds).toEqual([['member-6'], ['member-7']]);
  });

  it('derives entities for the parts and none for the assembly', () => {
    expect(assemblyOf(built.document).entityIds).toHaveLength(0);
    const member = built.document.building?.elements['member-1'];
    expect(member?.entityIds.length).toBeGreaterThan(0);
    expect(built.document.entities[member?.entityIds[0] as string]?.layerId).toBe('layer-S-BEAM');
  });

  it('the generated panels pass check_grating supports and the edges pass check_access (edgeUnprotected absent)', () => {
    const grating = data<{ panels: Array<{ id: string; findings: Array<{ code: string }> }> }>(built.document, 'check_grating', {
      uniformLoadKPa: 2,
      deflectionRatio: 200,
    });
    expect(grating.panels).toHaveLength(6);
    expect(grating.panels.flatMap((panel) => panel.findings.map((finding) => finding.code))).not.toContain('STA_NO_SUPPORT_FOUND');
    const checked = data<{
      findings: Array<{ code: string }>;
      byId: Record<string, unknown>;
      checked: { gratings: number; railings: number };
    }>(built.document, 'check_access', { ids: ['assembly-1'], rulesets: BOTH, edgeDropThresholdMm: 500 });
    expect(checked.findings.filter((finding) => finding.code === 'STA_EDGE_UNPROTECTED')).toEqual([]);
    expect(checked.checked).toMatchObject({ gratings: 6, railings: 1 });
    expect(Object.keys(checked.byId)).toContain('railing-1');
  });

  it('without the railing the same deck has unprotected edges (the railing is what protects them)', () => {
    const open = apply(doc, 'add_access_platform', { ...DECK, topOffset: 3000 });
    const checked = data<{ findings: Array<{ code: string }> }>(open, 'check_access', {
      ids: ['assembly-1'],
      rulesets: BOTH,
      edgeDropThresholdMm: 500,
    });
    expect(checked.findings.filter((finding) => finding.code === 'STA_EDGE_UNPROTECTED').length).toBeGreaterThan(0);
  });

  it('takes a polygon boundary, a bar direction along y and custom framing', () => {
    const result = ok(doc, 'add_access_platform', {
      boundary: rect(0, 0, 2000, 3000),
      gratingType: TYPE,
      bearingBarDirection: [0, 2],
      framing: { profile: 'IPE160', maxSpacing: 1500 },
    });
    const got2 = answer(result);
    expect(got2.memberIds).toHaveLength(3);
    expect(got2.gratingIds).toHaveLength(2);
    expect(got2.quantities.memberLengthM).toBeCloseTo(6, 6);
    expect(got2.quantities.gratingAreaM2).toBeCloseTo(6, 6);
  });

  it('is pure and replays to the same ids and elements', () => {
    expectPure(doc, () => execute(doc, 'add_access_platform', RAILED));
    const replayed = execute(built.document, 'replay_history', {}).document;
    expect(replayed.building?.elements['assembly-1']).toEqual(built.document.building?.elements['assembly-1']);
    expect(Object.keys(replayed.building?.elements ?? {})).toEqual(Object.keys(built.document.building?.elements ?? {}));
    expect(Object.keys(replayed.entities).sort()).toEqual(Object.keys(built.document.entities).sort());
  });
});

describe('add_access_platform: caps against a unit mistake', () => {
  it('refuses a spacing that would generate hundreds of beams or thousands of posts', () => {
    const doc = base();
    expectRefusal(doc, 'add_access_platform', { ...DECK, framing: { maxSpacing: 1 } }, 'STA_INVALID_GEOMETRY', 'framing');
    expectRefusal(doc, 'add_access_platform', { ...DECK, railing: { postSpacingMax: 1 } }, 'STA_INVALID_GEOMETRY', 'railing');
  });
});

describe('add_access_platform: existing framing', () => {
  it('bears the panels on the beams already in the model and adds no member', () => {
    const framed = gratingFrame();
    const result = ok(framed, 'add_access_platform', {
      bounds: [
        [0, 0],
        [3324, 3000],
      ],
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      framing: 'existing',
    });
    const got = answer(result);
    expect(got.memberIds).toEqual([]);
    expect(got.gratingIds).toHaveLength(3);
    expect(got.quantities.gratingAreaM2).toBeCloseTo(3.324 * 3, 6);
  });

  it('refuses when no beam bears under the end edges (STA_NO_SUPPORT_FOUND)', () => {
    expectRefusal(base(), 'add_access_platform', { ...DECK, framing: 'existing' }, 'STA_NO_SUPPORT_FOUND', 'framing');
  });
});

describe('add_access_platform: refusals leave the document unchanged', () => {
  const doc = base();

  it('rejects bad input with a stable code and the parameter path', () => {
    expectRefusal(doc, 'add_access_platform', { ...DECK, gratingType: 'nope' }, 'STA_GRATING_TYPE_UNKNOWN', 'gratingType');
    expectRefusal(doc, 'add_access_platform', { ...DECK, boundary: rect(0, 0, 10, 10) }, 'STA_INVALID_GEOMETRY', 'boundary');
    expectRefusal(doc, 'add_access_platform', { gratingType: TYPE, bearingBarDirection: [1, 0] }, 'STA_INVALID_GEOMETRY', 'bounds');
    expectRefusal(doc, 'add_access_platform', { ...DECK, bearingBarDirection: [0, 0] }, 'STA_INVALID_GEOMETRY', 'bearingBarDirection');
    expectRefusal(doc, 'add_access_platform', { ...DECK, levelId: 'ghost' }, 'STA_INVALID_GEOMETRY', 'levelId');
    expectRefusal(doc, 'add_access_platform', { ...DECK, framing: { profile: 'ZZ9' } }, 'STA_INVALID_GEOMETRY', 'framing');
    expectRefusal(doc, 'add_access_platform', { ...DECK, railing: { railProfile: 'ZZ9' } }, 'STA_INVALID_GEOMETRY', 'railing');
    expectRefusal(doc, 'add_access_platform', { ...DECK, railing: { edges: [9] } }, 'STA_INVALID_GEOMETRY', 'railing');
    expectRefusal(doc, 'add_access_platform', { ...DECK, railing: { height: 40 } }, 'STA_INVALID_GEOMETRY', 'railing');
  });

  it('refuses a non-convex region (an L shape)', () => {
    const lShape = [
      [0, 0],
      [4000, 0],
      [4000, 1000],
      [1000, 1000],
      [1000, 3000],
      [0, 3000],
    ];
    expectRefusal(doc, 'add_access_platform', { ...DECK, bounds: undefined, boundary: lShape }, 'STA_INVALID_GEOMETRY', 'boundary');
  });

  it('refuses openings when the edges give two railing runs (STA_RAIL_OPENING)', () => {
    expectRefusal(
      doc,
      'add_access_platform',
      { ...DECK, railing: { edges: [0, 2], openings: [{ from: 100, to: 200 }] } },
      'STA_RAIL_OPENING',
      'railing',
    );
  });

  it('refuses a second platform that overlaps the first at the same elevation, but not a neighbour or another elevation', () => {
    const first = apply(doc, 'add_access_platform', DECK);
    expectRefusal(
      first,
      'add_access_platform',
      {
        ...DECK,
        bounds: [
          [3000, 0],
          [9000, 3000],
        ],
      },
      'STA_PLATFORM_OVERLAP',
      'boundary',
    );
    expectRefusal(first, 'add_access_platform', DECK, 'STA_PLATFORM_OVERLAP');
    const next = ok(first, 'add_access_platform', {
      ...DECK,
      bounds: [
        [6000, 0],
        [12000, 3000],
      ],
    });
    expect(answer(next).assemblyId).toBe('assembly-2');
    const higher = ok(first, 'add_access_platform', { ...DECK, topOffset: 2500 });
    expect(answer(higher).gratingIds).toHaveLength(6);
  });
});

describe('platform assembly: derivation guard (L8)', () => {
  const built = apply(base(), 'add_access_platform', RAILED);

  it('refuses direct edits of a generated part with CMD_DERIVED_GEOMETRY', () => {
    for (const [name, params] of [
      ['update_grating', { ids: ['grating-1'], gratingType: '19-W-4 1-1/2x3/16' }],
      ['update_railing', { id: 'railing-1', height: 1200 }],
      ['delete_building_element', { elementIds: ['grating-1'] }],
      ['delete_building_element', { elementIds: ['member-3'] }],
    ] as const) {
      const result = execute(built, name, params);
      expect(result.rejected, name).toBe(true);
      expect(result.document, name).toBe(built);
      expect(result.error?.code, name).toBe('CMD_DERIVED_GEOMETRY');
      expect(result.summary, name).toContain('update_access_platform');
    }
  });

  it('refuses to move a part or the assembly by itself', () => {
    for (const id of ['member-1', 'grating-2', 'railing-1', 'assembly-1']) {
      const result = execute(built, 'move_building_element', { elementIds: [id], delta: [100, 0] });
      expect(result.document, id).toBe(built);
      expect(result.summary, id).toContain('update_access_platform');
    }
  });

  it('deleting the assembly removes every part and entity', () => {
    const removed = apply(built, 'delete_building_element', { elementIds: ['assembly-1'] });
    expect(Object.keys(removed.building?.elements ?? {})).toEqual([]);
    expect(Object.keys(removed.entities)).toEqual([]);
  });

  it('allows an unrelated element to change', () => {
    const more = apply(built, 'add_slab', { boundary: rect(10000, 0, 12000, 2000), thickness: 100 });
    expect(Object.keys(more.building?.elements ?? {})).toContain('slab-1');
  });
});

describe('update_access_platform: deck', () => {
  const built = apply(base(), 'add_access_platform', RAILED);

  it('keeps the ids of the parts it regenerates and bumps the generation', () => {
    const before = assemblyOf(built).partIds;
    const result = ok(built, 'update_access_platform', { assemblyId: 'assembly-1', topOffset: 3500 });
    const assembly = assemblyOf(result.document);
    expect(assembly.generation).toBe(2);
    expect(assembly.partIds).toEqual(before);
    const panel = result.document.building?.elements['grating-1'];
    expect(panel?.category === 'grating' && panel.topOffset).toBe(3500);
    expect(buildingErrors(result.document.building)).toEqual([]);
    expect(result.affected[0]).toBe('assembly-1');
  });

  it('adds parts for a bigger deck (new ids) and removes the surplus for a smaller one', () => {
    const bigger = ok(built, 'update_access_platform', {
      assemblyId: 'assembly-1',
      bounds: [
        [0, 0],
        [8000, 3000],
      ],
      railing: { openings: [] },
    });
    const got = answer(bigger);
    expect(got.memberIds).toHaveLength(9);
    expect(got.gratingIds).toHaveLength(8);
    expect(got.memberIds.slice(0, 7)).toEqual(answer({ data: { memberIds: assemblyOf(built).partIds.slice(0, 7) } }).memberIds);
    expect(got.quantities.gratingAreaM2).toBeCloseTo(24, 6);
    const smaller = ok(bigger.document, 'update_access_platform', {
      assemblyId: 'assembly-1',
      bounds: [
        [0, 0],
        [2000, 3000],
      ],
      railing: { openings: [] },
    });
    expect(answer(smaller).memberIds).toHaveLength(3);
    expect(partIds(smaller.document, 'member')).toHaveLength(3);
    expect(partIds(smaller.document, 'grating')).toHaveLength(2);
  });

  it('merges railing fields, and null removes the railing', () => {
    const taller = ok(built, 'update_access_platform', { assemblyId: 'assembly-1', railing: { height: 1200 } });
    const railing = taller.document.building?.elements['railing-1'];
    expect(railing?.category === 'railing' && railing.height).toBe(1200);
    expect(railing?.category === 'railing' && railing.openings).toEqual([{ from: 2000, to: 2800, gate: true }]);
    expect(railing?.category === 'railing' && railing.toePlate).toBe(100);
    const bare = ok(built, 'update_access_platform', { assemblyId: 'assembly-1', railing: null });
    expect(answer(bare).railingIds).toEqual([]);
    expect(partIds(bare.document, 'railing')).toEqual([]);
    const again = ok(bare.document, 'update_access_platform', { assemblyId: 'assembly-1', railing: { edges: [0, 1] } });
    expect(answer(again).railingIds).toHaveLength(1);
  });

  it('changes the grating type and the framing', () => {
    const deeper = ok(built, 'update_access_platform', {
      assemblyId: 'assembly-1',
      gratingType: '19-W-4 1-1/2x3/16',
      framing: { profile: 'IPE240', maxSpacing: 1500 },
    });
    const got = answer(deeper);
    expect(got.memberIds).toHaveLength(5);
    expect(got.gratingIds).toHaveLength(4);
    const panel = deeper.document.building?.elements['grating-1'];
    expect(panel?.category === 'grating' && panel.gratingType).toBe('19-W-4 1-1/2x3/16');
  });

  it('refuses without changing the document: unknown id, wrong kind of field, bad result', () => {
    expectRefusal(built, 'update_access_platform', { assemblyId: 'member-1', topOffset: 1 }, 'STA_UNKNOWN_ELEMENT', 'assemblyId');
    expectRefusal(built, 'update_access_platform', { assemblyId: 'assembly-1', sweepDeg: 90 }, 'STA_INVALID_GEOMETRY', 'sweepDeg');
    expectRefusal(
      built,
      'update_access_platform',
      {
        assemblyId: 'assembly-1',
        boundary: rect(0, 0, 1, 1),
        bounds: [
          [0, 0],
          [1, 1],
        ],
      },
      'STA_INVALID_GEOMETRY',
      'boundary',
    );
    expectRefusal(built, 'update_access_platform', { assemblyId: 'assembly-1', gratingType: 'nope' }, 'STA_GRATING_TYPE_UNKNOWN');
    expectRefusal(
      built,
      'update_access_platform',
      { assemblyId: 'assembly-1', railing: { edges: ['outer'] } },
      'STA_INVALID_GEOMETRY',
      'railing',
    );
    expectRefusal(
      built,
      'update_access_platform',
      { assemblyId: 'assembly-1', railing: { railProfile: 'ZZ9' } },
      'STA_INVALID_GEOMETRY',
      'railing',
    );
    expectRefusal(built, 'update_access_platform', { assemblyId: 'assembly-1', bearingBarDirection: [0, 0] }, 'STA_INVALID_GEOMETRY');
  });

  it('is a no-op when nothing would change, and pure', () => {
    const result = execute(built, 'update_access_platform', { assemblyId: 'assembly-1', topOffset: 3000 });
    expect(result.document).toBe(built);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('already matches');
    expectPure(built, () => execute(built, 'update_access_platform', { assemblyId: 'assembly-1', topOffset: 3500 }));
  });

  it('refuses to move the deck onto another platform', () => {
    const two = apply(built, 'add_access_platform', {
      ...DECK,
      bounds: [
        [6000, 0],
        [12000, 3000],
      ],
      topOffset: 3000,
    });
    expectRefusal(
      two,
      'update_access_platform',
      {
        assemblyId: 'assembly-2',
        bounds: [
          [5000, 0],
          [11000, 3000],
        ],
      },
      'STA_PLATFORM_OVERLAP',
    );
  });

  it('replays an update to the same document', () => {
    const edited = apply(built, 'update_access_platform', {
      assemblyId: 'assembly-1',
      bounds: [
        [0, 0],
        [8000, 3000],
      ],
    });
    const replayed = execute(edited, 'replay_history', {}).document;
    expect(replayed.building?.elements['assembly-1']).toEqual(edited.building?.elements['assembly-1']);
    expect(Object.keys(replayed.building?.elements ?? {})).toEqual(Object.keys(edited.building?.elements ?? {}));
  });
});

describe('access_platform_takeoff, schedule and quantity_takeoff', () => {
  const built = apply(base(), 'add_access_platform', RAILED);
  interface Takeoff {
    platforms: Array<{ id: string; stale: boolean; staleReason: string | null; gratingAreaM2: number; railingLengthM: number }>;
    totals: { platforms: number; gratingAreaM2: number; gratingMassKg: number };
  }

  it('reports the platform rows and totals', () => {
    const takeoff = data<Takeoff>(built, 'access_platform_takeoff', {});
    expect(takeoff.platforms).toHaveLength(1);
    expect(takeoff.platforms[0]).toMatchObject({ id: 'assembly-1', stale: false, staleReason: null });
    expect(takeoff.platforms[0]?.railingLengthM).toBeCloseTo(17.2, 6);
    expect(takeoff.totals.gratingAreaM2).toBeCloseTo(18, 4);
    expect(takeoff.totals.gratingMassKg).toBeCloseTo(782.165, 2);
    expect(data<Takeoff>(built, 'access_platform_takeoff', { ids: ['assembly-1'] }).totals.platforms).toBe(1);
  });

  it('refuses an id that is not a platform', () => {
    expectRefusal(built, 'access_platform_takeoff', { ids: ['member-1'] }, 'STA_UNKNOWN_ELEMENT', 'ids');
  });

  it('is empty without platforms', () => {
    expect(data<Takeoff>(base(), 'access_platform_takeoff', {}).platforms).toEqual([]);
  });

  it('is stale when the beams an existing-framing deck bears on are removed', () => {
    const framed = gratingFrame();
    const deck = apply(framed, 'add_access_platform', {
      bounds: [
        [0, 0],
        [3324, 3000],
      ],
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      framing: 'existing',
    });
    const beams = Object.values(deck.building?.elements ?? {})
      .filter((element) => element.category === 'member' && element.role === 'beam')
      .map((element) => element.id);
    const stripped = apply(deck, 'delete_building_element', { elementIds: [beams[0] as string] });
    const stale = data<Takeoff>(stripped, 'access_platform_takeoff', {}).platforms[0];
    expect(stale?.stale).toBe(true);
    expect(stale?.staleReason).toContain('support');
  });

  it('adds a platform schedule and platform takeoff lines', () => {
    const schedule = data<{ rows: Array<Array<string | number>> }>(built, 'building_schedule', { kind: 'platform' });
    expect(schedule.rows).toEqual([['AS1', 'platform', 7, 6, 18, 782.2, 17.2, 14, expect.any(Number), 'Grade']]);
    const lines = data<{ lines: Array<{ key: string; quantity: number }> }>(built, 'quantity_takeoff', {}).lines;
    expect(lines.find((line) => line.key === 'platform.platform.ea')?.quantity).toBe(1);
    expect(lines.find((line) => line.key === 'grating.19-W-4 1-1/4x3/16.m2')?.quantity).toBeCloseTo(18, 3);
  });
});

describe('platform assembly: persistence and IFC', () => {
  const built = apply(base(), 'add_access_platform', RAILED);

  it('validates a loaded assembly and names what is wrong', () => {
    expect(buildingErrors(built.building)).toEqual([]);
    const damage = (edit: (elements: Record<string, Record<string, unknown>>) => void): string => {
      const copy = JSON.parse(JSON.stringify(built.building)) as { elements: Record<string, Record<string, unknown>> };
      edit(copy.elements);
      return buildingErrors(copy).join(' | ');
    };
    const assembly = (elements: Record<string, Record<string, unknown>>): Record<string, unknown> =>
      elements['assembly-1'] as Record<string, unknown>;
    expect(damage((e) => (assembly(e)['kind'] = 'rack'))).toContain('kind must be platform or circular_platform');
    expect(damage((e) => (assembly(e)['params'] = { kind: 'platform' }))).toContain('params are not the resolved generator parameters');
    expect(damage((e) => (assembly(e)['partIds'] = 'x'))).toContain('partIds must be a list');
    expect(damage((e) => delete (e['grating-1'] as Record<string, unknown>)['assemblyId'])).toContain('does not point back');
    expect(damage((e) => (assembly(e)['partIds'] = ['ghost']))).toContain('part ghost is missing');
    expect(damage((e) => (assembly(e)['hostId'] = 4))).toContain('hostId must be the id of an equipment element');
    expect(damage((e) => (assembly(e)['generation'] = 0))).toContain('generation must be an integer >= 1');
    expect(damage((e) => (assembly(e)['generation'] = 1.5))).toContain('generation must be an integer >= 1');
    // back references: a part must be listed by the assembly it names, and only members, gratings and railings have an owner
    expect(damage((e) => (assembly(e)['partIds'] = (assembly(e)['partIds'] as string[]).filter((id) => id !== 'grating-1')))).toContain(
      'building element grating-1: assemblyId must name a platform assembly that lists it',
    );
    expect(damage((e) => ((e['grating-1'] as Record<string, unknown>)['assemblyId'] = 'ghost'))).toContain('assemblyId must name');
    expect(damage((e) => ((e['assembly-1'] as Record<string, unknown>)['assemblyId'] = 'assembly-1'))).toContain('assemblyId must name');
  });

  it('survives a save and load of the document', () => {
    const loaded = JSON.parse(JSON.stringify(built)) as CadDocument;
    expect(buildingErrors(loaded.building)).toEqual([]);
    expect(data<{ platforms: unknown[] }>(loaded, 'access_platform_takeoff', {}).platforms).toHaveLength(1);
  });

  it('exports an IfcElementAssembly ACCESSPLATFORM aggregating its parts, which are not contained twice', () => {
    const ifc = data<{ ifc: string }>(built, 'export_ifc', {}).ifc;
    expect(ifc.match(/IFCELEMENTASSEMBLY\(/g)).toHaveLength(1);
    expect(ifc).toContain('.ACCESSPLATFORM.');
    const lines = ifc.split('\n');
    const listOf = (line: string): string[] => /\(((?:#\d+,?)+)\)/.exec(line)?.[1]?.split(',') ?? [];
    const aggregates = lines.filter((line) => line.includes('IFCRELAGGREGATES')).map(listOf);
    expect(
      aggregates.some((refs) => refs.length === 14),
      'one IfcRelAggregates holds the 14 parts',
    ).toBe(true);
    const contained = lines.filter((line) => line.includes('IFCRELCONTAINEDINSPATIALSTRUCTURE'));
    // the storey contains the assembly only, not its parts
    expect(
      contained.map((line) => listOf(line).length),
      contained.join('\n'),
    ).toEqual([1]);
  });
});

describe('a platform is an arrival surface for ladders and steel stairs', () => {
  const built = apply(base(), 'add_access_platform', RAILED);

  it('a ladder attaches to the assembly, arrives on its nearest panel and uses the gated opening of its railing', () => {
    const result = ok(built, 'add_ladder', {
      base: [2400, -300, 0],
      facing: [0, 1],
      attachTo: 'assembly-1',
      exit: 'through',
      fallProtection: 'cage',
    });
    const got = result.data as { arrivalSurfaceId: string; gate: { status: string; railingId: string } };
    expect(got.arrivalSurfaceId).toBe('grating-3');
    expect(got.gate).toEqual({ status: 'existing', railingId: 'railing-1' });
  });

  it('a through ladder in front of a closed stretch of the platform railing leaves the railing alone and says how to open it', () => {
    const result = ok(built, 'add_ladder', {
      base: [500, -300, 0],
      facing: [0, 1],
      attachTo: 'assembly-1',
      exit: 'through',
      fallProtection: 'cage',
    });
    const got = result.data as { gate: { status: string; reason: string } };
    expect(got.gate.status).toBe('skipped');
    expect(got.gate.reason).toContain('update_access_platform');
    expect(result.document.building?.elements['railing-1']).toEqual(built.building?.elements['railing-1']);
    // the suggested opening is accepted by update_access_platform
    const opened = ok(result.document, 'update_access_platform', {
      assemblyId: 'assembly-1',
      railing: {
        openings: [
          { from: 380, to: 620, gate: true },
          { from: 2000, to: 2800, gate: true },
        ],
      },
    });
    expect(answer(opened).railingIds).toEqual(['railing-1']);
  });

  it('a steel stair rises to the assembly and arrives on the panel its top reaches', () => {
    const result = ok(built, 'add_steel_stair', {
      start: [-4500, 1500, 0],
      angle: 0,
      toSurfaceId: 'assembly-1',
      riserMax: 180,
      going: 280,
    });
    const got = result.data as { arrivalSurfaceId: string; riserCount: number };
    expect(got.riserCount).toBe(17);
    expect(got.arrivalSurfaceId).toBe('grating-1');
  });

  it('refuses a name that is no surface and a base too far from every panel', () => {
    expectRefusal(
      built,
      'add_ladder',
      { base: [-300, 1500, 0], facing: [1, 0], attachTo: 'member-1', fallProtection: 'cage' },
      'STA_UNKNOWN_ELEMENT',
      'attachTo',
    );
    expectRefusal(
      built,
      'add_ladder',
      { base: [-3000, 1500, 0], facing: [1, 0], attachTo: 'assembly-1', fallProtection: 'cage' },
      'STA_NO_ARRIVAL_SURFACE',
    );
    expectRefusal(
      built,
      'add_steel_stair',
      { start: [-4500, 1500, 0], toSurfaceId: 'member-1', riserMax: 180, going: 280 },
      'STA_UNKNOWN_ELEMENT',
      'toSurfaceId',
    );
  });
});
