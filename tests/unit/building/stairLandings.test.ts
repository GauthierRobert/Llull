import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { buildPlanDrawing } from '@aec/building/drawings/planDrawing';
import { stairVolume } from '@aec/building/quantities/takeoffBasics';
import { buildingErrors } from '@aec/building/validate';
import { pointInPolygon } from '@lib/polygon';
import { xy } from '../../helpers/xy';

const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument => execute(doc, name, params).document;
const rect = (x0: number, y0: number, x1: number, y1: number): number[][] => xy(x0, y0, x1, y0, x1, y1, x0, y1);

/** 16 risers of 200 over a 3200 level, tread 250, width 1000, waist 200: flights of 8 + 8 risers (7 treads each). */
const PLAIN = { start: [0, 0], width: 1000, riserCount: 16, treadDepth: 250, waistThickness: 200 };
const BASE = { ...PLAIN, landingAt: 8 };

function level(height = 3200): CadDocument {
  return run(createEmptyDocument(), 'add_level', { name: 'L0', height });
}

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

function boundsOf(entity: Entity | undefined): Bounds {
  const points: number[][] = [];
  if (entity?.kind === 'mesh') {
    for (let i = 0; i < entity.mesh.positions.length; i += 3) points.push(entity.mesh.positions.slice(i, i + 3));
  } else if (entity?.kind === 'extrusion') {
    for (const [x, y] of entity.profile) {
      points.push([x, y, entity.position[2]], [x, y, entity.position[2] + entity.depth]);
    }
  } else throw new Error('not a mesh or extrusion');
  const axis = (k: number): number[] => points.map((point) => Math.round((point[k] as number) * 1e6) / 1e6 + 0);
  return {
    min: [Math.min(...axis(0)), Math.min(...axis(1)), Math.min(...axis(2))],
    max: [Math.max(...axis(0)), Math.max(...axis(1)), Math.max(...axis(2))],
  };
}

function meshVolume(entity: Entity | undefined): number {
  if (entity?.kind === 'extrusion') {
    let twice = 0;
    entity.profile.forEach(([x, y], i) => {
      const [nx, ny] = entity.profile[(i + 1) % entity.profile.length] as [number, number];
      twice += x * ny - nx * y;
    });
    return (Math.abs(twice) / 2) * entity.depth;
  }
  if (entity?.kind !== 'mesh') throw new Error('not a mesh or extrusion');
  const { positions, indices } = entity.mesh;
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => positions.slice((indices[i + k] as number) * 3, (indices[i + k] as number) * 3 + 3)) as [
      number[],
      number[],
      number[],
    ];
    volume +=
      (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return volume;
}

/** Stair volume in mm³: exact from the element, plus the takeoff line (m³, rounded to a litre) checked against it. */
function takeoffVolume(doc: CadDocument): number {
  const element = doc.building?.elements['stair-1'];
  if (element?.category !== 'stair') throw new Error('no stair');
  const exact = stairVolume(element);
  const line = (execute(doc, 'quantity_takeoff', {}).data as { lines: Array<{ key: string; quantity: number }> }).lines.find(
    (candidate) => candidate.key === 'stair.concrete.m3',
  );
  expect(line?.quantity).toBeCloseTo(exact / 1e9, 3);
  return exact;
}

/** Hand calculation of a waist-slab flight profile (area in mm²): rise R, going G, `treads` steps, waist w, floor level, foot under a landing. */
function flightArea(treads: number, floor: number, foot: number | null): number {
  const [rise, going, waist] = [200, 250, 200];
  const vertical = (waist * Math.hypot(rise, going)) / going;
  const length = treads * going;
  const top = going * rise * ((treads * (treads + 1)) / 2) - floor * length;
  const clip = ((floor + vertical) * going) / rise;
  const soffitEnd = (length * rise) / going - vertical;
  const under = 0.5 * (length - clip) * (soffitEnd - floor);
  const wedge = foot === null ? 0 : (0.5 * (foot - soffitEnd) ** 2 * going) / rise;
  return top - under + wedge;
}

const FLIGHT_1 = flightArea(7, 0, 1400);
const FLIGHT_2 = flightArea(7, -200, null);

describe('add_stair landings: geometry', () => {
  it('straight landing: two flights + one landing slab, volume by hand', () => {
    const result = execute(level(), 'add_stair', BASE);
    expect(result.affected[0]).toBe('stair-1');
    expect(Object.keys(result.document.entities).filter((id) => id.startsWith('stair-1'))).toEqual([
      'stair-1:flight-1',
      'stair-1:flight-2',
      'stair-1:landing',
    ]);
    const [f1, f2, landing] = ['flight-1', 'flight-2', 'landing'].map((part) => result.document.entities[`stair-1:${part}`]);
    // flight 1: 7 treads x 250 = 1750, last tread at 1400, landing top 8 x 200 = 1600 (slab 1400-1600); flight 2 after it, ending 7 treads higher
    expect(boundsOf(f1)).toMatchObject({ min: [0, -500, 0], max: [expect.closeTo(1750 + 320.156, 2), 500, 1400] });
    expect(boundsOf(landing)).toMatchObject({ min: [1750, -500, 1400], max: [2750, 500, 1600] });
    expect(boundsOf(f2)).toMatchObject({ min: [2750, -500, 1400], max: [4500, 500, 3000] });
    const expected = (FLIGHT_1 + FLIGHT_2) * 1000 + 1000 * 1000 * 200;
    expect(takeoffVolume(result.document)).toBeCloseTo(expected, -3);
    const meshes = meshVolume(f1) + meshVolume(f2) + meshVolume(landing);
    expect(meshes).toBeCloseTo(expected, -3);
  });

  it('quarter turn: the second flight leaves sideways from the far end of the landing (left and right)', () => {
    const left = run(level(), 'add_stair', { ...BASE, shape: 'quarter_turn' });
    expect(boundsOf(left.entities['stair-1:flight-2'])).toMatchObject({ min: [1750, 500, 1400], max: [2750, 2250, 3000] });
    expect(boundsOf(left.entities['stair-1:landing'])).toMatchObject({ min: [1750, -500, 1400], max: [2750, 500, 1600] });
    const right = run(level(), 'add_stair', { ...BASE, shape: 'quarter_turn', turn: 'right' });
    expect(boundsOf(right.entities['stair-1:flight-2'])).toMatchObject({ min: [1750, -2250, 1400], max: [2750, -500, 3000] });
    expect(takeoffVolume(left)).toBeCloseTo((FLIGHT_1 + FLIGHT_2) * 1000 + 2e8, -3);
    expect(meshVolume(left.entities['stair-1:flight-2'])).toBeCloseTo(FLIGHT_2 * 1000, -3);
  });

  it('half turn (dog-leg): the second flight doubles back beside the first and the landing spans both', () => {
    const doc = run(level(), 'add_stair', { ...BASE, shape: 'half_turn', flightGap: 100 });
    expect(boundsOf(doc.entities['stair-1:flight-2'])).toMatchObject({ min: [0, 600, 1400], max: [1750, 1600, 3000] });
    expect(boundsOf(doc.entities['stair-1:landing'])).toMatchObject({ min: [1750, -500, 1400], max: [2750, 1600, 1600] });
    expect(takeoffVolume(doc)).toBeCloseTo((FLIGHT_1 + FLIGHT_2) * 1000 + 2100 * 1000 * 200, -3);
    const right = run(level(), 'add_stair', { ...BASE, shape: 'half_turn', turn: 'right', flightGap: 100 });
    expect(boundsOf(right.entities['stair-1:flight-2'])).toMatchObject({ min: [0, -1600, 1400], max: [1750, -600, 3000] });
  });

  it('rotates the whole layout with the stair angle and moves it with the start point', () => {
    const doc = run(level(), 'add_stair', { ...BASE, start: [1000, 2000], angle: Math.PI / 2, shape: 'quarter_turn' });
    // plan frame (along, across) -> world (x, y) = start + (-across, along)
    const bounds = boundsOf(doc.entities['stair-1:flight-2']);
    expect(bounds.min[0]).toBeCloseTo(1000 - 2250, 6);
    expect(bounds.max[0]).toBeCloseTo(1000 - 500, 6);
    expect(bounds.min[1]).toBeCloseTo(2000 + 1750, 6);
    expect(bounds.max[1]).toBeCloseTo(2000 + 2750, 6);
  });

  it('puts the landing at half the risers for a turned stair without landingAt, and honours landingLength', () => {
    const result = execute(level(), 'add_stair', { ...PLAIN, shape: 'half_turn', landingLength: 1400 });
    expect(result.summary).toContain('half_turn left landing after riser 8');
    expect(boundsOf(result.document.entities['stair-1:landing']).max[0]).toBe(1750 + 1400);
  });

  it('keeps a stair without a landing as the single flight entity', () => {
    const result = execute(level(), 'add_stair', PLAIN);
    expect(Object.keys(result.document.entities).filter((id) => id.startsWith('stair-1'))).toEqual(['stair-1:flight']);
    expect(result.summary).not.toContain('Landing:');
  });

  it('ignores turn / flightGap that do not apply to the chosen shape, but refuses them without a landing', () => {
    const straight = execute(level(), 'add_stair', { ...BASE, turn: 'right', flightGap: 300 });
    expect(straight.document.building?.elements['stair-1']).not.toHaveProperty('turn');
    expect(straight.document.building?.elements['stair-1']).not.toHaveProperty('flightGap');
    const refused = execute(level(), 'add_stair', { ...PLAIN, landingLength: 900, turn: 'left' });
    expect(refused.affected).toEqual([]);
    expect(refused.summary).toMatch(/landingLength, turn need a landing/);
  });
});

describe('add_stair landings: checks and failures', () => {
  it('warns when the landing is shorter than the width, reports headroom and the Blondel rule', () => {
    const short = execute(level(), 'add_stair', { ...BASE, landingLength: 800 });
    expect(short.summary).toContain('WARNING: landing length 800 is shorter than the stair width 1000');
    expect(short.summary).toContain('1600 mm below the floor above');
    expect(short.summary).toContain('under the 2000 mm headroom');
    expect(short.summary.match(/WARNING/g)).toHaveLength(1);
    expect(short.summary).toContain('2R+G = 650 mm');
    const fine = execute(level(), 'add_stair', { ...BASE, landingAt: 4 });
    expect(fine.summary).not.toContain('WARNING');
    expect(fine.summary).toContain('2400 mm below the floor above');
    const uncomfortable = execute(level(), 'add_stair', { ...BASE, treadDepth: 400 });
    expect(uncomfortable.summary).toContain('outside the 600–650 mm comfort range');
  });

  it.each([
    ['landingAt too low', { landingAt: 1 }, /landingAt must be an integer from 2 to 14/],
    ['landingAt too high', { landingAt: 15 }, /landingAt must be an integer from 2 to 14/],
    ['fractional landingAt', { landingAt: 7.5 }, /landingAt must be an integer/],
    ['too few risers', { riserCount: 3, landingAt: 2 }, /at least 4 risers/],
    ['zero landing length', { landingLength: 0 }, /landingLength must be > 0/],
    ['negative gap', { shape: 'half_turn', flightGap: -1 }, /flightGap must be >= 0/],
  ])('refuses %s with the document unchanged', (_label, extra, reason) => {
    const doc = level();
    const result = execute(doc, 'add_stair', { ...BASE, ...extra });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(reason);
  });

  it('is pure: the input document is not mutated', () => {
    const doc = level();
    const before = structuredClone(doc);
    execute(doc, 'add_stair', { ...BASE, shape: 'half_turn' });
    expect(doc).toEqual(before);
  });

  it('describes landings, shapes and the headroom/well behaviour to the agent', () => {
    const description = getCommand('add_stair')?.description ?? '';
    for (const word of ['landingAt', 'quarter_turn', 'half_turn', 'flightGap', 'Blondel', 'add_slab_opening'])
      expect(description).toContain(word);
    expect(description).not.toMatch(/NOT modelled/);
  });

  it('validates the landing fields of a loaded building', () => {
    const doc = run(level(), 'add_stair', { ...BASE, shape: 'half_turn' });
    const valid = JSON.parse(JSON.stringify(doc.building)) as { elements: Record<string, Record<string, unknown>> };
    expect(buildingErrors(valid)).toEqual([]);
    const broken = (edit: Record<string, unknown>): string[] => {
      const copy = JSON.parse(JSON.stringify(valid)) as typeof valid;
      Object.assign(copy.elements['stair-1'] as object, edit);
      return buildingErrors(copy);
    };
    expect(broken({ landingAt: 1 }).join()).toMatch(/landingAt must be an integer from 2/);
    expect(broken({ landingAt: 15 }).join()).toMatch(/landingAt/);
    expect(broken({ landingLength: -3 }).join()).toMatch(/landingLength/);
    expect(broken({ shape: 'spiral' }).join()).toMatch(/shape must be/);
    expect(broken({ turn: 'up' }).join()).toMatch(/turn must be/);
    expect(broken({ flightGap: -1 }).join()).toMatch(/flightGap/);
    const noLanding = JSON.parse(JSON.stringify(valid)) as typeof valid;
    delete (noLanding.elements['stair-1'] as Record<string, unknown>)['landingAt'];
    expect(buildingErrors(noLanding).join()).toMatch(/needs landingAt/);
  });
});

describe('add_stair landings: well, clashes, exports, plan', () => {
  function storeys(extra: Record<string, unknown>): CadDocument {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'L0', height: 3200 });
    doc = run(doc, 'add_level', { name: 'L1', makeActive: false });
    doc = run(doc, 'add_slab', { boundary: rect(-3000, -3000, 9000, 6000), levelId: 'level-1' });
    doc = run(doc, 'add_stair', { ...BASE, levelId: 'level-1', ...extra });
    return run(doc, 'add_slab', { boundary: rect(-3000, -3000, 9000, 6000), levelId: 'level-2' });
  }
  const clashes = (doc: CadDocument): Array<{ a: string; b: string }> =>
    (execute(doc, 'check_clashes', {}).data as { clashes: Array<{ a: string; b: string }> }).clashes;

  it.each([
    ['straight', {}, [-100, 4600, -600, 600]],
    ['quarter_turn', { shape: 'quarter_turn' }, [-100, 2850, -600, 2350]],
    ['half_turn', { shape: 'half_turn', flightGap: 100 }, [-100, 2850, -600, 1700]],
  ])('add_slab_opening { stairId } on a %s stair covers every flight and the landing', (_label, extra, [a0, a1, c0, c1]) => {
    const doc = storeys(extra);
    expect(clashes(doc).some((clash) => clash.a === 'slab-2' && clash.b === 'stair-1')).toBe(true);
    const cut = execute(doc, 'add_slab_opening', { stairId: 'stair-1' });
    expect(cut.affected).toContain('slab-2');
    const slab = cut.document.building?.elements['slab-2'];
    const opening = (slab?.category === 'slab' ? slab.openings?.[0] : undefined) ?? [];
    const xs = opening.map((point) => point[0]);
    const ys = opening.map((point) => point[1]);
    [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].forEach((value, index) =>
      expect(value).toBeCloseTo([a0, a1, c0, c1][index] as number, 6),
    );
    expect(clashes(cut.document).some((clash) => clash.b === 'stair-1')).toBe(false);
  });

  it.each([
    ['left', {}, [500, 1500]],
    ['right', { turn: 'right' }, [500, -1500]],
  ])('the well of a %s L stair leaves the empty corner beside the first flight as slab (ENG-9)', (_label, turn, corner) => {
    const cut = execute(storeys({ shape: 'quarter_turn', ...turn }), 'add_slab_opening', { stairId: 'stair-1' });
    const slab = cut.document.building?.elements['slab-2'];
    const opening = (slab?.category === 'slab' ? slab.openings?.[0] : undefined) ?? [];
    expect(opening).toHaveLength(6);
    expect(pointInPolygon(corner as [number, number], opening)).toBe(false);
    expect(pointInPolygon([2250, 0], opening)).toBe(true);
    // 2950 x 2950 bounding square minus the 1750 x 1750 corner
    expect(cut.summary).toContain('(5.64 m²)');
  });

  it('clashes: a column on the landing hits the stair, one beside it does not', () => {
    const doc = storeys({});
    const onLanding = run(doc, 'add_column', { location: [2250, 0], width: 300, depth: 300, levelId: 'level-1', height: 1500 });
    expect(clashes(onLanding).some((clash) => [clash.a, clash.b].includes('stair-1') && [clash.a, clash.b].includes('column-1'))).toBe(
      true,
    );
    const beside = run(doc, 'add_column', { location: [2250, 2000], width: 300, depth: 300, levelId: 'level-1', height: 1500 });
    expect(clashes(beside).some((clash) => [clash.a, clash.b].includes('column-1'))).toBe(false);
  });

  it('IFC: a stair with a landing aggregates two flights and a LANDING slab; a plain stair stays one IFCSTAIR', () => {
    const exported = (doc: CadDocument): string => (execute(doc, 'export_ifc', {}).data as { ifc: string }).ifc;
    const half = exported(run(level(), 'add_stair', { ...BASE, shape: 'half_turn' }));
    expect(half.match(/IFCSTAIRFLIGHT\(/g)).toHaveLength(2);
    expect(half).toContain('.LANDING.');
    expect(half).toContain('.HALF_TURN_STAIR.');
    expect(half).toMatch(/IFCRELAGGREGATES\('[^']+',\$,\$,\$,#\d+,\(#\d+,#\d+,#\d+\)\)/);
    const defined = new Set([...half.matchAll(/^#(\d+)=/gm)].map((match) => match[1]));
    expect([...half.matchAll(/#(\d+)(?!=)/g)].every((match) => defined.has(match[1]))).toBe(true);
    expect(exported(run(level(), 'add_stair', { ...BASE, shape: 'quarter_turn' }))).toContain('.QUARTER_TURN_STAIR.');
    expect(exported(run(level(), 'add_stair', BASE))).toContain('.STRAIGHT_RUN_STAIR.');
    const single = exported(run(level(), 'add_stair', PLAIN));
    expect(single).toContain('IFCSTAIR(');
    expect(single).not.toContain('IFCSTAIRFLIGHT');
  });

  it('plan: each flight gets an outline and a cut line, the landing an outline, and one arrow runs through the turn', () => {
    const count = (doc: CadDocument, type: string): number =>
      buildPlanDrawing(doc, undefined)?.primitives.filter((primitive) => primitive.layer === 'A-FLOR-STRS' && primitive.type === type)
        .length ?? 0;
    const half = run(level(), 'add_stair', { ...BASE, shape: 'half_turn' });
    expect(count(half, 'polygon')).toBe(3);
    // 2 cut lines + shaft + arrow head
    expect(count(half, 'polyline')).toBe(4);
    const single = run(level(), 'add_stair', PLAIN);
    expect(count(single, 'polygon')).toBe(1);
    expect(count(single, 'polyline')).toBe(1);
    expect(count(run(level(), 'add_stair', BASE), 'polygon')).toBe(3);
    expect(count(run(level(), 'add_stair', { ...BASE, shape: 'quarter_turn' }), 'polygon')).toBe(3);
  });
});
