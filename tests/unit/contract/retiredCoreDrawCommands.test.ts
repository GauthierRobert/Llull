/** Retired draw / solid / inspect / document commands: saved steps replay on their replacement. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute, getCommand } from '@core/commands/registry';

const RETIRED = [
  'draw_line',
  'draw_circle',
  'extrude_sketch',
  'measure_volume',
  'look_at',
  'rename_layer',
  'set_layer_visibility',
  'set_layer_lock',
];

function load(
  steps: ReadonlyArray<{ name: string; params: unknown }>,
  extra: Record<string, unknown> = {},
): ReturnType<typeof deserializeDocument> {
  const base = createEmptyDocument();
  const featureHistory = steps.map((step, index) => ({ id: `step-${index + 1}`, ...step }));
  return deserializeDocument(serializeDocument({ ...base, featureHistory, ...extra } as never));
}

describe('retired core draw commands', () => {
  it('are no longer registered', () => {
    for (const name of RETIRED) expect(getCommand(name)).toBeUndefined();
  });

  it('rewrites draw_line, draw_circle and extrude_sketch steps and replays identical ids', () => {
    const loaded = load([
      { name: 'draw_line', params: { start: [0, 0], end: [4, 0], position: [1, 2, 3] } },
      { name: 'draw_circle', params: { center: [0, 0], radius: 2 } },
      { name: 'extrude_sketch', params: { id: 'circ-2.1', depth: 3 } },
    ]);
    expect(loaded.featureHistory.map((step) => step.name)).toEqual(['draw_polyline', 'draw_arc', 'extrude_profile']);
    expect(loaded.featureHistory[0]?.params).toEqual({
      points: [
        [0, 0],
        [4, 0],
      ],
      position: [1, 2, 3],
    });
    const replayed = execute(loaded, 'replay_history', {});
    expect(Object.keys(replayed.document.entities)).toEqual(['line-1.1', 'circ-2.1', 'ext-3.1']);
    expect(replayed.document.entities['line-1.1']).toMatchObject({
      kind: 'line',
      start: [0, 0],
      end: [4, 0],
      position: [1, 2, 3],
    });
    expect(replayed.document.entities['circ-2.1']?.kind).toBe('circle');
  });

  it('rewrites camera and layer steps onto set_camera and update_layer', () => {
    const loaded = load([
      { name: 'rename_layer', params: { id: 'layer-default', name: 'Base' } },
      { name: 'set_layer_visibility', params: { id: 'layer-default', visible: false } },
      { name: 'set_layer_lock', params: { id: 'layer-default', locked: true } },
      { name: 'look_at', params: { target: [1, 2, 3] } },
      { name: 'measure_volume', params: { entityId: 'box-1.1' } },
    ]);
    expect(loaded.featureHistory.map((step) => step.name)).toEqual([
      'update_layer',
      'update_layer',
      'update_layer',
      'set_camera',
      'mass_properties',
    ]);
    expect(loaded.featureHistory[1]?.params).toEqual({ id: 'layer-default', visible: false });
  });

  it('rewrites retired calls nested in recorded build_project plans', () => {
    const loaded = load([
      {
        name: 'build_project',
        params: {
          actions: [
            { command: 'draw_line', params: { start: [0, 0], end: [1, 1] }, as: 'a' },
            { repeat: { count: 2 }, step: { command: 'draw_circle', params: { radius: 1 } } },
          ],
        },
      },
    ]);
    expect(loaded.featureHistory[0]?.params).toEqual({
      actions: [
        {
          command: 'draw_polyline',
          params: {
            points: [
              [0, 0],
              [1, 1],
            ],
          },
          as: 'a',
        },
        { repeat: { count: 2 }, step: { command: 'draw_arc', params: { radius: 1 } } },
      ],
    });
  });
});
