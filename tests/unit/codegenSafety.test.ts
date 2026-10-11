import { describe, expect, it } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const PAYLOAD = "__import__('os').system('echo pwned')";

/** A document as an untrusted load_document could deliver it: strings where numbers belong, etc. */
function hostileDocument(): CadDocument {
  const revolution = {
    id: 'rev-1',
    kind: 'revolution',
    profile: [
      [1, 0],
      [2, 0],
      [2, 1],
    ],
    axis: [0, 0, 1],
    angle: Math.PI,
    segments: `0); ${PAYLOAD}; x=(0`,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#888888',
    name: `evil\n${PAYLOAD}\n"""\n${PAYLOAD}`,
  } as unknown as Entity;
  const box = {
    id: 'box-1',
    kind: 'box',
    size: [1, 2, 3],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#888888',
    name: 'show',
  } as unknown as Entity;
  const doc = createEmptyDocument();
  return {
    ...doc,
    units: `mm\n${PAYLOAD}` as CadDocument['units'],
    entities: { 'rev-1': revolution, 'box-1': box },
    order: ['rev-1', 'box-1'],
    parameters: { w: { name: `w\n${PAYLOAD}`, expression: '1', value: 1 } },
  };
}

function exported(doc: CadDocument, language: string): string {
  const data = execute(doc, 'export_code', { language }).data as { text: string };
  return data.text;
}

describe.each(['cadquery', 'build123d', 'openscad', 'freecad'])(
  'export_code (%s) never lets document strings escape into code',
  (language) => {
    const text = exported(hostileDocument(), language);

    it('keeps the payload off every executable line start', () => {
      for (const line of text.split('\n'))
        expect(line.trimStart().startsWith('__import__')).toBe(false);
    });

    it('emits a numeric segment count only', () => {
      if (language === 'openscad') return;
      expect(text).toMatch(/segments=32\b/);
      expect(text).not.toContain('segments=0)');
    });
  },
);

describe('export_code identifier hygiene', () => {
  it('never binds a variable to a runtime helper name such as show', () => {
    const freecad = exported(hostileDocument(), 'freecad');
    expect(freecad).not.toMatch(/^show = /m);
    expect(freecad).toMatch(/^show_1 = box/m);
  });
});
