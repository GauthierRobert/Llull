import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence';

function envelopeWith(history: unknown): string {
  const envelope = JSON.parse(serializeDocument(createEmptyDocument())) as {
    document: Record<string, unknown>;
  };
  envelope.document['featureHistory'] = history;
  return JSON.stringify(envelope);
}

describe('load_document with a malformed featureHistory', () => {
  const doc = createEmptyDocument();

  it.each([
    ['a null entry', [null]],
    ['a number entry', [5]],
    ['an entry without an id', [{ name: 'add_box' }]],
    ['a non-string id', [{ id: 7, name: 'add_box' }]],
  ])('reports the malformed entry for %s (not a TypeError)', (_label, history) => {
    const result = execute(doc, 'load_document', { json: envelopeWith(history) });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('featureHistory[0] is malformed');
    expect(result.summary).not.toContain('Cannot read properties');
  });

  it('still loads a well-formed history and raises the step counter past it', () => {
    const built = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const json = JSON.parse(serializeDocument(built)) as { document: Record<string, unknown> };
    delete json.document['nextStepNumber'];
    const loaded = execute(doc, 'load_document', { json: JSON.stringify(json) });
    expect(loaded.document.nextStepNumber).toBeGreaterThan(1);
  });
});
