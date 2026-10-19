/** Moment loads and area-consistent force splitting (05 §5.6, FR-FEA-08): add / update commands, the nodal couple and the deck lines. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { buildDeckContext } from '@cae/decks/context';
import { consistentWeights, momentForces } from '@cae/decks/loadDistribution';
import { writeInp } from '@cae/decks/inpWriter';
import { BAR_NODES, X0_NODES, X2_NODES, barDocument, barMesh, facesOn, mustRun } from './deckFixtures';
import { caseIn } from './helpers';

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const FACE_END = { entityId: 'x', facesNear: [[2, 0.5, 0.5]] };

/** The `*CLOAD` lines of a deck as node -> [fx, fy, fz]. */
function cloads(text: string): Map<number, Vec3> {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('*CLOAD'));
  const out = new Map<number, Vec3>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('*')) break;
    const [node, dof, value] = line.split(',').map((part) => Number(part.trim())) as [number, number, number];
    const entry: [number, number, number] = [...(out.get(node) ?? [0, 0, 0])] as [number, number, number];
    entry[dof - 1] = value;
    out.set(node, entry);
  }
  return out;
}

const deckText = (written: ReturnType<typeof writeInp>): string => ('text' in written ? written.text : JSON.stringify(written));

describe('moment loads: add_fea_load / update_fea_load', () => {
  const { doc, analysisId, boxId } = barDocument();
  const target = { ...FACE_END, entityId: boxId };

  it('adds a moment on a face, an edge or three points, and stores only its own fields', () => {
    const added = execute(doc, 'add_fea_load', { analysisId, name: 'torque', kind: 'moment', vector: [0, 0, 50], target });
    expect(added.rejected).not.toBe(true);
    const stored = caseIn(added.document, analysisId).loads[added.affected[0] ?? ''];
    expect(stored).toMatchObject({ kind: 'moment', vector: [0, 0, 50], loadCase: 'LC1', category: 'limit' });
    expect(stored).not.toHaveProperty('distribution');
    expect(added.summary).toContain('moment [0, 0, 50]');
    for (const near of [
      { edgesNear: [[2, 0, 0]] },
      {
        pointsNear: [
          [2, 0, 0],
          [2, 1, 0],
          [2, 1, 1],
        ],
      },
    ])
      expect(
        execute(doc, 'add_fea_load', { analysisId, name: 'm', kind: 'moment', vector: [1, 0, 0], target: { entityId: boxId, ...near } })
          .rejected,
      ).not.toBe(true);
  });

  it('refuses a moment without a vector, with a zero vector, on a single point, or with fields it does not use', () => {
    const refuse = (params: Record<string, unknown>): string | undefined =>
      execute(doc, 'add_fea_load', { analysisId, name: 'm', kind: 'moment', target, ...params }).error?.code;
    expect(refuse({})).toBe('FEA_LOAD_INVALID');
    expect(refuse({ vector: [0, 0, 0] })).toBe('FEA_LOAD_INVALID');
    expect(refuse({ vector: [0, 0, 1], target: { entityId: boxId, pointsNear: [[2, 0, 0]] } })).toBe('FEA_LOAD_INVALID');
    expect(refuse({ vector: [0, 0, 1], distribution: 'per_node' })).toBe('FEA_LOAD_INVALID');
    expect(refuse({ vector: [0, 0, 1], magnitude: 3 })).toBe('FEA_LOAD_INVALID');
  });

  it('updates the vector of an existing moment', () => {
    const added = execute(doc, 'add_fea_load', { analysisId, name: 'torque', kind: 'moment', vector: [0, 0, 50], target });
    const loadId = added.affected[0] ?? '';
    const updated = execute(added.document, 'update_fea_load', { analysisId, loadId, vector: [0, 10, 0] });
    expect(updated.rejected).not.toBe(true);
    expect(caseIn(updated.document, analysisId).loads[loadId]?.vector).toEqual([0, 10, 0]);
  });
});

describe('momentForces: a statically equivalent couple', () => {
  const mesh = (nodes: FeMeshArtifact['nodes']): FeMeshArtifact => ({
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: 'x',
    nodes,
    blocks: [],
    nodeSets: {},
    faceSets: {},
    targets: {},
  });
  const resultant = (forces: ReadonlyMap<number, Vec3>, nodes: FeMeshArtifact['nodes']): { force: Vec3; moment: Vec3 } => {
    let force: Vec3 = [0, 0, 0];
    let moment: Vec3 = [0, 0, 0];
    for (const [id, f] of forces) {
      const node = nodes.find((candidate) => candidate[0] === id) as FeMeshArtifact['nodes'][number];
      const p: Vec3 = [node[1], node[2], node[3]];
      force = [force[0] + f[0], force[1] + f[1], force[2] + f[2]];
      const arm = cross(p, f);
      moment = [moment[0] + arm[0], moment[1] + arm[1], moment[2] + arm[2]];
    }
    return { force, moment };
  };
  const plate: FeMeshArtifact['nodes'] = [
    [1, 3, 0, 0],
    [2, 3, 2, 0],
    [3, 3, 2, 1],
    [4, 3, 0, 1],
    [5, 3, 1, 0.5],
  ];

  it.each([
    ['about the plate normal', [40, 0, 0]],
    ['about an in-plane axis', [0, 30, 0]],
    ['general', [10, -20, 5]],
  ] as const)('%s: zero resultant force and the exact moment', (_name, moment) => {
    const forces = momentForces(mesh(plate), [1, 2, 3, 4, 5], moment);
    expect('forces' in forces).toBe(true);
    if (!('forces' in forces)) return;
    const { force, moment: achieved } = resultant(forces.forces, plate);
    force.forEach((component) => expect(component).toBeCloseTo(0, 9));
    achieved.forEach((component, axis) => expect(component).toBeCloseTo(moment[axis] ?? 0, 7));
  });

  it('refuses one node, collinear nodes (moment about their line) and unknown nodes; a perpendicular moment on collinear nodes is carried', () => {
    expect(momentForces(mesh(plate), [1], [1, 0, 0])).toMatchObject({ refusal: expect.stringContaining('at least 2 nodes') });
    expect(momentForces(mesh(plate), [1, 99], [1, 0, 0])).toMatchObject({ refusal: expect.stringContaining('found 1') });
    const line: FeMeshArtifact['nodes'] = [
      [1, 0, 0, 0],
      [2, 0, 1, 0],
      [3, 0, 2, 0],
    ];
    expect(momentForces(mesh(line), [1, 2, 3], [0, 5, 0])).toMatchObject({ refusal: expect.stringContaining('collinear') });
    const carried = momentForces(mesh(line), [1, 2, 3], [5, 0, 0]);
    expect('forces' in carried).toBe(true);
    if ('forces' in carried) expect(resultant(carried.forces, line).moment[0]).toBeCloseTo(5, 9);
  });
});

describe('moment loads in the deck', () => {
  const bar = barDocument();
  const added = mustRun(bar.doc, 'add_fea_load', {
    analysisId: bar.analysisId,
    name: 'torque',
    kind: 'moment',
    vector: [0, 0, 50],
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  });
  const loadId = Object.keys(caseIn(added, bar.analysisId).loads)[0] ?? '';
  const sets = {
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
    [`L_${loadId}`]: X2_NODES,
  };

  it('writes a *CLOAD couple on the target nodes: no net force, the requested moment about the face centre', () => {
    const text = deckText(writeInp(added, bar.analysisId, barMesh(added, bar.analysisId, bar.boxId, sets)));
    const forces = cloads(text);
    expect([...forces.keys()].sort()).toEqual(X2_NODES);
    let total: Vec3 = [0, 0, 0];
    let moment: Vec3 = [0, 0, 0];
    for (const [id, force] of forces) {
      const node = BAR_NODES.find((candidate) => candidate[0] === id) as FeMeshArtifact['nodes'][number];
      total = [total[0] + force[0], total[1] + force[1], total[2] + force[2]];
      const arm = cross([node[1] - 2, node[2] - 0.5, node[3] - 0.5], force);
      moment = [moment[0] + arm[0], moment[1] + arm[1], moment[2] + arm[2]];
    }
    total.forEach((component) => expect(component).toBeCloseTo(0, 9));
    expect(moment[0]).toBeCloseTo(0, 9);
    expect(moment[1]).toBeCloseTo(0, 9);
    expect(moment[2]).toBeCloseTo(50, 7);
  });

  it('refuses a moment whose target has no nodes, or only one node', () => {
    const none = writeInp(added, bar.analysisId, barMesh(added, bar.analysisId, bar.boxId, { ...sets, [`L_${loadId}`]: [] }));
    expect(none).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
    const single = writeInp(added, bar.analysisId, barMesh(added, bar.analysisId, bar.boxId, { ...sets, [`L_${loadId}`]: [2] }));
    expect(single).toMatchObject({ code: 'FEA_LOAD_INVALID' });
    expect('message' in single && single.message).toContain('at least 2 nodes');
  });
});

describe('area-consistent force splitting', () => {
  const bar = barDocument();
  const loaded = (distribution?: 'per_node'): { doc: ReturnType<typeof barDocument>['doc']; loadId: string } => {
    const doc = mustRun(bar.doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'pull',
      kind: 'force',
      vector: [100, 0, 0],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
      ...(distribution === undefined ? {} : { distribution }),
    });
    return { doc, loadId: Object.keys(caseIn(doc, bar.analysisId).loads)[0] ?? '' };
  };
  const supports = (): Record<string, number[]> => ({
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
  });

  it('with the face set of the target: each node gets its area share (diagonal nodes 1/3, the others 1/6 of the force)', () => {
    const { doc, loadId } = loaded();
    const mesh = barMesh(
      doc,
      bar.analysisId,
      bar.boxId,
      { ...supports(), [`L_${loadId}`]: X2_NODES },
      { [`L_${loadId}`]: facesOn(X2_NODES) },
    );
    const forces = cloads(deckText(writeInp(doc, bar.analysisId, mesh)));
    const values = [...forces.values()].map((force) => force[0]).sort((a, b) => a - b);
    expect(values.map((value) => Number(value.toFixed(6)))).toEqual([16.666667, 16.666667, 33.333333, 33.333333]);
    expect(values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 9);
  });

  it('without a face set (edges, points) or with per_node, the equal split / per-node load is unchanged', () => {
    const { doc, loadId } = loaded();
    const equal = cloads(
      deckText(writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, { ...supports(), [`L_${loadId}`]: X2_NODES }))),
    );
    expect([...equal.values()].map((force) => force[0])).toEqual([25, 25, 25, 25]);
    const perNode = loaded('per_node');
    const mesh = barMesh(
      perNode.doc,
      bar.analysisId,
      bar.boxId,
      { ...supports(), [`L_${perNode.loadId}`]: X2_NODES },
      { [`L_${perNode.loadId}`]: facesOn(X2_NODES) },
    );
    expect([...cloads(deckText(writeInp(perNode.doc, bar.analysisId, mesh))).values()].map((force) => force[0])).toEqual([
      100, 100, 100, 100,
    ]);
  });
});

describe('consistentWeights', () => {
  const doc = barDocument();
  /** One C3D10 tetrahedron: corners 1-4, mid-edge nodes 5 = 1-2, 6 = 2-3, 7 = 3-1, 8 = 1-4, 9 = 2-4, 10 = 3-4. */
  const quadratic = (faces: FeMeshArtifact['faceSets'][string], type: 'C3D10' | 'C3D4' = 'C3D10'): ReturnType<typeof contextOf> => {
    const corners: [number, number, number, number][] = [
      [1, 0, 0, 0],
      [2, 2, 0, 0],
      [3, 0, 2, 0],
      [4, 0, 0, 2],
    ];
    const mid = (id: number, a: number, b: number): [number, number, number, number] => {
      const [pa, pb] = [corners[a - 1] as number[], corners[b - 1] as number[]];
      return [id, ((pa[1] ?? 0) + (pb[1] ?? 0)) / 2, ((pa[2] ?? 0) + (pb[2] ?? 0)) / 2, ((pa[3] ?? 0) + (pb[3] ?? 0)) / 2];
    };
    const nodes = [...corners, mid(5, 1, 2), mid(6, 2, 3), mid(7, 3, 1), mid(8, 1, 4), mid(9, 2, 4), mid(10, 3, 4)];
    const mesh: FeMeshArtifact = {
      ...barMesh(doc.doc, doc.analysisId, doc.boxId, {}, { L_a: faces }),
      nodes,
      blocks: [{ type, entityId: doc.boxId, elements: [type === 'C3D10' ? [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1, 1, 2, 3, 4]] }],
    };
    return contextOf(mesh);
  };
  const contextOf = (mesh: FeMeshArtifact): NonNullable<ReturnType<typeof buildDeckContext>> => {
    const built = buildDeckContext(doc.doc, doc.analysisId, mesh);
    if (built === null) throw new Error('no context');
    return built;
  };

  it('a quadratic face loads its three mid-edge nodes equally and the corners not at all', () => {
    const weights = consistentWeights(quadratic([[1, 1]]), 'L_a');
    expect([...(weights ?? [])].sort((a, b) => a[0] - b[0]).map(([node, share]) => [node, Number(share.toFixed(9))])).toEqual([
      [5, 0.333333333],
      [6, 0.333333333],
      [7, 0.333333333],
    ]);
  });

  it('every face label maps to its own mid-edge nodes (S2 = 1-4-2 -> 8, 9, 5; S3 = 2-4-3 -> 9, 10, 6; S4 = 3-4-1 -> 10, 8, 7)', () => {
    const nodesOf = (label: number): number[] =>
      [...(consistentWeights(quadratic([[1, label]]), 'L_a')?.keys() ?? [])].sort((a, b) => a - b);
    expect(nodesOf(2)).toEqual([5, 8, 9]);
    expect(nodesOf(3)).toEqual([6, 9, 10]);
    expect(nodesOf(4)).toEqual([7, 8, 10]);
  });

  it('shares are proportional to the face areas: a linear face gives its corners A / 3', () => {
    const weights = consistentWeights(
      quadratic(
        [
          [1, 1],
          [1, 3],
        ],
        'C3D4',
      ),
      'L_a',
    );
    const total = [...(weights?.values() ?? [])].reduce((sum, share) => sum + share, 0);
    expect(total).toBeCloseTo(1, 12);
    // S1 = corners 1-2-3 (legs 2, 2: area 2), S3 = corners 2-4-3 (equilateral, side 2 sqrt 2: area 2 sqrt 3)
    const [s1, s3] = [2, 2 * Math.sqrt(3)];
    expect(weights?.get(1)).toBeCloseTo(s1 / 3 / (s1 + s3), 12);
    expect(weights?.get(2)).toBeCloseTo((s1 / 3 + s3 / 3) / (s1 + s3), 12);
    expect(weights?.get(4)).toBeCloseTo(s3 / 3 / (s1 + s3), 12);
  });

  it('is null without faces, for an unknown element, an invalid face label, or a face over a missing node', () => {
    expect(consistentWeights(quadratic([]), 'L_a')).toBeNull();
    expect(consistentWeights(quadratic([[99, 1]]), 'L_a')).toBeNull();
    expect(consistentWeights(quadratic([[1, 7]]), 'L_a')).toBeNull();
    const ctx = quadratic([[1, 1]]);
    expect(consistentWeights({ ...ctx, mesh: { ...ctx.mesh, nodes: ctx.mesh.nodes.slice(0, 2) } }, 'L_a')).toBeNull();
    const short = quadratic([[1, 1]], 'C3D4');
    expect(
      consistentWeights(
        { ...short, mesh: { ...short.mesh, blocks: [{ type: 'C3D10', entityId: 'x', elements: [[1, 1, 2, 3, 4]] }] } },
        'L_a',
      ),
    ).toBeNull();
    const flat = quadratic([[1, 1]]);
    expect(
      consistentWeights(
        {
          ...flat,
          mesh: {
            ...flat.mesh,
            nodes: flat.mesh.nodes.map((node) => (node[0] <= 3 ? [node[0], 0, 0, 0] : node) as FeMeshArtifact['nodes'][number]),
          },
        },
        'L_a',
      ),
    ).toBeNull();
  });
});
