/** Fonts survive replay with no font provider (VC-WRP-19): the document carries the records and bytes, and import_font records its bytes once. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setFontProvider } from '@core/commands/fontPort';
import { Buffer } from 'node:buffer';
import { firaBytes, firaProvider } from './fixtures';
import { emptyDoc, labelOn, make } from './support';

describe('replay without a font provider', () => {
  it('replays a bundled-font text and its outline command with the provider gone', () => {
    setFontProvider(firaProvider());
    const label = labelOn(emptyDoc(), 'WRAP');
    const outline = execute(label.doc, 'text_outline', { id: label.id });
    expect(outline.rejected).toBeUndefined();
    setFontProvider(null);
    const replayed = execute(outline.document, 'replay_history', {});
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(outline.document.entities));
    expect(replayed.document.entities[label.id]).toEqual(outline.document.entities[label.id]);
    expect(Object.keys(replayed.document.fonts ?? {})).toEqual(Object.keys(outline.document.fonts ?? {}));
  });

  it('import_font records the sha256 of the embedded blob, not the base64, and replays from the blob', () => {
    const base64 = Buffer.from(firaBytes()).toString('base64');
    const imported = make(emptyDoc(), 'import_font', { base64 });
    const step = imported.doc.featureHistory.at(-1)?.params as Record<string, unknown>;
    expect(step['base64']).toBeUndefined();
    expect(typeof step['blob']).toBe('string');
    expect(JSON.stringify(imported.doc.featureHistory)).not.toContain(base64.slice(0, 200));
    const replayed = execute(imported.doc, 'replay_history', {});
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(Object.keys(replayed.document.fonts ?? {})).toEqual([imported.id]);
    const again = execute(imported.doc, 'import_font', {});
    expect(again.rejected).toBe(true);
    const unknownBlob = execute(imported.doc, 'import_font', { blob: 'f'.repeat(64) });
    expect(unknownBlob.rejected).toBe(true);
  });
});
