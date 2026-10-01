import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { buildFeatureProgram } from '@core/codegen/featureProgram';
import { __resetIdCounter } from '@lib/id';

const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];

function box(ref?: string): Record<string, unknown> {
  return {
    command: 'add_box',
    ...(ref !== undefined ? { ref } : {}),
    params: { size: [{ value: 1 }, { value: 2 }, { value: 3 }] },
  };
}

beforeEach(() => {
  __resetIdCounter();
});

describe('apply_code_trace validation', () => {
  it('rejects an unknown mode instead of treating it as replace', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'apply_code_trace', {
      trace: { parameters: [], features: [box('f1')] },
      mode: 'merge',
    });
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/mode must be "replace" or "append"/);
  });

  it('rejects duplicate refs and non-string names', () => {
    const doc = createEmptyDocument();
    const duplicate = execute(doc, 'apply_code_trace', {
      trace: { parameters: [], features: [box('f1'), box('f1')] },
    });
    expect(duplicate.summary).toMatch(/ref must be a unique string/);
    const badName = execute(doc, 'apply_code_trace', {
      trace: { parameters: [], features: [{ ...box('f1'), name: 7 }] },
    });
    expect(badName.summary).toMatch(/name must be a string/);
  });

  it('reports every created solid, including ref-less features and multi-body meshes', () => {
    const result = execute(createEmptyDocument(), 'apply_code_trace', {
      trace: {
        parameters: [],
        features: [
          box(),
          {
            command: 'import_mesh',
            params: { bodies: [{ positions: triangle }, { positions: triangle }] },
          },
        ],
      },
    });
    expect(result.affected).toHaveLength(3);
    expect(result.affected.every((id) => result.document.entities[id] !== undefined)).toBe(true);
  });
});

describe('buildFeatureProgram history check', () => {
  it('falls back to a snapshot when history replays to different geometry (same solid count)', () => {
    const built = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const [id] = built.order;
    const entity = built.entities[id ?? ''];
    if (entity === undefined || entity.kind !== 'box') throw new Error('box missing');
    // Same history, but the stored geometry no longer matches it (e.g. a stale loaded file).
    const stale = { ...built, entities: { [entity.id]: { ...entity, size: [9, 9, 9] as const } } };
    const program = buildFeatureProgram(stale, getCommand);
    expect(program.source).toBe('snapshot');
    expect(program.notes.join(' ')).toMatch(/different geometry/);
    const solid = program.features[0];
    expect(solid?.op === 'solid' && solid.shape.kind === 'box' && solid.shape.size[0].value).toBe(
      9,
    );
  });

  it('keeps the history when it reproduces the document', () => {
    const built = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    expect(buildFeatureProgram(built, getCommand).source).toBe('history');
  });
});
