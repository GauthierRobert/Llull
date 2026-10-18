import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { xy } from '../../helpers/xy';

const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument => execute(doc, name, params).document;
const rect = (x0: number, y0: number, x1: number, y1: number): number[][] => xy(x0, y0, x1, y0, x1, y1, x0, y1);

interface ClashRow {
  a: string;
  b: string;
  kind: string;
  depth: number;
}
const clashes = (doc: CadDocument): ClashRow[] => (execute(doc, 'check_clashes', {}).data as { clashes: ClashRow[] }).clashes;

/** Two storeys (3 m each), a floor slab at level-2 and a stair climbing level-1 -> level-2. */
function stairUnderSlab(): CadDocument {
  let doc = run(createEmptyDocument(), 'add_level', { name: 'L0' });
  doc = run(doc, 'add_level', { name: 'L1', makeActive: false });
  doc = run(doc, 'add_slab', { boundary: rect(0, 0, 10000, 8000), levelId: 'level-1' });
  doc = run(doc, 'add_stair', { start: [1000, 1000], levelId: 'level-1' });
  return run(doc, 'add_slab', { boundary: rect(0, 0, 10000, 8000), levelId: 'level-2' });
}

describe('check_clashes: stairs through slabs', () => {
  it('reports a stair running into a slab with no well, and clears once the well is cut', () => {
    const doc = stairUnderSlab();
    const found = clashes(doc);
    expect(found).toEqual([expect.objectContaining({ a: 'slab-2', b: 'stair-1', kind: 'hard' })]);
    expect(execute(doc, 'check_clashes', {}).summary).toContain('1 hard clash');
    expect(clashes(run(doc, 'add_slab_opening', { stairId: 'stair-1' }))).toEqual([]);
  });

  it('does not flag the slab the stair stands on, nor a stair with no slab above', () => {
    const doc = stairUnderSlab();
    const noRoof = run(doc, 'delete_building_element', { elementIds: ['slab-2'] });
    expect(clashes(noRoof)).toEqual([]);
  });

  it('respects the level filter', () => {
    const doc = stairUnderSlab();
    expect(execute(doc, 'check_clashes', { levelId: 'level-2' }).summary).toContain('1 hard clash');
  });

  it('copy_level_elements warns when a copied stair has no well in the slab above', () => {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'L0' });
    doc = run(doc, 'add_level', { name: 'L1', makeActive: false });
    doc = run(doc, 'add_level', { name: 'L2', makeActive: false });
    doc = run(doc, 'add_stair', { start: [1000, 1000], levelId: 'level-1' });
    doc = run(doc, 'add_slab', { boundary: rect(0, 0, 10000, 8000), levelId: 'level-3' });
    const copied = execute(doc, 'copy_level_elements', { sourceLevelId: 'level-1', targetLevelIds: ['level-2'], categories: ['stair'] });
    expect(copied.affected.length).toBeGreaterThan(0);
    expect(copied.summary).toContain('WARNING');
    expect(copied.summary).toContain('add_slab_opening');
    const welled = run(doc, 'add_slab_opening', { stairId: 'stair-1', slabId: 'slab-1' });
    expect(welled).not.toBe(doc);
  });
});

describe('stair geometry: waist slab', () => {
  it('N risers give one flight prism and far less concrete than solid blocks to the floor', () => {
    const doc = run(createEmptyDocument(), 'add_level', { name: 'L0', height: 3500 });
    const added = execute(doc, 'add_stair', { start: [0, 0], width: 1200, riserCount: 20, treadDepth: 280 });
    const flights = Object.keys(added.document.entities).filter((id) => id.startsWith('stair-'));
    expect(flights).toEqual(['stair-1:flight']);
    const takeoff = execute(added.document, 'quantity_takeoff', {}).data as { lines: Array<{ key: string; quantity: number }> };
    const volume = takeoff.lines.find((line) => line.key.startsWith('stair') && line.key.endsWith('m3'))?.quantity ?? 0;
    expect(volume).toBeGreaterThan(1.5);
    expect(volume).toBeLessThan(3);
    const thick = run(added.document, 'delete_building_element', { elementIds: ['stair-1'] });
    const heavier = execute(thick, 'add_stair', { start: [0, 0], width: 1200, riserCount: 20, treadDepth: 280, waistThickness: 300 });
    const heavyVolume = (
      execute(heavier.document, 'quantity_takeoff', {}).data as { lines: Array<{ key: string; quantity: number }> }
    ).lines.find((line) => line.key.startsWith('stair') && line.key.endsWith('m3'))?.quantity;
    expect(heavyVolume).toBeGreaterThan(volume);
    expect(execute(thick, 'add_stair', { start: [0, 0], waistThickness: 0 }).affected).toEqual([]);
  });
});

describe('stair flight prism', () => {
  it('is one watertight mesh whose volume equals the takeoff volume and whose underside slopes at the waist thickness', () => {
    const doc = run(createEmptyDocument(), 'add_level', { name: 'L0', height: 3500 });
    const added = run(doc, 'add_stair', {
      start: [0, 0],
      angle: Math.PI / 2,
      width: 1200,
      riserCount: 20,
      treadDepth: 280,
      waistThickness: 175,
    });
    const flight = added.entities['stair-1:flight'];
    if (flight?.kind !== 'mesh') throw new Error('flight is not a mesh');
    const { positions, indices } = flight.mesh;
    let volume = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) =>
        positions.slice((indices[i + k] as number) * 3, (indices[i + k] as number) * 3 + 3),
      ) as number[][];
      volume +=
        (a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) -
          a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) +
          a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)) /
        6;
    }
    const takeoff = (execute(added, 'quantity_takeoff', {}).data as { lines: Array<{ key: string; quantity: number }> }).lines;
    const stairVolume = takeoff.find((line) => line.key === 'stair.concrete.m3')?.quantity ?? 0;
    expect(volume / 1e9).toBeCloseTo(stairVolume, 2);
    // hand calc: rise 3500/20 = 175, going 280, 19 treads; waist line z = x*0.625 - V, V = 175*hypot(175,280)/280
    const vertical = (175 * Math.hypot(175, 280)) / 280;
    const length = 19 * 280;
    const top = 280 * 175 * ((19 * 20) / 2);
    const clip = (vertical * 280) / 175;
    const under = 0.5 * (length - clip) * ((length * 175) / 280 - vertical);
    expect(stairVolume).toBeCloseTo(((top - under) * 1200) / 1e9, 3);
    const xs = Array.from({ length: positions.length / 3 }, (_, k) => positions[k * 3 + 1] as number);
    expect(Math.max(...xs)).toBeCloseTo(19 * 280, 3);
  });
});

describe('door / window openings overlapping columns', () => {
  function wallWithColumn(): CadDocument {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'L0' });
    doc = run(doc, 'draw_walls', {
      points: [
        [0, 0],
        [10000, 0],
      ],
    });
    return run(doc, 'add_column', { location: [5000, 0], width: 400, depth: 400 });
  }

  it('add_door / add_window warn and check_clashes reports the overlap', () => {
    const doc = wallWithColumn();
    const door = execute(doc, 'add_door', { wallId: 'wall-1', offset: 5000, width: 1800 });
    expect(door.summary).toContain('WARNING');
    expect(door.summary).toContain('column');
    expect(clashes(door.document)).toEqual([expect.objectContaining({ a: 'column-1', b: 'door-1', kind: 'hard' })]);
    const window = execute(doc, 'add_window', { wallId: 'wall-1', offset: 5100, width: 1200 });
    expect(window.summary).toContain('WARNING');
    expect(clashes(window.document)).toEqual([expect.objectContaining({ a: 'column-1', b: 'window-1' })]);
  });

  it('is quiet when the opening clears the column, and update_opening warns when it slides onto it', () => {
    const doc = wallWithColumn();
    const clear = execute(doc, 'add_door', { wallId: 'wall-1', offset: 2000, width: 900 });
    expect(clear.summary).not.toContain('WARNING');
    expect(clashes(clear.document)).toEqual([]);
    const slid = execute(clear.document, 'update_opening', { openingId: 'door-1', offset: 5000 });
    expect(slid.summary).toContain('WARNING');
    const above = execute(doc, 'add_window', { wallId: 'wall-1', offset: 6000, width: 1200 });
    expect(above.summary).not.toContain('WARNING');
  });
});

describe('add_stair landings', () => {
  it('states that landings are not modelled', () => {
    const description = getCommand('add_stair')?.description ?? '';
    expect(description).toMatch(/Landings are NOT modelled/);
  });
});
