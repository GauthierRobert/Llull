import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

beforeEach(() => __resetIdCounter());

describe('add_building_template', () => {
  it('creates a two-storey house without upper-floor entrance doors', () => {
    const doc = createEmptyDocument();
    const snapshot = structuredClone(doc);
    const result = execute(doc, 'add_building_template', { template: 'house' });
    expect(doc).toEqual(snapshot);
    const building = result.document.building!;
    expect(building.levelOrder).toHaveLength(3);
    expect(building.project.name).toBe('Two-storey house');
    expect(building.activeLevelId).toBe('level-1');
    const doors = Object.values(building.elements).filter((element) => element.category === 'door');
    expect(doors).toHaveLength(3);
    expect(result.summary).toMatch(/house template: 3 level\(s\), 37 building element/);
    expect(result.affected.length).toBeGreaterThan(50);
  });

  it('creates an office frame and keeps an existing project name; ids continue after existing ones', () => {
    let doc = execute(createEmptyDocument(), 'set_project_info', { name: 'Tower A' }).document;
    doc = execute(doc, 'add_wall', { start: [0, -20000], end: [5000, -20000] }).document;
    const result = execute(doc, 'add_building_template', { template: 'office', origin: [0, 0] });
    const building = result.document.building!;
    expect(building.project.name).toBe('Tower A');
    const counts = (category: string): number =>
      Object.values(building.elements).filter((element) => element.category === category).length;
    expect(counts('column')).toBe(36);
    expect(counts('door')).toBe(1);
    expect(counts('window')).toBe(17);
    expect(building.levelOrder).toHaveLength(5);
  });

  it('rejects unknown templates and bad origins; stacks a second template', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'add_building_template', { template: 'castle' }).document).toBe(doc);
    expect(execute(doc, 'add_building_template', { template: 'house', origin: [1] }).document).toBe(
      doc,
    );
    const metres = execute(doc, 'set_units', { units: 'm' }).document;
    const ok = execute(metres, 'add_building_template', { template: 'house' });
    expect(ok.document.building!.levels['level-2']!.elevation).toBeCloseTo(2.9);
    const twice = execute(ok.document, 'add_building_template', {
      template: 'house',
      origin: [20, 0],
    });
    expect(twice.summary).toMatch(/6 level\(s\), 37 building element/);
  });
});

describe('second review regressions', () => {
  it('templates still work after elements and levels were deleted (B1)', () => {
    let doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
    }).document;
    doc = execute(doc, 'add_door', { wallId: 'wall-1' }).document;
    doc = execute(doc, 'add_stair', { start: [500, 500] }).document;
    doc = execute(doc, 'add_level', {}).document;
    doc = execute(doc, 'delete_building_element', { elementIds: ['wall-1', 'stair-1'] }).document;
    doc = execute(doc, 'delete_level', { levelId: 'level-2' }).document;
    for (const template of ['house', 'office']) {
      const result = execute(doc, 'add_building_template', { template, origin: [50000, 0] });
      expect(result.summary, template).toMatch(/template: /);
    }
  });

  it('solve_constraints still runs in a document with a building (B2)', () => {
    let doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
    }).document;
    doc = execute(doc, 'draw_line', { start: [0, 5000], end: [1000, 5000] }).document;
    const a = doc.order[doc.order.length - 1]!;
    doc = execute(doc, 'draw_line', { start: [2000, 6000], end: [3000, 6000] }).document;
    const b = doc.order[doc.order.length - 1]!;
    const constrained = execute(doc, 'add_constraint', {
      constraint: {
        kind: 'coincident',
        a: { entityId: a, kind: 'end' },
        b: { entityId: b, kind: 'start' },
      },
    });
    expect(constrained.summary).not.toMatch(/failed/);
    const solved = execute(constrained.document, 'solve_constraints', {});
    expect(solved.summary).not.toMatch(/rejected/);
    expect(solved.document).not.toBe(constrained.document);
  });

  it('copies of generated geometry are refused and never resolve to the element (H1)', async () => {
    const { buildingElementOf } = await import('@core/commands/building');
    const doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
    }).document;
    expect(execute(doc, 'duplicate_entity', { id: 'wall-1:body-0' }).summary).toMatch(/rejected/);
    expect(buildingElementOf(doc, 'wall-1:body-0')).toBe('wall-1');
    const forged = {
      ...doc,
      entities: { ...doc.entities, x: { ...doc.entities['wall-1:body-0']!, id: 'x' } },
    };
    expect(buildingElementOf(forged, 'x')).toBeNull();
  });

  it('the building uid survives history replay and is not burned by reads (H3)', () => {
    let doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
    }).document;
    doc = execute(doc, 'add_wall', { start: [0, 3000], end: [4000, 3000] }).document;
    const uid = doc.building!.uid;
    expect(uid).toBeDefined();
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(replayed.building!.uid).toBe(uid);
    expect(
      execute(createEmptyDocument(), 'describe_building', {}).document.building,
    ).toBeUndefined();
  });
});
