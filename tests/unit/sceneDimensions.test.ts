import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { SceneSnapshot } from '@core/commands/inspect/sceneTypes';
import { expectPure } from '../helpers/expectNoOp';
import { xy } from '../helpers/xy';

function withDimensions(): CadDocument {
  let doc = createEmptyDocument();
  const run = (command: string, params: object): string => {
    const result = execute(doc, command, params);
    doc = result.document;
    return result.affected[0]!;
  };
  const left = run('draw_polyline', { points: xy(0, 0, 0, 60) });
  const right = run('draw_polyline', { points: xy(100, 0, 100, 60) });
  const base = run('draw_polyline', { points: xy(0, 0, 100, 0) });
  run('add_dimension', { dimensionKind: 'linear', entityIds: [left, right], precision: 1, tolerance: '±0.05' });
  run('add_dimension', { dimensionKind: 'angular', entityIds: [base, left] });
  run('add_text', { content: 'NOTE', position: [0, -10, 0], height: 3 });
  return doc;
}

describe('describe_scene lists dimensions and texts', () => {
  const doc = withDimensions();
  const result = execute(doc, 'describe_scene', {});
  const snapshot = result.data as SceneSnapshot;

  it('gives each dimension its measured value, unit and drawn text', () => {
    expect(snapshot.dimensions).toEqual([
      { id: 'dim-4.1', dimensionKind: 'linear', entityIds: ['line-1.1', 'line-2.1'], value: 100, unit: 'mm', text: '100.0 ±0.05' },
      { id: 'dim-5.1', dimensionKind: 'angular', entityIds: ['line-3.1', 'line-1.1'], value: 90, unit: 'deg', text: '90.0°' },
    ]);
    expect(snapshot.texts).toEqual([{ id: 'text-6.1', content: 'NOTE', position: [0, -10, 0], height: 3 }]);
  });
  it('mentions them in the summary', () => {
    expect(result.summary).toContain('dim-4.1 linear 100.0 ±0.05 mm');
    expect(result.summary).toContain('dim-5.1 angular 90.0°');
    expect(result.summary).toContain('text-6.1 "NOTE"');
  });
  it('reports a dangling dimension as unresolved and stays pure', () => {
    const dangling = { ...doc, entities: { ...doc.entities } };
    delete dangling.entities['line-2.1'];
    const data = execute(dangling, 'describe_scene', {}).data as SceneSnapshot;
    expect(data.dimensions[0]).toMatchObject({ value: null, text: null });
    expect(execute(dangling, 'describe_scene', {}).summary).toContain('unresolved');
    expectPure(doc, () => execute(doc, 'describe_scene', {}));
  });
  it('an empty scene has no dimensions or texts and no extra summary', () => {
    const empty = execute(createEmptyDocument(), 'describe_scene', {});
    expect(empty.data).toMatchObject({ dimensions: [], texts: [] });
    expect(empty.summary).not.toContain('Dimensions');
  });
});
