import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, MeshSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { meshQuality } from '@cae/results/meshQuality';
import { meshSummary } from '@cae/results/summary';
import { withCase } from '@cae/shared/access';
import { trustedRecord } from '@cae/shared/trust';
import { caseIn } from './helpers';
import { solvedBar } from './deckFixtures';

const tet = (nodes: FeMeshArtifact['nodes']): FeMeshArtifact => ({
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '1',
  inputHash: 'x',
  nodes,
  blocks: [{ type: 'C3D4', entityId: 'box-1.1', elements: [[1, 1, 2, 3, 4]] }],
  nodeSets: {},
  faceSets: {},
  targets: {},
});

describe('tet quality metric', () => {
  it('rates a regular tetrahedron 1 (any size) and a flat sliver near 0, flagging only the sliver', () => {
    const regularAt = (scale: number): FeMeshArtifact['nodes'] => [
      [1, scale, scale, scale],
      [2, scale, -scale, -scale],
      [3, -scale, -scale, scale],
      [4, -scale, scale, -scale],
    ];
    for (const scale of [1, 100]) {
      const regular = meshQuality(tet(regularAt(scale)));
      expect(regular.metrics['tet_scaled_jacobian']?.min).toBeCloseTo(1, 12);
      expect(regular.metrics['tet_scaled_jacobian']?.outsideAcceptable).toBe(0);
      expect(regular.metrics['tet_edge_ratio']?.min).toBeCloseTo(1, 12);
    }
    const sliver = meshQuality(
      tet([
        [1, 0, 0, 0],
        [2, 1, 0, 0],
        [3, 0, 1, 0],
        [4, 0.3, 0.3, 0.001],
      ]),
    );
    const sj = sliver.metrics['tet_scaled_jacobian'];
    expect(sj?.min).toBeGreaterThan(0);
    expect(sj?.min).toBeLessThan(0.01);
    expect(sj?.outsideAcceptable).toBe(1);
    expect(sliver.inverted).toBe(0);
  });
});

describe('trust ignores the derived quality diagnostic', () => {
  const bar = solvedBar();
  const ctx = { ...defaultContext(), feaArtifacts: bar.port };
  const recorded = (patch: (summary: MeshSummary) => MeshSummary): { doc: CadDocument; summary: MeshSummary } => {
    const summary = patch(meshSummary(bar.mesh, bar.meshHash));
    const doc = withCase(bar.doc, { ...caseIn(bar.doc, bar.analysisId), meshSummary: summary });
    return { doc, summary };
  };

  it('keeps a mesh recorded with an older (halved) quality trusted, and record_fe_mesh still accepts it', () => {
    const old = recorded((summary) => ({
      ...summary,
      quality: {
        ...summary.quality,
        metrics: Object.fromEntries(
          Object.entries(summary.quality.metrics).map(([key, metric]) => [
            key,
            key === 'tet_scaled_jacobian' ? { ...metric, min: metric.min / 2, max: metric.max / 2, outsideAcceptable: 6 } : metric,
          ]),
        ),
      },
    }));
    const trust = trustedRecord(old.doc, caseIn(old.doc, bar.analysisId), bar.port);
    expect(trust.state).toBe('meshed');
    expect(trust.problem).toBeNull();
    expect(trust.mesh?.quality).toEqual(meshSummary(bar.mesh, bar.meshHash).quality);
    const again = execute(bar.doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: old.summary }, ctx);
    expect(again.error).toBeUndefined();
    expect(caseIn(again.document, bar.analysisId).meshSummary?.quality).toEqual(meshSummary(bar.mesh, bar.meshHash).quality);
  });

  it('still marks a mesh with a tampered node count untrusted', () => {
    const tampered = recorded((summary) => ({ ...summary, nodes: summary.nodes + 1 }));
    const trust = trustedRecord(tampered.doc, caseIn(tampered.doc, bar.analysisId), bar.port);
    expect(trust.state).toBe('untrusted');
    expect(trust.problem?.message).toContain('nodes');
  });
});
