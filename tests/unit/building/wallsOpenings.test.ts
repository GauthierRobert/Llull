import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type BoxEntity, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { endAdjustment, wallPieces } from '@aec/wallGeometry';
import type { WallElement } from '@core/model/building';

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  return execute(doc, name, params).document;
}

function box(doc: CadDocument, id: string): BoxEntity {
  const entity = doc.entities[id];
  if (entity?.kind !== 'box') throw new Error(`${id} is not a box`);
  return entity;
}

function wall(doc: CadDocument, id: string): WallElement {
  const element = doc.building?.elements[id];
  if (element?.category !== 'wall') throw new Error(`${id} is not a wall`);
  return element;
}

describe('add_wall', () => {
  it('creates a wall on an auto-created level with default 200 mm × level height', () => {
    const doc = createEmptyDocument();
    const snapshot = structuredClone(doc);
    const result = execute(doc, 'add_wall', { start: [0, 0], end: [5000, 0] });
    expect(doc).toEqual(snapshot);
    const piece = box(result.document, 'wall-1:body-0');
    expect(piece.size).toEqual([5000, 200, 3000]);
    expect(piece.position).toEqual([2500, 0, 1500]);
    expect(piece.layerId).toBe('layer-A-WALL');
    expect(piece.tags).toEqual(['bim', 'wall', 'element:wall-1']);
    expect(result.document.building!.levels['level-1']!.name).toBe('Level 0');
    expect(result.affected).toEqual(['wall-1', 'wall-1:body-0']);
    expect(result.summary).toMatch(/W1 \(wall-1\).*5000\.000 mm/);
  });

  it('rotates the wall body to follow a diagonal centerline', () => {
    const doc = run(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [3000, 3000],
      material: 'brick',
    });
    const piece = box(doc, 'wall-1:body-0');
    expect(piece.rotation[2]).toBeCloseTo(Math.PI / 4);
    expect(piece.size[0]).toBeCloseTo(Math.hypot(3000, 3000));
    expect(piece.color).toBe('#b0623a');
  });

  it('failure paths leave the document untouched', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'add_wall', { start: [0, 0], end: [0, 0] }).document).toBe(doc);
    expect(execute(doc, 'add_wall', { start: [0], end: [1, 1] }).document).toBe(doc);
    expect(execute(doc, 'add_wall', { start: [0, 0], end: [1, 1], thickness: 0 }).summary).toMatch(
      /thickness/,
    );
    expect(execute(doc, 'add_wall', { start: [0, 0], end: [1, 1], height: -2 }).summary).toMatch(
      /height/,
    );
    expect(
      execute(doc, 'add_wall', { start: [0, 0], end: [1, 1], baseOffset: Number.NaN }).document,
    ).toBe(doc);
    expect(
      execute(doc, 'add_wall', { start: [0, 0], end: [1, 1], levelId: 'level-9' }).summary,
    ).toMatch(/unknown level/);
  });
});

describe('draw_walls and corner joins', () => {
  const square = [
    [0, 0],
    [6000, 0],
    [6000, 4000],
    [0, 4000],
  ];

  it('draws a closed perimeter of 4 walls whose ends interlock without overlap', () => {
    const result = execute(createEmptyDocument(), 'draw_walls', { points: square, closed: true });
    const doc = result.document;
    expect(Object.keys(doc.building!.elements)).toEqual(['wall-1', 'wall-2', 'wall-3', 'wall-4']);
    // wall-1 joins wall-2 (later) at its end and wall-4 (later) at its start → extends both ends.
    expect(box(doc, 'wall-1:body-0').size[0]).toBeCloseTo(6200);
    // wall-2 joins wall-1 (earlier) at start → retracts; joins wall-3 (later) at end → extends.
    expect(box(doc, 'wall-2:body-0').size[0]).toBeCloseTo(4000);
    // wall-4 joins wall-3 and wall-1, both earlier → retracts at both ends.
    expect(box(doc, 'wall-4:body-0').size[0]).toBeCloseTo(3800);
    expect(result.summary).toMatch(/4 wall\(s\).*20000\.000/);
  });

  it('retracts an abutting wall at a T junction and ignores collinear continuations', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [6000, 0] });
    doc = run(doc, 'add_wall', { start: [3000, 0], end: [3000, 3000], thickness: 100 });
    doc = run(doc, 'add_wall', { start: [6000, 0], end: [9000, 0] });
    expect(endAdjustment(doc.building!, wall(doc, 'wall-2'), 'start')).toBeCloseTo(-100);
    expect(endAdjustment(doc.building!, wall(doc, 'wall-3'), 'start')).toBe(0);
    expect(box(doc, 'wall-2:body-0').size[0]).toBeCloseTo(2900);
  });

  it('rejects bad point lists', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'draw_walls', { points: [[0, 0]] }).document).toBe(doc);
    expect(
      execute(doc, 'draw_walls', {
        points: [
          [0, 0],
          [1, 0],
        ],
        closed: true,
      }).document,
    ).toBe(doc);
    expect(
      execute(doc, 'draw_walls', {
        points: [
          [0, 0],
          [0, 0],
        ],
      }).summary,
    ).toMatch(/zero length/);
  });
});

describe('add_door / add_window', () => {
  function oneWall(): CadDocument {
    return run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [5000, 0] });
  }

  it('a door cuts the wall into side pieces + lintel and draws a swing', () => {
    const result = execute(oneWall(), 'add_door', { wallId: 'wall-1', offset: 1000 });
    const doc = result.document;
    const pieces = doc.building!.elements['wall-1']!.entityIds;
    expect(pieces).toEqual(['wall-1:body-0', 'wall-1:body-1', 'wall-1:body-2']);
    expect(box(doc, 'wall-1:body-0').size).toEqual([550, 200, 3000]);
    expect(box(doc, 'wall-1:body-1').size).toEqual([900, 200, 900]);
    expect(box(doc, 'wall-1:body-1').position[2]).toBeCloseTo(2550);
    expect(doc.entities['door-1:swing']).toMatchObject({ kind: 'arc', radius: 900 });
    expect(doc.entities['door-1:leaf']).toMatchObject({ kind: 'box', layerId: 'layer-A-DOOR' });
    expect(result.summary).toMatch(/door D1 \(door-1\) 900×2100/);
  });

  it('right-hinged doors swing from the far jamb', () => {
    const doc = run(oneWall(), 'add_door', { wallId: 'wall-1', offset: 2500, swing: 'right' });
    const arc = doc.entities['door-1:swing'];
    expect(arc?.kind === 'arc' && arc.center[0]).toBeCloseTo(2950);
    expect(arc?.kind === 'arc' && arc.endAngle).toBeCloseTo(Math.PI);
  });

  it('a window leaves a sill piece and a head piece; `at` projects onto the wall', () => {
    const doc = run(oneWall(), 'add_window', { wallId: 'wall-1', at: [3000, 800], width: 1000 });
    const element = doc.building!.elements['window-1']!;
    expect(element.category === 'window' && element.offset).toBeCloseTo(3000);
    expect(doc.building!.elements['wall-1']!.entityIds).toHaveLength(4);
    expect(doc.entities['window-1:glass']).toMatchObject({ layerId: 'layer-A-GLAZ' });
  });

  it('refuses openings that overflow, overlap, are too tall, or name a missing wall', () => {
    const doc = run(oneWall(), 'add_door', { wallId: 'wall-1', offset: 1000 });
    expect(execute(doc, 'add_window', { wallId: 'wall-1', offset: 4900 }).summary).toMatch(/spans/);
    expect(execute(doc, 'add_window', { wallId: 'wall-1', offset: 1500 }).summary).toMatch(
      /overlaps D1/,
    );
    expect(
      execute(doc, 'add_window', { wallId: 'wall-1', offset: 3000, height: 2500 }).summary,
    ).toMatch(/exceeds/);
    expect(execute(doc, 'add_door', { wallId: 'nope' }).summary).toMatch(/no wall/);
    expect(execute(doc, 'add_door', { wallId: 'wall-1', width: -1 }).summary).toMatch(/width/);
    expect(execute(doc, 'add_door', { wallId: 'wall-1', at: 'x' }).document).toBe(doc);
  });

  it('update_opening with no effective change is a no-op', () => {
    const doc = run(oneWall(), 'add_window', { wallId: 'wall-1' });
    const none = execute(doc, 'update_opening', { openingId: 'window-1' });
    expect(none.document).toBe(doc);
    expect(none.affected).toEqual([]);
    expect(none.summary).toMatch(/already has these values/);
  });

  it('update_opening slides and resizes; refuses misfits', () => {
    const doc = run(oneWall(), 'add_window', { wallId: 'wall-1' });
    const moved = execute(doc, 'update_opening', {
      openingId: 'window-1',
      offset: 1000,
      width: 800,
      mark: 'W-A',
    });
    expect(moved.document.building!.elements['window-1']).toMatchObject({
      offset: 1000,
      width: 800,
      mark: 'W-A',
    });
    expect(execute(doc, 'update_opening', { openingId: 'window-1', offset: 100 }).summary).toMatch(
      /refused/,
    );
    expect(execute(doc, 'update_opening', { openingId: 'wall-1' }).summary).toMatch(
      /no door or window/,
    );
    expect(execute(doc, 'update_opening', { openingId: 'window-1', height: 0 }).summary).toMatch(
      /> 0/,
    );
    const swung = execute(
      run(doc, 'add_door', { wallId: 'wall-1', offset: 600 }),
      'update_opening',
      { openingId: 'door-1', swing: 'right', material: 'steel' },
    );
    expect(swung.document.building!.elements['door-1']).toMatchObject({
      swing: 'right',
      material: 'steel',
    });
  });
});

describe('update_wall', () => {
  it('lengthens a wall and keeps hosted openings', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_door', { wallId: 'wall-1', offset: 1000 });
    const result = execute(doc, 'update_wall', {
      wallId: 'wall-1',
      end: [8000, 0],
      thickness: 300,
      material: 'block',
    });
    expect(wall(result.document, 'wall-1')).toMatchObject({
      end: [8000, 0],
      thickness: 300,
      material: 'block',
    });
    expect(result.document.entities['door-1:leaf']).toBeDefined();
  });

  it('refuses changes that would orphan an opening and other invalid edits', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_window', { wallId: 'wall-1', offset: 3000 });
    expect(execute(doc, 'update_wall', { wallId: 'wall-1', end: [2000, 0] }).summary).toMatch(
      /refused/,
    );
    expect(execute(doc, 'update_wall', { wallId: 'wall-1', height: 1000 }).summary).toMatch(
      /exceeds/,
    );
    expect(execute(doc, 'update_wall', { wallId: 'x' }).summary).toMatch(/no wall/);
    expect(execute(doc, 'update_wall', { wallId: 'wall-1', start: [1] }).summary).toMatch(
      /rejected: invalid params — start/,
    );
    expect(execute(doc, 'update_wall', { wallId: 'wall-1', thickness: 0 }).summary).toMatch(/> 0/);
    expect(execute(doc, 'update_wall', { wallId: 'wall-1', levelId: 'zz' }).summary).toMatch(
      /no level/,
    );
    expect(execute(doc, 'update_wall', { wallId: 'wall-1', end: [0, 0] }).summary).toMatch(
      /coincide/,
    );
  });
});

describe('wallPieces', () => {
  it('handles openings flush with the wall top and base', () => {
    const base: WallElement = {
      id: 'w',
      category: 'wall',
      mark: 'W',
      entityIds: [],
      levelId: 'l',
      start: [0, 0],
      end: [10, 0],
      thickness: 1,
      height: 3,
      baseOffset: 0,
      material: 'concrete',
    };
    const pieces = wallPieces(
      base,
      [
        {
          id: 'o',
          category: 'window',
          mark: 'O',
          entityIds: [],
          hostId: 'w',
          offset: 5,
          width: 2,
          height: 3,
          sillHeight: 0,
          swing: 'left',
          material: 'glass',
        },
      ],
      { start: 0, end: 10 },
    );
    expect(pieces).toEqual([
      { s0: 0, s1: 4, z0: 0, z1: 3 },
      { s0: 6, s1: 10, z0: 0, z1: 3 },
    ]);
  });
});

describe('feature-history replay keeps hosts linked', () => {
  it('suppressing an earlier wall re-links a later window to its renumbered host', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_wall', { start: [0, 3000], end: [4000, 3000] });
    doc = run(doc, 'add_window', { wallId: 'wall-2', offset: 2000 });
    doc = run(doc, 'add_door', { wallId: 'wall-2', offset: 600 });
    const firstWallStep = doc.featureHistory[0]!.id;
    const result = execute(doc, 'set_step_suppressed', { stepId: firstWallStep, suppressed: true });
    const building = result.document.building!;
    expect(Object.keys(building.elements).sort()).toEqual(['door-1', 'wall-1', 'window-1']);
    const window = building.elements['window-1']!;
    expect(window.category === 'window' && window.hostId).toBe('wall-1');
    expect(building.elements['wall-1']).toMatchObject({ start: [0, 3000] });
  });
});

describe('built wall extents', () => {
  it('quantities measure the abutting wall body at a T joint', async () => {
    const { wallQuantities } = await import('@aec/takeoffBasics');
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [8000, 0] });
    doc = run(doc, 'add_wall', { start: [4000, 0], end: [4000, 5000] });
    expect(wallQuantities(doc.building!, wall(doc, 'wall-2')).length).toBeCloseTo(4900);
  });

  it('refuses an opening that would reach into the through wall', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [8000, 0] });
    doc = run(doc, 'add_wall', { start: [4000, 0], end: [4000, 5000] });
    expect(execute(doc, 'add_door', { wallId: 'wall-2', offset: 450 }).summary).toMatch(
      /built from 100\.000 to 5000\.000/,
    );
    expect(execute(doc, 'add_door', { wallId: 'wall-2', offset: 600 }).document).not.toBe(doc);
  });

  it.each([120, 150, 170])('extends the outer edge only at a %i° joint (no spikes)', (degrees) => {
    const turn = Math.PI - (degrees * Math.PI) / 180;
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_wall', {
      start: [4000, 0],
      end: [4000 + 3000 * Math.cos(turn), 3000 * Math.sin(turn)],
    });
    const phi = (degrees * Math.PI) / 180;
    // Equal 200 mm walls: the earlier wall reaches (t/2)·cot(φ/2) past the joint.
    expect(endAdjustment(doc.building!, wall(doc, 'wall-1'), 'end')).toBeCloseTo(
      100 / Math.tan(phi / 2),
    );
    expect(endAdjustment(doc.building!, wall(doc, 'wall-2'), 'start')).toBeCloseTo(
      -(100 - 100 * Math.abs(Math.cos(phi))) / Math.sin(phi),
    );
  });

  it('acute joints reach the far face', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_wall', {
      start: [4000, 0],
      end: [4000 - 3000 * Math.cos(Math.PI / 3), 3000 * Math.sin(Math.PI / 3)],
    });
    const phi = Math.PI / 3;
    expect(endAdjustment(doc.building!, wall(doc, 'wall-1'), 'end')).toBeCloseTo(
      (100 + 100 * Math.cos(phi)) / Math.sin(phi),
    );
  });

  it('clamps sill / head pieces to the built extent', () => {
    const pieces = wallPieces(
      {
        id: 'w',
        category: 'wall',
        mark: 'W',
        entityIds: [],
        levelId: 'l',
        start: [0, 0],
        end: [10, 0],
        thickness: 1,
        height: 3,
        baseOffset: 0,
        material: 'concrete',
      },
      [
        {
          id: 'o',
          category: 'window',
          mark: 'O',
          entityIds: [],
          hostId: 'w',
          offset: 1,
          width: 2,
          height: 1,
          sillHeight: 1,
          swing: 'left',
          material: 'glass',
        },
      ],
      { start: 0.5, end: 10 },
    );
    expect(pieces[0]).toEqual({ s0: 0.5, s1: 2, z0: 0, z1: 1 });
  });
});
