import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { MAX_RESOURCE_ITEMS, readMcpResource } from '@mcp/resources';

function documentWithBoxes(count: number): CadDocument {
  const plan = {
    actions: [
      {
        repeat: { count, as: 'row' },
        step: { command: 'add_box', params: { size: [1, 1, 1], position: ['=$i', 0, 0] } },
      },
    ],
  };
  return execute(createEmptyDocument(), 'build_project', plan).document;
}

const read = (doc: CadDocument, uri: string): Record<string, unknown> =>
  JSON.parse(readMcpResource(doc, uri)?.text ?? '{}') as Record<string, unknown>;

describe('cad://scene and cad://selection size limits', () => {
  it('returns small models complete, without a truncation note', () => {
    const scene = read(documentWithBoxes(5), 'cad://scene');
    expect(scene['entityCount']).toBe(5);
    expect(scene['entities']).toHaveLength(5);
    expect(scene).not.toHaveProperty('truncated');
  });

  it('cuts the entity list of a large model and says how much was cut', () => {
    const total = MAX_RESOURCE_ITEMS + 120;
    const scene = read(documentWithBoxes(total), 'cad://scene');
    expect(scene['entityCount']).toBe(total);
    expect(scene['entities']).toHaveLength(MAX_RESOURCE_ITEMS);
    expect(scene['truncated']).toMatchObject({
      entityCount: total,
      entitiesShown: MAX_RESOURCE_ITEMS,
    });
    expect(JSON.stringify(scene['truncated'])).toContain('cad://document');
    expect(scene['bounds']).not.toBeNull(); // whole-model facts stay exact
  });

  it('lists at most the cap of selected entities but reports the true count', () => {
    const total = MAX_RESOURCE_ITEMS + 50;
    const doc = documentWithBoxes(total);
    const selected = { ...doc, selection: doc.order };
    const selection = read(selected, 'cad://selection');
    expect(selection['count']).toBe(total);
    expect(selection['entities']).toHaveLength(MAX_RESOURCE_ITEMS);
  });

  it('serves the conventions guide as markdown and rejects unknown URIs', () => {
    const guide = readMcpResource(createEmptyDocument(), 'cad://conventions');
    expect(guide?.mimeType).toBe('text/markdown');
    expect(guide?.text).toContain('Agent Modeling Conventions');
    expect(readMcpResource(createEmptyDocument(), 'cad://nope')).toBeNull();
  });

  it('cad://document stays complete for reloading the whole model', () => {
    const doc = documentWithBoxes(MAX_RESOURCE_ITEMS + 20);
    const envelope = read(doc, 'cad://document') as { document: { order: string[] } };
    expect(envelope.document.order).toHaveLength(MAX_RESOURCE_ITEMS + 20);
  });
});
