/**
 * @layer server/tests
 *
 * commandBus: a command that returns `data` AND changes the document (build_project) is applied
 * and recorded in history; a pure query (data, same document) is still skipped.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { applyCommand, undo, redo, canUndo, _resetHistory } from '../src/commandBus';
import { getLiveDoc, _resetLiveDoc } from '../src/liveDocument';

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

const PLAN = {
  actions: [
    { command: 'set_parameter', params: { name: 'width', expression: '30' } },
    { command: 'add_box', as: 'base', params: { size: ['=width', 10, 5] } },
    { command: 'add_sphere', params: { radius: 4 } },
  ],
};

describe('applyCommand — mutating command that also returns data', () => {
  it('applies build_project to the live document and returns its step report', () => {
    const result = applyCommand('build_project', PLAN);
    expect(result.isError).toBe(false);
    expect(result.affected).toHaveLength(2);
    const live = getLiveDoc();
    expect(Object.keys(live.entities)).toHaveLength(2);
    expect(live.parameters['width']?.value).toBe(30);
    const data = result.data as { ok: boolean; stepCount: number; steps: unknown[] };
    expect(data.ok).toBe(true);
    expect(data.stepCount).toBe(3);
    expect(data.steps).toHaveLength(3);
  });

  it('records one undo step that reverts the whole plan, and redo restores it', () => {
    applyCommand('build_project', PLAN);
    expect(canUndo()).toBe(true);
    undo();
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
    expect(getLiveDoc().parameters['width']).toBeUndefined();
    redo();
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(2);
  });

  it('a validate-only dry run returns data but leaves document and history untouched', () => {
    const result = applyCommand('build_project', { ...PLAN, validate: true });
    expect(result.data).toBeDefined();
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it('a failing plan rolls back: nothing applied, no history entry', () => {
    const result = applyCommand('build_project', {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { command: 'nope', params: {} },
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it('a pure query still returns data without touching history', () => {
    applyCommand('add_box', { size: [1, 1, 1] });
    undo();
    redo();
    const before = getLiveDoc();
    const result = applyCommand('export_code', { language: 'cadquery' });
    expect(result.data).toBeDefined();
    expect(getLiveDoc()).toBe(before);
    undo();
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
  });
});
