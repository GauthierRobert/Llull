/** Deck writers stay linear in the mesh size: no argument spread of mesh-sized line arrays (V8 throws RangeError past ~10^5 arguments). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { writeInp } from '@cae/decks/inpWriter';
import { barDocument, barMesh, X0_NODES } from './deckFixtures';

const MANY = 400_000;

describe('large decks', () => {
  it('writes a static step with hundreds of thousands of *CLOAD rows', () => {
    const base = barDocument();
    const load = execute(base.doc, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'tip',
      kind: 'force',
      vector: [0, 0, -1000],
      target: { entityId: base.boxId, pointsNear: [[2, 1, 1]] },
    });
    const bar = { ...base, doc: load.document };
    const loadId = load.affected[0] ?? '';
    const extra = Array.from({ length: MANY }, (_, index): [number, number, number, number] => [9 + index, 2, 1, 1 + index * 1e-6]);
    const huge = extra.map(([id]) => id);
    const plain = barMesh(bar.doc, bar.analysisId, bar.boxId, {
      [`C_${bar.constraints['x0']}`]: X0_NODES,
      [`L_${loadId}`]: huge,
      [`C_${bar.constraints['nodeA']}`]: [1],
      [`C_${bar.constraints['nodeB']}`]: [3],
    });
    const mesh = { ...plain, nodes: plain.nodes.concat(extra) };
    const deck = writeInp(bar.doc, bar.analysisId, mesh);
    if (!('text' in deck)) throw new Error(JSON.stringify(deck));
    expect(deck.text).toContain('*CLOAD');
  });
});
