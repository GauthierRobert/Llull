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
