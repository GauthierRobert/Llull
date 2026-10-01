import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { gridLetter } from '@core/commands/building/grid';
import { __resetIdCounter } from '@lib/id';

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  return execute(doc, name, params).document;
}

beforeEach(() => __resetIdCounter());

describe('add_level / update_level / delete_level / set_active_level', () => {
  it('adds stacked levels with default 3 m height and makes the newest active', () => {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'Ground' });
    doc = run(doc, 'add_level', { name: 'First' });
    const building = doc.building!;
    expect(building.levelOrder).toEqual(['level-1', 'level-2']);
    expect(building.levels['level-1']).toMatchObject({ elevation: 0, height: 3000 });
    expect(building.levels['level-2']).toMatchObject({ name: 'First', elevation: 3000 });
    expect(building.activeLevelId).toBe('level-2');
  });

  it('respects explicit elevation, unit-aware default height and makeActive false', () => {
    let doc = run(createEmptyDocument(), 'set_units', { units: 'm' });
    doc = run(doc, 'add_level', {});
    doc = run(doc, 'add_level', { elevation: -3, makeActive: false });
    expect(doc.building!.levels['level-1']!.height).toBeCloseTo(3);
    expect(doc.building!.levelOrder).toEqual(['level-2', 'level-1']);
    expect(doc.building!.activeLevelId).toBe('level-1');
  });

  it('rejects invalid height and is pure', () => {
    const doc = createEmptyDocument();
    const snapshot = structuredClone(doc);
    const result = execute(doc, 'add_level', { height: -1 });
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/failed/);
    expect(doc).toEqual(snapshot);
  });

  it('update_level moves the walls on it', () => {
    let doc = run(createEmptyDocument(), 'add_level', {});
    doc = run(doc, 'add_wall', { start: [0, 0], end: [4000, 0] });
    const before = doc.entities['wall-1:body-0']!.position[2];
    const result = execute(doc, 'update_level', {
      levelId: 'level-1',
      elevation: 500,
      name: 'Raised',
    });
    expect(result.document.entities['wall-1:body-0']!.position[2]).toBeCloseTo(before + 500);
    expect(result.affected).toContain('wall-1:body-0');
    expect(result.document.building!.levels['level-1']!.name).toBe('Raised');
  });

  it('update_level failure paths', () => {
    const doc = run(createEmptyDocument(), 'add_level', {});
    expect(execute(doc, 'update_level', { levelId: 'nope' }).summary).toMatch(/no level/);
    expect(execute(doc, 'update_level', { levelId: 'level-1', height: 0 }).summary).toMatch(
      /height/,
    );
    expect(
      execute(doc, 'update_level', { levelId: 'level-1', elevation: Number.NaN }).affected,
    ).toEqual([]);
  });

  it('delete_level refuses when occupied unless deleteElements, then removes hosted openings', () => {
    let doc = run(createEmptyDocument(), 'add_level', {});
    doc = run(doc, 'add_wall', { start: [0, 0], end: [5000, 0] });
    doc = run(doc, 'add_door', { wallId: 'wall-1' });
    expect(execute(doc, 'delete_level', { levelId: 'level-1' }).summary).toMatch(/refused/);
    const result = execute(doc, 'delete_level', { levelId: 'level-1', deleteElements: true });
    expect(result.document.building!.elementOrder).toEqual([]);
    expect(Object.keys(result.document.entities)).toEqual([]);
    expect(result.document.building!.activeLevelId).toBeNull();
    expect(execute(doc, 'delete_level', { levelId: 'x' }).summary).toMatch(/no level/);
  });

  it('delete_level of an empty level keeps the active level when another one was active', () => {
    let doc = run(createEmptyDocument(), 'add_level', {});
    doc = run(doc, 'add_level', { makeActive: false });
    const result = execute(doc, 'delete_level', { levelId: 'level-2' });
    expect(result.document.building!.activeLevelId).toBe('level-1');
  });

  it('set_active_level switches, no-ops on same / unknown', () => {
    let doc = run(createEmptyDocument(), 'add_level', {});
    doc = run(doc, 'add_level', {});
    const switched = execute(doc, 'set_active_level', { levelId: 'level-1' });
    expect(switched.document.building!.activeLevelId).toBe('level-1');
    expect(execute(switched.document, 'set_active_level', { levelId: 'level-1' }).summary).toMatch(
      /already/,
    );
    expect(execute(doc, 'set_active_level', { levelId: 'zz' }).document).toBe(doc);
  });
});

describe('set_project_info / describe_building', () => {
  it('merges project fields and reports them', () => {
    const doc = run(createEmptyDocument(), 'set_project_info', {
      name: 'Maison Dupont',
      client: 'Dupont',
    });
    expect(doc.building!.project).toMatchObject({ name: 'Maison Dupont', client: 'Dupont' });
    const described = execute(doc, 'describe_building', {});
    expect(described.document).toBe(doc);
    expect(described.summary).toMatch(/Maison Dupont.*0 level/);
    expect(execute(doc, 'set_project_info', {}).summary).toMatch(/no fields/);
  });

  it('describe_building lists levels with element counts', () => {
    let doc = run(createEmptyDocument(), 'draw_walls', {
      points: [
        [0, 0],
        [4000, 0],
        [4000, 3000],
      ],
    });
    doc = run(doc, 'add_grid_line', { start: [0, -1000], end: [0, 4000] });
    const data = execute(doc, 'describe_building', {}).data as {
      levels: Array<{ elementCount: number; active: boolean }>;
      elements: unknown[];
    };
    expect(data.levels[0]).toMatchObject({ elementCount: 2, active: true });
    expect(data.elements).toHaveLength(3);
  });
});

describe('structural grid', () => {
  it('gridLetter skips I and O and rolls over', () => {
    expect([0, 7, 8, 12, 13, 23, 24].map(gridLetter)).toEqual(['A', 'H', 'J', 'N', 'P', 'Z', 'AA']);
  });

  it('add_grid_line creates axis, bubbles and labels on S-GRID', () => {
    const result = execute(createEmptyDocument(), 'add_grid_line', {
      start: [0, 0],
      end: [0, 10000],
      label: 'A',
    });
    expect(result.affected).toHaveLength(5);
    expect(result.document.layers['layer-S-GRID']?.name).toBe('S-GRID');
    expect(result.document.entities['grid-1:axis']).toMatchObject({
      kind: 'line',
      layerId: 'layer-S-GRID',
    });
    expect(
      execute(result.document, 'add_grid_line', { start: [5, 0], end: [5, 9], label: 'A' }).summary,
    ).toMatch(/already exists/);
    expect(
      execute(result.document, 'add_grid_line', { start: [0, 0], end: [0, 0] }).summary,
    ).toMatch(/distinct/);
    const auto = execute(result.document, 'add_grid_line', { start: [9, 0], end: [9, 9] });
    expect(auto.document.building!.elements['grid-2']!.mark).toBe('1');
  });

  it('add_grid_system lays out numbered and lettered axes', () => {
    const result = execute(createEmptyDocument(), 'add_grid_system', {
      xSpacings: [6000, 6000],
      ySpacings: [5000],
    });
    expect((result.data as { labels: string[] }).labels).toEqual(['1', '2', '3', 'A', 'B']);
    const axis3 = result.document.building!.elements['grid-3']!;
    expect(axis3).toMatchObject({ start: [12000, -1500], end: [12000, 6500] });
    expect(result.summary).toMatch(/12000 × 5000/);
  });

  it('add_grid_system failure paths', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'add_grid_system', { xSpacings: [0], ySpacings: [] }).document).toBe(doc);
    expect(execute(doc, 'add_grid_system', { xSpacings: [], ySpacings: [] }).document).toBe(doc);
    expect(
      execute(doc, 'add_grid_system', { xSpacings: [1], ySpacings: [1], origin: 'x' }).summary,
    ).toMatch(/origin/);
    expect(
      execute(doc, 'add_grid_system', { xSpacings: [1], ySpacings: [1], extension: -1 }).summary,
    ).toMatch(/extension/);
  });
});

describe('integration with document-level commands', () => {
  it('clear_document removes the building model', () => {
    const doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [1000, 0] });
    const cleared = execute(doc, 'clear_document', {});
    expect(cleared.document.building).toBeUndefined();
    expect(doc.building).toBeDefined();
  });

  it('building survives a save/load round trip', async () => {
    const { serializeDocument, deserializeDocument } = await import('@core/commands/persistence');
    const doc = run(createEmptyDocument(), 'draw_walls', {
      points: [
        [0, 0],
        [3000, 0],
        [3000, 3000],
      ],
    });
    const restored = deserializeDocument(serializeDocument(doc));
    expect(restored.building).toEqual(doc.building);
    expect(restored.entities['wall-1:body-0']).toEqual(doc.entities['wall-1:body-0']);
  });

  it('doc patches carry the building model both ways', async () => {
    const { computeDocPatch, applyDocPatch } = await import('@core/mcp/docPatch');
    const before = createEmptyDocument();
    const after = run(before, 'add_wall', { start: [0, 0], end: [1000, 0] });
    const patch = computeDocPatch(before, after);
    expect(applyDocPatch(before, patch).building).toEqual(after.building);
    const cleared = execute(after, 'clear_document', {}).document;
    expect(applyDocPatch(after, computeDocPatch(after, cleared)).building).toBeUndefined();
    expect(computeDocPatch(after, after).building).toBeUndefined();
  });

  it('undo-style history replay regenerates the same building', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [4000, 0] });
    doc = run(doc, 'add_door', { wallId: 'wall-1' });
    const replayed = execute(doc, 'replay_history', {});
    expect(replayed.document.building?.elements['door-1']).toEqual(
      doc.building?.elements['door-1'],
    );
  });
});
