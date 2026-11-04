/**
 * Plant 06 STA follow-up: `check_clashes` bodies of ladders (stiles, rungs, cage, landings), steel stairs (stringers, treads), gratings and railings.
 * Hand numbers: ladder LD1 at base [1500, -250] facing +y, clear width 406.4: stiles FL70x10 at x = 1500 +- 208.2 (10 thick in x, 70 deep in y);
 * IPE200 is 100 wide x 200 deep, so a beam along x at y = -250 meets a stile over 50 + 35 = 85 mm in y.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Vec2 } from '@core/model/types';
import { structuresClashBodies } from '@aec/plant/structures/clash/structuresClashBodies';
import { plateBoxes } from '@aec/plant/structures/clash/clashShapes';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document } from '../piping/rteFixtures';
import { gratedFrame, rect, TYPE } from './accessFixtures';

interface Clash {
  a: string;
  b: string;
  kind: string;
  depth: number;
}
const clashes = (doc: CadDocument, tolerance?: number): Clash[] =>
  data<{ clashes: Clash[] }>(doc, 'check_clashes', tolerance === undefined ? {} : { tolerance }).clashes;
const between = (found: Clash[], a: string, b: string): Clash[] =>
  found.filter((clash) => [clash.a, clash.b].sort().join() === [a, b].sort().join());

/** Grade 0 and a platform level at 3000 with a 3000 x 2000 deck slab; returns the grade level id. */
function twoLevels(): { doc: CadDocument; grade: string } {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  const grade = Object.keys(doc.building?.levels ?? {})[0] as string;
  doc = apply(doc, 'add_level', { name: 'Platform', elevation: 3000, height: 3000 });
  const top = Object.keys(doc.building?.levels ?? {}).find((id) => id !== grade) as string;
  return { doc: ok(doc, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 30, levelId: top }).document, grade };
}
const beam = (doc: CadDocument, level: string, start: number[], end: number[]): CadDocument =>
  apply(doc, 'add_steel_member', { profile: 'IPE200', role: 'beam', start, end, levelId: level });

describe('check_clashes: fixed ladders', () => {
  const scene = (): { doc: CadDocument; grade: string } => {
    const { doc, grade } = twoLevels();
    return { doc: apply(doc, 'add_ladder', { base: [1500, -250, 0], facing: [0, 1], attachTo: 'slab-1', levelId: grade }), grade };
  };

  it('a ladder on its own slab clashes with nothing', () => {
    expect(clashes(scene().doc)).toEqual([]);
  });

  it('a beam through the stiles is one hard clash named after the ladder, 85 mm deep', () => {
    const { doc, grade } = scene();
    const through = beam(doc, grade, [1000, -250, 1000], [2000, -250, 1000]);
    expect(clashes(through)).toEqual([{ a: 'ladder-1', b: 'member-1', kind: 'hard', depth: 85 }]);
    expect(execute(through, 'check_clashes', {}).summary).toContain('hard LD1 × SB1 (85 mm)');
  });

  it('a beam ending 36.8 mm short of the left stile is a near miss; ending 3.2 mm into it (stile edge at 1286.8) is under the 5 mm tolerance but reported at 0', () => {
    const { doc, grade } = scene();
    expect(clashes(beam(doc, grade, [1000, -250, 1000], [1250, -250, 1000]), 0)).toEqual([]);
    const into = beam(doc, grade, [1000, -250, 1000], [1290, -250, 1000]);
    expect(clashes(into)).toEqual([]);
    const exact = clashes(into, 0);
    expect(exact).toHaveLength(1);
    expect(exact[0]?.depth).toBeCloseTo(3.2, 6);
  });

  it('the cage is a body: a beam behind the stiles through the cage clashes, one 1500 mm behind does not', () => {
    const { doc, grade } = scene();
    expect(between(clashes(beam(doc, grade, [1000, -600, 2700], [2000, -600, 2700])), 'ladder-1', 'member-1')).toHaveLength(1);
    expect(clashes(beam(doc, grade, [1000, -1750, 2700], [2000, -1750, 2700]))).toEqual([]);
  });

  it('is pure and read-only', () => {
    const { doc } = scene();
    const before = JSON.stringify(doc);
    structuresClashBodies(doc);
    clashes(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('check_clashes: steel stairs', () => {
  const scene = (): { doc: CadDocument; grade: string } => {
    const { doc, grade } = twoLevels();
    return {
      doc: apply(doc, 'add_steel_stair', {
        start: [0, 0, 0],
        angle: 0,
        rise: 3000,
        riserMax: 180,
        going: 280,
        tread: { kind: 'checker_plate', thickness: 6 },
        levelId: grade,
      }),
      grade,
    };
  };
  // riser h = 3000 / 17; tread 3 spans x 560..840 with its top at 3h = 529.41
  const TOP3 = (3 * 3000) / 17;
  const crossing = (grade: string, doc: CadDocument, beamTop: number): CadDocument =>
    beam(doc, grade, [700, -300, beamTop - 100], [700, 300, beamTop - 100]);

  it('a stair with its railings and its own landing clashes with nothing', () => {
    expect(clashes(scene().doc)).toEqual([]);
  });

  it('a beam 20 mm into a 6 mm checker-plate tread is a 20 mm hard clash with the stair; 20 mm under the tread is a near miss', () => {
    const { doc, grade } = scene();
    const hit = between(clashes(crossing(grade, doc, TOP3 + 14)), 'member-1', 'steelStair-1');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.depth).toBeCloseTo(20, 6);
    expect(clashes(crossing(grade, doc, TOP3 - 26))).toEqual([]);
  });
});

describe('check_clashes: grating panels', () => {
  const column = (doc: CadDocument, x: number, y: number): CadDocument =>
    apply(doc, 'add_steel_member', { profile: 'HEB100', role: 'column', start: [x, y, -500], end: [x, y, 500] });

  it('the SC-STA-06 grating on its beams clashes with nothing', () => {
    expect(clashes(gratedFrame().doc)).toEqual([]);
  });

  it('a column through the first panel is a 350 mm hard clash with the panel; the same column 150 mm outside the deck is not', () => {
    const { doc, ids } = gratedFrame();
    const through = between(clashes(column(doc, 300, 1500)), ids[0] as string, 'member-19');
    expect(through).toHaveLength(1);
    expect(through[0]?.depth).toBeCloseTo(350, 6);
    expect(clashes(column(doc, 300, 3200))).toEqual([]);
  });

  it('plateBoxes follows a triangle: the strips cover its inside and leave the notch of its bounding box free', () => {
    const triangle: Vec2[] = [
      [0, 0],
      [800, 0],
      [0, 800],
    ];
    const boxes = plateBoxes(triangle, 0, 0, 30);
    expect(boxes.length).toBe(8);
    const covers = (x: number, y: number): boolean =>
      boxes.some((box) => Math.abs(x - box.center[0]) <= box.half[0] && Math.abs(y - box.center[1]) <= box.half[1]);
    expect(covers(100, 100)).toBe(true);
    expect(covers(790, 5)).toBe(true);
    expect(covers(700, 700)).toBe(false);
    expect(
      plateBoxes(
        [
          [0, 0],
          [800, 0],
          [800, 400],
          [0, 400],
        ],
        0,
        0,
        30,
      ),
    ).toHaveLength(1);
    expect(plateBoxes(triangle, 0, 30, 0)).toEqual([]);
    expect(
      plateBoxes(
        [
          [0, 0],
          [1, 1],
        ],
        0,
        0,
        30,
      ),
    ).toEqual([]);
  });
});

describe('check_clashes: railings and insulation', () => {
  /** SC-RTE-07 hot line: DN80, insulation 50 mm, bare pipe bottom 2955.55 and insulation bottom 2905.55 at x = 3000. */
  function hotLine(): CadDocument {
    const a = addTie(cs150Document(), 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
    const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
    const created = ok(b.doc, 'create_pipeline', {
      service: 'HO',
      sequence: '4001',
      spec: 'CS150',
      dn: 80,
      designTempC: 180,
      insulation: { code: 'H', thickness: 'fromSpec' },
    });
    const lineId = created.affected[0] as string;
    const routed = apply(created.document, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
    return apply(routed, 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  }
  const railingAt = (doc: CadDocument, z: number): CadDocument =>
    apply(doc, 'add_railing', {
      path: [
        [3000, -1000, z],
        [3000, 1000, z],
      ],
      height: 1100,
      levelId: 'level-1',
    });

  it('a top rail 14.45 mm into the insulation that clears the bare pipe is one insulation clash with the railing', () => {
    const found = clashes(railingAt(hotLine(), 1820));
    expect(found.map((clash) => clash.kind)).toEqual(['insulation']);
    expect(found[0]?.a).toBe('railing-1');
    expect(found[0]?.b).toMatch(/^run-\d+(\.\d+)?\/pipe-1$/);
    expect(found[0]?.depth).toBeCloseTo(14.45, 6);
  });

  it('a rail into the bare pipe is one hard clash (44.45 mm) and the insulation clash of the same pair disappears', () => {
    const found = clashes(railingAt(hotLine(), 1900));
    expect(found.map((clash) => clash.kind)).toEqual(['hard']);
    expect(found[0]?.depth).toBeCloseTo(44.45, 6);
  });

  it('a railing 100 mm below the insulation is a near miss', () => {
    expect(clashes(railingAt(hotLine(), 1700))).toEqual([]);
  });
});

describe('check_clashes: access elements that belong together', () => {
  it('a platform with a ladder and a stair that reach it reports nothing: decking, rails, toe plates and its own members are one assembly (the stair edge has no guard-rail)', () => {
    let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
    doc = apply(doc, 'add_access_platform', {
      bounds: [
        [0, 0],
        [6000, 3000],
      ],
      topOffset: 3000,
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      railing: { edges: [0, 1, 2] },
      levelId: 'level-1',
    });
    doc = apply(doc, 'add_ladder', {
      base: [3000, -250, 0],
      facing: [0, 1],
      attachTo: 'assembly-1',
      exit: 'side_step',
      levelId: 'level-1',
    });
    doc = apply(doc, 'add_steel_stair', {
      start: [-4480, 1500, 0],
      angle: 0,
      toSurfaceId: 'assembly-1',
      railings: 'both',
      riserMax: 180,
      going: 280,
      levelId: 'level-1',
    });
    const kinds = new Set(structuresClashBodies(doc).map((body) => body.id.split('-')[0]));
    expect([...kinds].sort()).toEqual(['grating', 'ladder', 'railing', 'steelStair']);
    expect(clashes(doc)).toEqual([]);
  });

  it('a document without access elements, or with one on a missing level, has no bodies', () => {
    expect(structuresClashBodies(createEmptyDocument())).toEqual([]);
    const { doc } = twoLevels();
    const withLadder = apply(doc, 'add_ladder', { base: [1500, -250, 0], facing: [0, 1], attachTo: 'slab-1', levelId: 'level-1' });
    const building = withLadder.building;
    if (building === undefined) throw new Error('no building');
    const broken = { ...withLadder, building: { ...building, levels: {} } };
    expect(structuresClashBodies(broken)).toEqual([]);
  });
});
