/**
 * Child process of saveKill.test.ts: saves a ~0.5 MB document over and over through the real save path (`writeDocumentFile`) until it
 * is killed. Generation `g` puts every box at x = g; after each save it prints `saved <g>` on stdout.
 * argv: <document path> <first generation>
 */
import { writeSync } from 'node:fs';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { writeDocumentFile } from '../../src/documentFile';

const BOX_COUNT = 4000;

function generationDocument(generation: number): CadDocument {
  const empty = createEmptyDocument();
  const layerId = empty.layerOrder[0] ?? '';
  const entities: Record<string, Entity> = {};
  const order: string[] = [];
  for (let index = 0; index < BOX_COUNT; index++) {
    const id = `box${index}`;
    entities[id] = {
      id,
      kind: 'box',
      size: [1, 2, 3],
      position: [generation, index, 0],
      rotation: [0, 0, 0],
      layerId,
      color: '#6b8f9c',
    } as Entity;
    order.push(id);
  }
  return { ...empty, entities, order };
}

if (require.main === module) {
  const [docPath, first] = process.argv.slice(2);
  if (docPath === undefined) throw new Error('usage: saveLoopChild <document path> <first generation>');
  for (let generation = Number(first ?? '1'); ; generation++) {
    writeDocumentFile(docPath, generationDocument(generation));
    writeSync(1, `saved ${generation}\n`); // synchronous: this loop never yields to the event loop
  }
}
