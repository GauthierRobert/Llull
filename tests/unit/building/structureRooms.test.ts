import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { wallLoop, gridIntersections } from '@core/commands/building/structure';
import type { WallElement } from '@core/model/building';

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  return execute(doc, name, params).document;
}

const SQUARE = [
  [0, 0],
  [6000, 0],
  [6000, 4000],
  [0, 4000],
];

function perimeter(): CadDocument {
  return run(createEmptyDocument(), 'draw_walls', { points: SQUARE, closed: true });
}

describe('add_slab', () => {
  it('creates a slab from a boundary with its top at the level', () => {
    const result = execute(createEmptyDocument(), 'add_slab', { boundary: SQUARE, thickness: 250 });
    const body = result.document.entities['slab-1:body'];
    expect(body).toMatchObject({ kind: 'extrusion', depth: 250, position: [0, 0, -250] });
    expect(result.summary).toMatch(/floor slab SL1.*24000000\.000 mm²/);
  });

  it('builds the slab to the outer faces of a closed wall loop, as a roof on top', () => {
    let doc = perimeter();
    doc = run(doc, 'add_slab', {
      wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'],
      wallFace: 'outer',
      role: 'roof',
      offset: 3000,
    });
    const slab = doc.building!.elements['slab-1']!;
    expect(slab.category === 'slab' && slab.boundary).toEqual([
      [-100, -100],
      [6100, -100],
      [6100, 4100],
      [-100, 4100],
    ]);
    expect(doc.entities['slab-1:body']?.name).toBe('Roof SL1');
  });

  it('rejects invalid boundaries, open loops and bad thickness', () => {
    const doc = run(createEmptyDocument(), 'draw_walls', { points: SQUARE.slice(0, 3) });
    expect(execute(doc, 'add_slab', {}).document).toBe(doc);
    expect(
      execute(doc, 'add_slab', {
        boundary: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      }).document,
    ).toBe(doc);
    expect(execute(doc, 'add_slab', { wallIds: ['wall-1', 'wall-2'] }).document).toBe(doc);
    expect(execute(doc, 'add_slab', { wallIds: ['wall-1', 'nope'] }).document).toBe(doc);
    expect(execute(doc, 'add_slab', { boundary: SQUARE, thickness: 0 }).summary).toMatch(
      /thickness/,
    );
    expect(execute(doc, 'add_slab', { boundary: SQUARE, levelId: 'q' }).summary).toMatch(
      /unknown level/,
    );
  });

  it('add_slab from all level walls ignores T-joined partitions', () => {
    let doc = perimeter();
    doc = run(doc, 'add_wall', { start: [3000, 0], end: [3000, 4000], thickness: 100 });
    doc = run(doc, 'add_wall', { start: [3000, 2000], end: [6000, 2000], thickness: 100 });
    const result = execute(doc, 'add_slab', {
      wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4', 'wall-5', 'wall-6'],
    });
    expect(result.summary).toMatch(/area 24000000\.000/);
    const inner = execute(doc, 'add_slab', {
      wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'],
      wallFace: 'inner',
    });
    expect(inner.summary).toMatch(/area 22040000\.000/);
  });

  it('wallLoop rejects disconnected walls', () => {
    const mk = (id: string, start: [number, number], end: [number, number]): WallElement => ({
      id,
      category: 'wall',
      mark: id,
      entityIds: [],
      levelId: 'l',
      start,
      end,
      thickness: 1,
      height: 1,
      baseOffset: 0,
      material: 'concrete',
    });
    expect(
      wallLoop([mk('a', [0, 0], [1, 0]), mk('b', [5, 5], [6, 6]), mk('c', [1, 0], [0, 0])]),
    ).toBeNull();
    expect(
      wallLoop([mk('a', [0, 0], [4, 0]), mk('b', [4, 0], [4, 4]), mk('c', [4, 4], [0, 5])]),
    ).toBeNull();
  });
});

describe('add_column', () => {
  it('places one rectangular column at a location', () => {
    const result = execute(createEmptyDocument(), 'add_column', { location: [1000, 2000] });
    expect(result.document.entities['column-1:body']).toMatchObject({
      kind: 'box',
      size: [300, 300, 3000],
      position: [1000, 2000, 1500],
    });
  });

  it('places circular columns at every grid intersection', () => {
    let doc = run(createEmptyDocument(), 'add_grid_system', {
      xSpacings: [6000, 6000],
      ySpacings: [5000],
    });
    expect(gridIntersections(doc.building!)).toHaveLength(6);
    const result = execute(doc, 'add_column', {
      atGridIntersections: true,
      shape: 'circular',
      width: 400,
    });
    doc = result.document;
    expect((result.data as { elementIds: string[] }).elementIds).toHaveLength(6);
    expect(doc.entities['column-6:body']).toMatchObject({ kind: 'cylinder', radius: 200 });
  });

  it('failure paths', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'add_column', {}).summary).toMatch(/location/);
    expect(execute(doc, 'add_column', { atGridIntersections: true }).summary).toMatch(
      /no intersections/,
    );
    expect(execute(doc, 'add_column', { location: [0, 0], width: -1 }).summary).toMatch(/> 0/);
    expect(execute(doc, 'add_column', { location: [0, 0], levelId: 'nope' }).document).toBe(doc);
  });
});

describe('add_beam / add_stair', () => {
  it('hangs a beam under the level top', () => {
    const result = execute(createEmptyDocument(), 'add_beam', { start: [0, 0], end: [6000, 0] });
    expect(result.document.entities['beam-1:body']).toMatchObject({
      size: [6000, 300, 500],
      position: [3000, 0, 2750],
    });
    expect(
      execute(createEmptyDocument(), 'add_beam', { start: [0, 0], end: [0, 0] }).affected,
    ).toEqual([]);
    expect(
      execute(createEmptyDocument(), 'add_beam', { start: [0, 0], end: [1, 0], depth: 0 }).affected,
    ).toEqual([]);
    expect(
      execute(createEmptyDocument(), 'add_beam', { start: [0, 0], end: [1, 0], levelId: 'x' })
        .affected,
    ).toEqual([]);
  });

  it('derives equal risers from the level height and reports the Blondel rule', () => {
    const result = execute(createEmptyDocument(), 'add_stair', { start: [0, 0] });
    const stair = result.document.building!.elements['stair-1']!;
    expect(stair).toMatchObject({ riserCount: 18 });
    expect(stair.category === 'stair' && stair.riserHeight).toBeCloseTo(166.67, 1);
    expect(result.affected).toHaveLength(19);
    expect(result.summary).toMatch(/2R\+G = 613 mm\./);
    const steep = execute(createEmptyDocument(), 'add_stair', {
      start: [0, 0],
      riserCount: 10,
      treadDepth: 200,
    });
    expect(steep.summary).toMatch(/outside the 600–650 mm comfort range/);
  });

  it('stair failure paths', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'add_stair', { start: 'a' }).document).toBe(doc);
    expect(execute(doc, 'add_stair', { start: [0, 0], riserCount: 1 }).document).toBe(doc);
    expect(execute(doc, 'add_stair', { start: [0, 0], levelId: 'nope' }).document).toBe(doc);
  });
});

describe('rooms and element edits', () => {
  it('add_room from walls follows the inner faces and tags the area', () => {
    const result = execute(perimeter(), 'add_room', {
      name: 'Living',
      wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'],
    });
    expect(result.summary).toMatch(/room 001 "Living".*22\.04 m²/);
    expect(result.document.entities['room-1:tag-area']).toMatchObject({
      kind: 'text',
      content: '22.04 m²',
    });
    expect(result.document.entities['room-1:outline']).toMatchObject({
      kind: 'polyline',
      closed: true,
    });
  });

  it('add_room failure paths', () => {
    const doc = perimeter();
    expect(execute(doc, 'add_room', { name: ' ' }).summary).toMatch(/name/);
    expect(execute(doc, 'add_room', { name: 'A' }).summary).toMatch(/boundary/);
    expect(execute(doc, 'add_room', { name: 'A', wallIds: ['wall-1', 'grid-1'] }).document).toBe(
      doc,
    );
    expect(execute(doc, 'add_room', { name: 'A', boundary: SQUARE, levelId: 'x' }).document).toBe(
      doc,
    );
  });

  it('delete_building_element removes a wall with its openings and re-trims neighbours', () => {
    let doc = run(perimeter(), 'add_door', { wallId: 'wall-1' });
    const result = execute(doc, 'delete_building_element', { elementIds: ['wall-1', 'ghost'] });
    doc = result.document;
    expect(doc.building!.elements['door-1']).toBeUndefined();
    expect(doc.entities['door-1:leaf']).toBeUndefined();
    expect(result.affected).toContain('wall-1:body-0');
    const wall2 = doc.entities['wall-2:body-0'];
    expect(wall2?.kind === 'box' && wall2.size[0]).toBeCloseTo(4100);
    expect(execute(doc, 'delete_building_element', { elementIds: ['ghost'] }).document).toBe(doc);
    expect(execute(doc, 'delete_building_element', { elementIds: 'x' }).document).toBe(doc);
  });

  it('move_building_element translates every kind; openings follow their wall', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_door', { wallId: 'wall-1' });
    doc = run(doc, 'add_slab', { boundary: SQUARE });
    doc = run(doc, 'add_column', { location: [0, 0] });
    doc = run(doc, 'add_stair', { start: [0, 0] });
    doc = run(doc, 'add_room', { name: 'R', boundary: SQUARE });
    doc = run(doc, 'add_grid_line', { start: [0, 0], end: [0, 9] });
    const ids = ['wall-1', 'door-1', 'slab-1', 'column-1', 'stair-1', 'room-1', 'grid-1'];
    const result = execute(doc, 'move_building_element', { elementIds: ids, delta: [1000, 0] });
    const moved = result.document.building!.elements;
    expect(moved['wall-1']).toMatchObject({ start: [1000, 0] });
    expect(moved['column-1']).toMatchObject({ location: [1000, 0] });
    expect(moved['stair-1']).toMatchObject({ start: [1000, 0] });
    expect(moved['grid-1']).toMatchObject({ start: [1000, 0] });
    expect(moved['room-1']?.category === 'room' && moved['room-1'].boundary[0]).toEqual([1000, 0]);
    expect(result.document.entities['door-1:leaf']?.position[0]).toBeCloseTo(3000);
    expect(
      execute(doc, 'move_building_element', { elementIds: ['x'], delta: [1, 1] }).document,
    ).toBe(doc);
    expect(execute(doc, 'move_building_element', { elementIds: ids, delta: [1] }).document).toBe(
      doc,
    );
  });

  it('copy_level_elements repeats a typical floor with its openings', () => {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'L0' });
    doc = run(doc, 'draw_walls', { points: SQUARE, closed: true });
    doc = run(doc, 'add_window', { wallId: 'wall-1' });
    doc = run(doc, 'add_room', { name: 'Office', boundary: SQUARE });
    doc = run(doc, 'add_level', { name: 'L1' });
    doc = run(doc, 'add_level', { name: 'L2' });
    const result = execute(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-2', 'level-3', 'level-1'],
    });
    const elements = Object.values(result.document.building!.elements);
    expect(elements.filter((element) => element.category === 'wall')).toHaveLength(12);
    expect(elements.filter((element) => element.category === 'window')).toHaveLength(3);
    expect(result.document.building!.elements['room-3']?.mark).toBe('201');
    const copiedWindow = result.document.building!.elements['window-2'];
    expect(copiedWindow?.category === 'window' && copiedWindow.hostId).toBe('wall-5');
    expect(result.document.entities['wall-5:body-0']?.position[2]).toBeGreaterThan(3000);
    const wallsOnly = execute(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-2'],
      categories: ['room'],
    });
    expect((wallsOnly.data as { elementIds: string[] }).elementIds).toEqual(['room-2']);
  });

  it('copy_level_elements failure paths', () => {
    let doc = run(createEmptyDocument(), 'add_level', {});
    doc = run(doc, 'add_level', {});
    expect(
      execute(doc, 'copy_level_elements', { sourceLevelId: 'level-1', targetLevelIds: [] }).summary,
    ).toMatch(/no targets/);
    expect(
      execute(doc, 'copy_level_elements', { sourceLevelId: 'level-1', targetLevelIds: ['level-9'] })
        .summary,
    ).toMatch(/level-9/);
    expect(
      execute(doc, 'copy_level_elements', { sourceLevelId: 'level-1', targetLevelIds: ['level-2'] })
        .summary,
    ).toMatch(/nothing to copy/);
  });
});

describe('level-aware edits', () => {
  it('rooms and slabs from wallIds land on the walls’ level; mixed levels are refused', () => {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'L0' });
    doc = run(doc, 'add_level', { name: 'L1' });
    doc = run(doc, 'draw_walls', { points: SQUARE, closed: true, levelId: 'level-2' });
    doc = run(doc, 'set_active_level', { levelId: 'level-1' });
    const walls = ['wall-1', 'wall-2', 'wall-3', 'wall-4'];
    const room = execute(doc, 'add_room', { name: 'Office', wallIds: walls });
    expect(room.document.building!.elements['room-1']).toMatchObject({ levelId: 'level-2' });
    const slab = execute(doc, 'add_slab', { wallIds: walls });
    expect(slab.document.building!.elements['slab-1']).toMatchObject({ levelId: 'level-2' });
    doc = run(doc, 'add_wall', { start: [0, 0], end: [1000, 0], levelId: 'level-1' });
    expect(
      execute(doc, 'add_room', { name: 'X', wallIds: ['wall-5', 'wall-2', 'wall-3'] }).summary,
    ).toMatch(/different levels/);
    expect(execute(doc, 'add_slab', { wallIds: ['wall-5', 'wall-2', 'wall-3'] }).summary).toMatch(
      /different levels/,
    );
  });

  it('full-height walls, columns and stairs follow a level height change and copies', () => {
    let doc = run(createEmptyDocument(), 'add_level', {});
    doc = run(doc, 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_wall', { start: [0, 2000], end: [4000, 2000], height: 1200 });
    doc = run(doc, 'add_column', { location: [0, 1000] });
    doc = run(doc, 'add_stair', { start: [500, 500] });
    const raised = execute(doc, 'update_level', { levelId: 'level-1', height: 3600 }).document;
    const elements = raised.building!.elements;
    expect(elements['wall-1']).toMatchObject({ height: 3600 });
    expect(elements['wall-2']).toMatchObject({ height: 1200 });
    expect(elements['column-1']).toMatchObject({ height: 3600 });
    const stair = elements['stair-1']!;
    expect(stair.category === 'stair' && stair.riserCount * stair.riserHeight).toBeCloseTo(3600);
    let copied = run(raised, 'add_level', { height: 2700 });
    copied = run(copied, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-2'],
    });
    expect(copied.building!.elements['wall-3']).toMatchObject({ height: 2700, levelId: 'level-2' });
    expect(copied.building!.elements['wall-4']).toMatchObject({ height: 1200 });
  });
});

describe('review follow-ups', () => {
  it('refuses to move a hosted opening on its own', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_door', { wallId: 'wall-1' });
    expect(
      execute(doc, 'move_building_element', { elementIds: ['door-1'], delta: [1, 0] }).summary,
    ).toMatch(/follow their host .* slide openings with update_opening/);
  });

  it('slab openings travel with their slab', () => {
    let doc = run(createEmptyDocument(), 'add_slab', { boundary: SQUARE });
    doc = run(doc, 'add_slab_opening', {
      slabId: 'slab-1',
      boundary: [
        [1000, 1000],
        [2000, 1000],
        [2000, 2000],
        [1000, 2000],
      ],
    });
    doc = run(doc, 'move_building_element', { elementIds: ['slab-1'], delta: [500, 0] });
    const slab = doc.building!.elements['slab-1']!;
    expect(slab.category === 'slab' && slab.openings?.[0]?.[0]).toEqual([1500, 1000]);
  });

  it('copied room numbers stay unique and readable', async () => {
    const { copiedRoomNumber } = await import('@core/commands/building/elements');
    let doc = run(createEmptyDocument(), 'add_level', {});
    doc = run(doc, 'add_level', {});
    doc = run(doc, 'add_room', { name: 'A', number: '003', boundary: SQUARE, levelId: 'level-1' });
    doc = run(doc, 'add_room', {
      name: 'Lobby',
      number: 'Lobby',
      boundary: SQUARE,
      levelId: 'level-1',
    });
    expect(copiedRoomNumber(doc.building!, '003', 1)).toBe('103');
    expect(copiedRoomNumber(doc.building!, 'Lobby', 1)).toBe('Lobby-L1');
    expect(copiedRoomNumber(doc.building!, '003', 0)).toBe('003-2');
  });
});
