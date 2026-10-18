import { describe, expect, it } from 'vitest';
import { writeInp } from '@cae/decks/inpWriter';
import { BAR_NODES, X0_NODES, X2_NODES, barDocument, barMesh, mustRun } from '../deckFixtures';

/** A symmetry constraint on both end faces of a slice (the thick-cylinder plan: "plane strain by symmetric ends") is two parallel planes. */
describe('symmetry constraint on two parallel planes', () => {
  const bar = barDocument({ supports: false });
  const doc = mustRun(bar.doc, 'add_fea_constraint', {
    analysisId: bar.analysisId,
    name: 'ends',
    kind: 'symmetry',
    target: {
      entityId: bar.boxId,
      facesNear: [
        [0, 0.5, 0.5],
        [2, 0.5, 0.5],
      ],
    },
  });
  const key = `C_${Object.keys(doc.analysis?.cases[bar.analysisId]?.constraints ?? {})[0] ?? ''}`;
  const deckWith = (extraNodes: readonly (readonly [number, number, number, number])[]): string => {
    const mesh = barMesh(doc, bar.analysisId, bar.boxId, {});
    const written = writeInp(doc, bar.analysisId, {
      ...mesh,
      nodeSets: { [key]: [...X0_NODES, ...X2_NODES, ...extraNodes.map((node) => node[0])] },
      nodes: [...BAR_NODES, ...extraNodes],
    });
    return 'text' in written ? written.text : written.code;
  };

  it('fixes the normal dof of both planes when only one axis takes at most two levels', () => {
    const text = deckWith([
      [9, 0, 0.25, 0.75],
      [10, 2, 0.5, 0.1],
    ]);
    expect(text).toContain(`*BOUNDARY, OP=NEW\n${key.replace(/[^A-Za-z0-9_]/g, '_')}, 1, 1\n`);
  });

  it('still refuses a node set that is not a pair of axis-aligned planes', () => {
    expect(deckWith([])).toBe('FEA_CONSTRAINT_INVALID');
  });
});
