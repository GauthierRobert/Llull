/** Degenerate inputs of the mesh metrics, the adequacy screen and the restraint rank (branch coverage of verdict / adequacy / restraint). */
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { buildDeckContext } from '@cae/decks/context';
import { partAdequacy } from '@cae/results/adequacy';
import { partRestraints } from '@cae/results/restraint';
import { quadMetrics, tetMetrics, triMetrics } from '@cae/results/verdict';
import { withCase } from '@cae/shared/access';
import { X0_NODES, barDocument, barMesh, mustRun } from './deckFixtures';
import { caseIn } from './helpers';

const ORIGIN: Vec3 = [0, 0, 0];

describe('verdict metrics on degenerate elements', () => {
  it('a collapsed tetrahedron has zero Jacobian, an unbounded aspect and edge ratio, no volume', () => {
    const tet = tetMetrics(ORIGIN, ORIGIN, ORIGIN, ORIGIN);
    expect(tet.scaledJacobian).toBe(0);
    expect(tet.volume).toBe(0);
    expect(tet.aspectRatio).toBe(Number.MAX_SAFE_INTEGER);
    expect(tet.edgeRatio).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('a flat tetrahedron (four coplanar points) is not inverted-looking but has no inradius', () => {
    const flat = tetMetrics([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]);
    expect(flat.scaledJacobian).toBe(0);
    expect(flat.aspectRatio).toBe(Number.MAX_SAFE_INTEGER);
    expect(flat.edgeRatio).toBeGreaterThan(1);
  });

  it('a regular tetrahedron reads 1 and its mirror image is inverted', () => {
    const a: Vec3 = [1, 1, 1];
    const b: Vec3 = [1, -1, -1];
    const c: Vec3 = [-1, 1, -1];
    const d: Vec3 = [-1, -1, 1];
    expect(Math.abs(tetMetrics(a, b, c, d).scaledJacobian)).toBeCloseTo(1, 12);
    expect(tetMetrics(a, b, c, d).scaledJacobian * tetMetrics(a, c, b, d).scaledJacobian).toBeLessThan(0);
  });

  it('a triangle with coincident corners has angle 0 and area 0; a right isosceles one has minimum angle 45', () => {
    expect(triMetrics(ORIGIN, ORIGIN, ORIGIN)).toEqual({ minAngleDeg: 0, area: 0 });
    expect(triMetrics([0, 0, 0], [1, 0, 0], [0, 1, 0]).minAngleDeg).toBeCloseTo(45, 9);
  });

  it('a collapsed quadrilateral has no Jacobian, skew or warpage to speak of and a huge aspect ratio is not reported as NaN', () => {
    const collapsed = quadMetrics(ORIGIN, ORIGIN, ORIGIN, ORIGIN);
    for (const value of Object.values(collapsed)) expect(Number.isNaN(value)).toBe(false);
    expect(collapsed.scaledJacobian).toBe(0);
    const square = quadMetrics([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    expect(square).toMatchObject({ aspectRatio: 1, scaledJacobian: 1, skew: 0, warpage: 0 });
    const bowtie = quadMetrics([0, 0, 0], [2, 0, 0], [0.5, 0.25, 0], [0, 2, 0]);
    expect(bowtie.scaledJacobian).toBeLessThan(0);
  });
});

describe('partAdequacy on odd meshes', () => {
  const bar = barDocument();
  const base = barMesh(bar.doc, bar.analysisId, bar.boxId, {});

  it('skips elements with an unknown node and parts left without a valid element', () => {
    const broken: FeMeshArtifact = {
      ...base,
      blocks: [
        { type: 'C3D4', entityId: 'ghost', elements: [[1, 1, 2, 4, 99]] },
        {
          type: 'C3D4',
          entityId: bar.boxId,
          elements: [
            [2, 1, 2, 4, 8],
            [3, 1, 2, 4],
          ],
        },
      ],
    };
    expect(partAdequacy(broken).map((part) => part.entityId)).toEqual([bar.boxId]);
  });

  it('coincident corner nodes give a zero mean edge and an unbounded element count', () => {
    const squashed: FeMeshArtifact = { ...base, nodes: base.nodes.map((node) => [node[0], 0, 0, 0] as const) };
    expect(partAdequacy(squashed)[0]).toMatchObject({ meanEdge: 0, thinnestExtent: 0, elementsAcross: Number.MAX_SAFE_INTEGER });
  });
});

describe('partRestraints on odd supports', () => {
  const bar = barDocument({ supports: false });
  const withConstraints = (extra: readonly Record<string, unknown>[]): { doc: ReturnType<typeof barDocument>['doc']; ids: string[] } => {
    let doc = bar.doc;
    for (const params of extra)
      doc = mustRun(doc, 'add_fea_constraint', {
        analysisId: bar.analysisId,
        target: { entityId: bar.boxId, facesNear: [[0, 0.5, 0.5]] },
        ...params,
      });
    return { doc, ids: [...caseIn(doc, bar.analysisId).constraintOrder] };
  };
  const rankOf = (doc: typeof bar.doc, nodeSets: Record<string, readonly number[]>): { rank: number; restrainedDofs: number }[] => {
    const ctx = buildDeckContext(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, nodeSets));
    if (ctx === null) throw new Error('no context');
    return partRestraints(ctx).map(({ rank, restrainedDofs }) => ({ rank, restrainedDofs }));
  };

  it('a pinned face removes all six motions; unresolved sets and unknown nodes are ignored', () => {
    const { doc, ids } = withConstraints([
      { name: 'p', kind: 'pinned' },
      { name: 'lost', kind: 'fixed' },
      { name: 'ghost', kind: 'fixed' },
    ]);
    expect(rankOf(doc, { [`C_${ids[0]}`]: X0_NODES, [`C_${ids[1]}`]: [], [`C_${ids[2]}`]: [999] })).toEqual([
      { rank: 6, restrainedDofs: 12 },
    ]);
  });

  it('a symmetry plane that is not axis aligned restrains nothing; a rotational dof is not a translation restraint', () => {
    const { doc, ids } = withConstraints([
      { name: 's', kind: 'symmetry' },
      { name: 'd', kind: 'displacement', dofs: { ux: 0, rx: 0 } },
    ]);
    const result = rankOf(doc, { [`C_${ids[0]}`]: [1, 4, 6], [`C_${ids[1]}`]: [1] });
    expect(result[0]?.restrainedDofs).toBe(1);
    expect(result[0]?.rank).toBe(1);
  });

  it('a part with no restraint has rank 0 and parts sharing nodes form one group', () => {
    const { doc } = withConstraints([]);
    expect(rankOf(doc, {})).toEqual([{ rank: 0, restrainedDofs: 0 }]);
    const second = withCase(doc, {
      ...caseIn(doc, bar.analysisId),
      parts: { ...caseIn(doc, bar.analysisId).parts, other: { kind: 'solid' } },
    });
    const base = barMesh(second, bar.analysisId, bar.boxId, {});
    const shared: FeMeshArtifact = { ...base, blocks: [...base.blocks, { type: 'C3D4', entityId: 'other', elements: [[7, 1, 2, 4, 8]] }] };
    const ctx = buildDeckContext(second, bar.analysisId, shared);
    expect(ctx === null ? [] : partRestraints(ctx).map((group) => group.entityIds)).toEqual([[bar.boxId, 'other']]);
    const lone: FeMeshArtifact = {
      ...base,
      blocks: [...base.blocks, { type: 'C3D4', entityId: 'other', elements: [[7, 1, 2, 4, 8]] }].slice(0, 1),
    };
    const loneCtx = buildDeckContext(second, bar.analysisId, lone);
    expect(loneCtx === null ? [] : partRestraints(loneCtx).map((group) => group.entityIds)).toEqual([[bar.boxId], ['other']]);
  });
});
