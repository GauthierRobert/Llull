/** Review fixes of FEA-REST part 1: mixed load targets, free-free modal band, stored marginal band, signed identity, element-type guards. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import { buildDeckContext } from '@cae/decks/context';
import { consistentWeights } from '@cae/decks/loadDistribution';
import { writeInp } from '@cae/decks/inpWriter';
import { meshQuality } from '@cae/results/meshQuality';
import { X0_NODES, X2_NODES, barDocument, barMesh, facesOn, mustRun } from './deckFixtures';
import { caseIn } from './helpers';
import { marginBar } from './marginsFixtures';

describe('a force target mixing a face with a point', () => {
  const bar = barDocument();
  const doc = mustRun(bar.doc, 'add_fea_load', {
    analysisId: bar.analysisId,
    name: 'pull',
    kind: 'force',
    vector: [100, 0, 0],
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]], pointsNear: [[0, 0, 0]] },
  });
  const loadId = caseIn(doc, bar.analysisId).loadOrder[0] ?? '';
  const key = `L_${loadId}`;
  const sets = (nodes: readonly number[]): Record<string, readonly number[]> => ({
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
    [key]: nodes,
  });
  const contextOf = (nodes: readonly number[]): NonNullable<ReturnType<typeof buildDeckContext>> => {
    const mesh = barMesh(doc, bar.analysisId, bar.boxId, sets(nodes), { [key]: facesOn(X2_NODES) });
    const built = buildDeckContext(doc, bar.analysisId, mesh);
    if (built === null) throw new Error('no context');
    return built;
  };

  it('uses consistent weights when every target node is a face node', () => {
    expect(consistentWeights(contextOf(X2_NODES), key)).not.toBeNull();
  });

  it('falls back to the equal split over ALL target nodes when the target holds a node off its faces', () => {
    expect(consistentWeights(contextOf([...X2_NODES, 1]), key)).toBeNull();
    const mesh = barMesh(doc, bar.analysisId, bar.boxId, sets([...X2_NODES, 1]), { [key]: facesOn(X2_NODES) });
    const written = writeInp(doc, bar.analysisId, mesh);
    const text = 'text' in written ? written.text : '';
    const forces = text
      .split('\n')
      .slice(text.split('\n').indexOf('*CLOAD, OP=NEW') + 1)
      .filter((line) => /^\d+, 1, /.test(line));
    expect(forces).toHaveLength(5);
    expect(forces.every((line) => Number(line.split(',')[2]) === 20)).toBe(true);
  });
});

describe('modal case without supports', () => {
  it('writes a small negative lower bound on *FREQUENCY; a stated minimum wins; supported cases keep the plain line', () => {
    const free = barDocument({ analysisType: 'modal', supports: false });
    const text = (doc: typeof free.doc): string => {
      const written = writeInp(doc, free.analysisId, barMesh(doc, free.analysisId, free.boxId, {}));
      return 'text' in written ? written.text : JSON.stringify(written);
    };
    expect(text(free.doc)).toContain('*FREQUENCY\n6, -1\n');
    const banded = mustRun(free.doc, 'create_analysis', { name: 'm', analysisType: 'modal' });
    expect(banded).toBeDefined();
    const supported = barDocument({ analysisType: 'modal' });
    const supportedText = writeInp(
      supported.doc,
      supported.analysisId,
      barMesh(supported.doc, supported.analysisId, supported.boxId, {
        [`C_${supported.constraints['x0']}`]: X0_NODES,
        [`C_${supported.constraints['nodeA']}`]: [1],
        [`C_${supported.constraints['nodeB']}`]: [3],
      }),
    );
    expect('text' in supportedText && supportedText.text).toContain('*FREQUENCY\n6\n');
  });
});

describe('set_margin_band', () => {
  const bar = marginBar();
  const codes = (doc: typeof bar.recorded): string[] =>
    (execute(doc, 'check_analysis', { analysisId: bar.analysisId }, bar.ctx).data as { items: { code: string }[] }).items.map(
      (entry) => entry.code,
    );

  it('stores the band, clears FEA_MARGINAL_BAND_UNSET, and omitting it clears the band again', () => {
    expect(codes(bar.recorded)).toContain('FEA_MARGINAL_BAND_UNSET');
    const set = execute(bar.recorded, 'set_margin_band', { analysisId: bar.analysisId, marginalBand: 0.15 });
    expect(set.rejected).not.toBe(true);
    expect(set.affected).toEqual([bar.analysisId]);
    expect(caseIn(set.document, bar.analysisId).marginalBand).toBe(0.15);
    expect(codes(set.document)).not.toContain('FEA_MARGINAL_BAND_UNSET');
    const cleared = execute(set.document, 'set_margin_band', { analysisId: bar.analysisId });
    expect(caseIn(cleared.document, bar.analysisId)).not.toHaveProperty('marginalBand');
    expect(codes(cleared.document)).toContain('FEA_MARGINAL_BAND_UNSET');
  });

  it('refuses an unknown analysis and a negative band without changing the document; is pure', () => {
    const before = JSON.stringify(bar.recorded);
    expect(execute(bar.recorded, 'set_margin_band', { analysisId: 'nope', marginalBand: 0.1 }).summary).toContain('FEA_ANALYSIS_NOT_FOUND');
    const negative = execute(bar.recorded, 'set_margin_band', { analysisId: bar.analysisId, marginalBand: -1 });
    expect(negative.summary).toContain('FEA_MARGIN_PARAM_INVALID');
    expect(negative.document).toBe(bar.recorded);
    expect(JSON.stringify(bar.recorded)).toBe(before);
  });
});

describe('meshQuality skips element types it has no metrics for', () => {
  it('a hexahedron block gives no tet metrics and no inverted count', () => {
    const bar = barDocument();
    const base = barMesh(bar.doc, bar.analysisId, bar.boxId, {});
    const mesh: FeMeshArtifact = {
      ...base,
      blocks: [{ type: 'C3D8' as never, entityId: bar.boxId, elements: [[1, 1, 2, 4, 3, 5, 6, 8, 7]] }],
    };
    expect(meshQuality(mesh)).toEqual({ metrics: {}, inverted: 0 });
  });
});
