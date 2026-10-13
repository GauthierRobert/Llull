/** Retired commands: saved steps naming a merged tool are rewritten onto its replacement on load. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { migrateRetiredCommands } from '@core/commands/persistence/retiredCommands';
import { installPlugin } from '@core/plugins/host';

installPlugin({
  name: 'retired-test',
  toolset: 'core',
  commands: [],
  retiredCommands: {
    legacy_cube: ({ edge, ...rest }) => ({ name: 'legacy_box', params: { ...rest, side: edge } }),
    legacy_box: ({ side, ...rest }) => ({
      name: 'add_box',
      params: { ...rest, size: [side, side, side] },
    }),
  },
});

/** A saved document whose history was recorded with the retired names. */
function savedWithRetiredSteps(): string {
  const doc = createEmptyDocument();
  const legacy: CadDocument = {
    ...doc,
    featureHistory: [
      { id: 'step-1', name: 'legacy_cube', params: { edge: 2 } },
      {
        id: 'step-2',
        name: 'build_project',
        params: {
          actions: [
            { command: 'legacy_box', params: { side: 3 } },
            { repeat: { count: 2 }, step: { command: 'legacy_cube', params: { edge: 1 } } },
          ],
        },
      },
    ],
    recipes: {
      cube: { name: 'cube', steps: [{ id: 'step-1', name: 'legacy_box', params: { side: 4 } }] },
    },
  };
  return serializeDocument(legacy);
}

describe('retired command migration', () => {
  it('rewrites history steps, nested plan actions and recipe steps (chained rewrites too)', () => {
    const loaded = deserializeDocument(savedWithRetiredSteps());
    expect(loaded.featureHistory[0]).toMatchObject({
      name: 'add_box',
      params: { size: [2, 2, 2] },
    });
    expect(loaded.featureHistory[1]?.params).toEqual({
      actions: [
        { command: 'add_box', params: { size: [3, 3, 3] } },
        { repeat: { count: 2 }, step: { command: 'add_box', params: { size: [1, 1, 1] } } },
      ],
    });
    expect(loaded.recipes['cube']?.steps[0]).toMatchObject({
      name: 'add_box',
      params: { size: [4, 4, 4] },
    });
  });

  it('replays the migrated history', () => {
    const loaded = deserializeDocument(savedWithRetiredSteps());
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(Object.values(replayed.entities).filter((entity) => entity.kind === 'box')).toHaveLength(4);
  });

  it('leaves current documents and malformed steps untouched', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const raw = JSON.parse(serializeDocument(doc)).document as Record<string, unknown>;
    expect(migrateRetiredCommands(raw)).toEqual(raw);
    const odd = { featureHistory: [null, { name: 7 }], recipes: { r: 'x' } };
    expect(migrateRetiredCommands(odd)).toEqual(odd);
    expect(migrateRetiredCommands({ featureHistory: 'nope' })).toEqual({ featureHistory: 'nope' });
  });

  it('maps animate_spin / animate_oscillate onto animate', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const boxId = doc.order[0]!;
    const saved = serializeDocument({
      ...doc,
      featureHistory: [
        ...doc.featureHistory,
        { id: 'step-2', name: 'animate_spin', params: { targetId: boxId, speed: 2 } },
        {
          id: 'step-3',
          name: 'animate_oscillate',
          params: { targetId: boxId, amplitude: 1, frequency: 0.5 },
        },
      ],
    });
    const replayed = execute(deserializeDocument(saved), 'replay_history', {}).document;
    expect(Object.values(replayed.animations).map((anim) => anim.mode)).toEqual(['spin', 'oscillate']);
  });

  it('maps add_mate onto add_constraint, keeping the minted mate id', () => {
    let doc = createEmptyDocument();
    for (const x of [0, 10]) {
      const box = execute(doc, 'add_box', { size: [1, 1, 1], position: [x, 0, 0] });
      doc = execute(box.document, 'create_component', {
        name: `C${x}`,
        entityIds: [box.affected[0]!],
      }).document;
    }
    const [first, second] = doc.order;
    const nextStep = doc.featureHistory.length + 1;
    const saved = serializeDocument({
      ...doc,
      featureHistory: [
        ...doc.featureHistory,
        {
          id: `step-${nextStep}`,
          name: 'add_mate',
          params: {
            kind: 'distance',
            a: { instanceId: first },
            b: { instanceId: second },
            value: 4,
          },
        },
        {
          id: `step-${nextStep + 1}`,
          name: 'update_constraint',
          params: { id: `mate-${nextStep}.1`, patch: { value: 6 } },
        },
      ],
      nextStepNumber: nextStep + 2,
    });
    const loaded = deserializeDocument(saved);
    expect(loaded.featureHistory.at(-2)?.params).toEqual({
      constraint: { kind: 'distance', a: { entityId: first }, b: { entityId: second }, value: 4 },
      id: `mate-${nextStep}.1`,
    });
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(replayed.constraints[`mate-${nextStep}.1`]).toMatchObject({
      kind: 'distance',
      value: 6,
    });
  });

  it('keeps an explicit add_mate id and mints fresh ids inside recipes', () => {
    const mate = { kind: 'coincident', a: { instanceId: 'i1' }, b: { instanceId: 'i2' } };
    const raw = migrateRetiredCommands({
      featureHistory: [{ id: 'step-1', name: 'add_mate', params: { ...mate, id: 'm' } }],
      recipes: { r: { name: 'r', steps: [{ id: 'step-1', name: 'add_mate', params: mate }] } },
    });
    expect((raw['featureHistory'] as Array<{ params: { id?: string } }>)[0]?.params.id).toBe('m');
    const recipes = raw['recipes'] as CadDocument['recipes'];
    expect(recipes['r']?.steps[0]?.params).not.toHaveProperty('id');
  });
});
