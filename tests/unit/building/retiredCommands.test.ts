import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { migrateRetiredCalls } from '@core/commands/persistence/retiredCommands';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { xy } from '../../helpers/xy';

describe('retired building commands', () => {
  it('add_wall steps in a saved document load as draw_walls and replay to the same wall', () => {
    const modern = execute(createEmptyDocument(), 'draw_walls', { points: xy(0, 0, 5000, 0), thickness: 150 }).document;
    const legacyStep = { ...modern.featureHistory[0]!, name: 'add_wall', params: { start: [0, 0], end: [5000, 0], thickness: 150 } };
    const loaded = deserializeDocument(serializeDocument({ ...modern, featureHistory: [legacyStep] }));
    expect(loaded.featureHistory[0]).toMatchObject({ name: 'draw_walls', params: { points: xy(0, 0, 5000, 0), thickness: 150 } });
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(replayed.building?.elements['wall-1']).toEqual(modern.building?.elements['wall-1']);
    expect(Object.keys(replayed.entities)).toEqual(Object.keys(modern.entities));
  });
});

describe('renamed civil / export commands', () => {
  function reloadedAs(modern: CadDocument, stepIndex: number, legacyName: string): CadDocument {
    const legacyStep = { ...modern.featureHistory[stepIndex]!, name: legacyName };
    const history = modern.featureHistory.map((step, index) => (index === stepIndex ? legacyStep : step));
    return deserializeDocument(serializeDocument({ ...modern, featureHistory: history }));
  }

  it('add_pipe / update_pipe steps load as add_drainage_pipe / update_drainage_pipe and replay identically', () => {
    let doc = execute(createEmptyDocument(), 'set_units', { units: 'm' }).document;
    for (const location of [
      [0, 0],
      [50, 0],
    ])
      doc = execute(doc, 'add_manhole', { location, invertElevation: 98, rimElevation: 100 }).document;
    doc = execute(doc, 'add_drainage_pipe', { fromId: 'manhole-1', toId: 'manhole-2' }).document;
    doc = execute(doc, 'update_drainage_pipe', { pipeId: 'pipe-1', diameter: 0.45 }).document;
    const loaded = reloadedAs(reloadedAs(doc, 3, 'add_pipe'), 4, 'update_pipe');
    expect(loaded.featureHistory.map((step) => step.name).slice(3)).toEqual(['add_drainage_pipe', 'update_drainage_pipe']);
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(replayed.civil?.objects['pipe-1']).toEqual(doc.civil?.objects['pipe-1']);
  });

  it('the old names are no longer registered', () => {
    const doc = createEmptyDocument();
    for (const name of ['add_pipe', 'update_pipe', 'export_dxf', 'export_long_section']) {
      const result = execute(doc, name, {});
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
  });

  it('export_dxf / export_long_section calls nested in a plan are rewritten', () => {
    const plan = {
      steps: [
        { command: 'export_dxf', params: { levelId: 'level-1' } },
        { command: 'export_long_section', params: { alignmentId: 'a' } },
      ],
    };
    expect(migrateRetiredCalls(plan)).toEqual({
      steps: [
        { command: 'export_building_dxf', params: { levelId: 'level-1' } },
        { command: 'export_road_long_section', params: { alignmentId: 'a' } },
      ],
    });
  });
});
