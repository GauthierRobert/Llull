import { afterEach, describe, expect, it } from 'vitest';
import { type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import type { EdgeRadius } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import { kernelFromOps, type FaceQueryOps } from '@core/geometry/shapeKernel';
import { chordToRadius, wedgeAngle } from '@core/commands/brep/filletSpec';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { TETRA } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const edge = (index: number, at: number, seam = false): ShapeTopology['edges'][number] => ({
  index,
  curve: 'line',
  length: 2,
  start: [at, 0, 0],
  end: [at, 2, 0],
  mid: [at, 1, 0],
  seam,
  degenerate: false,
});

const S3 = Math.sqrt(3) / 2;
const TOPOLOGY: ShapeTopology = {
  solids: 1,
  faces: [
    { index: 0, surface: 'plane', area: 4, normal: [1, 0, 0] },
    { index: 1, surface: 'plane', area: 4, normal: [0, 0, 1] },
    { index: 2, surface: 'plane', area: 4, normal: [-0.5, 0, S3] },
    { index: 3, surface: 'cylinder', area: 4 },
  ],
  edges: [edge(0, 0), edge(1, 10), edge(2, 20), edge(3, 30, true)],
  vertices: 8,
  volume: 8,
};
const GRAPH = {
  faces: [],
  edgeFaces: [[0, 1], [0, 2], [1, 3], [0]],
  edgeConvexity: ['convex', 'convex', 'convex', 'unknown'],
} as unknown as FaceGraph;

interface Calls {
  fillet: Array<{ edges: readonly number[]; radius: number; radiusEnd: number | undefined }>;
  each: Array<{ edges: readonly number[]; laws: readonly EdgeRadius[] }>;
}

function kernelWith(options: { each?: boolean; graph?: boolean } = {}): { kernel: ReturnType<typeof kernelFromOps>; calls: Calls } {
  const calls: Calls = { fillet: [], each: [] };
  const shape = { mesh: TETRA };
  const kernel = kernelFromOps<typeof shape>({
    solid: () => shape,
    boolean: () => null,
    fillet: (_s, edges, radius, radiusEnd) => {
      calls.fillet.push({ edges, radius, radiusEnd });
      return { mesh: TETRA };
    },
    ...(options.each === true
      ? {
          filletEach: (_s: typeof shape, edges: readonly number[], laws: readonly EdgeRadius[]) => {
            calls.each.push({ edges, laws });
            return { mesh: TETRA };
          },
        }
      : {}),
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (s) => s,
    scale: (s) => s,
    tessellate: (s) => s.mesh,
    topology: () => TOPOLOGY,
    exportStep: () => null,
    release: () => undefined,
    ...(options.graph === false ? {} : { faceQuery: { faceGraph: () => GRAPH } as unknown as FaceQueryOps<typeof shape> }),
  });
  return { kernel, calls };
}

const box = (): { doc: ReturnType<typeof createEmptyDocument>; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  return { doc: made.document, id: made.affected[0] as string };
};

const run = (
  kernel: ReturnType<typeof kernelWith>['kernel'],
  doc: ReturnType<typeof createEmptyDocument>,
  params: unknown,
): ReturnType<typeof execute> => execute(doc, 'fillet_edge', params, { ...defaultContext(), kernel });

describe('chord <-> radius conversion', () => {
  it('right-angle edge: chord = r sqrt 2; 60 degree wedge: chord = r sqrt 3; analytic round trip', () => {
    expect(wedgeAngle([1, 0, 0], [0, 0, 1])).toBeCloseTo(Math.PI / 2, 12);
    expect(chordToRadius(Math.SQRT2, Math.PI / 2)).toBeCloseTo(1, 12);
    expect(wedgeAngle([1, 0, 0], [-0.5, 0, S3])).toBeCloseTo(Math.PI / 3, 12);
    expect(chordToRadius(Math.sqrt(3), Math.PI / 3)).toBeCloseTo(1, 12);
    for (const wedge of [0.4, 1, 2, 3]) {
      const radius = 1.7;
      expect(2 * radius * Math.cos(wedge / 2)).toBeCloseTo(
        chordToRadius(2 * radius * Math.cos(wedge / 2), wedge) * 2 * Math.cos(wedge / 2),
        12,
      );
    }
    expect(chordToRadius(1, 0)).toBeNaN();
    expect(chordToRadius(1, Math.PI)).toBeNaN();
  });
});

describe('fillet_edge edges: per-edge radii', () => {
  it('differing radii are one fillet node with a radius law per edge (index and near entries)', () => {
    const { kernel, calls } = kernelWith({ each: true });
    const { doc, id } = box();
    const result = run(kernel, doc, {
      id,
      edges: [
        { index: 0, size: 0.5 },
        { near: [10, 0.5, 0], size: 0.2, sizeEnd: 0.4 },
        { index: 2, size: 0.3, sizes: [{ t: 0.5, size: 0.6 }] },
      ],
    });
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const mesh = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({
      op: 'fillet',
      edges: [0, 1, 2],
      size: 0,
      radii: [{ size: 0.5 }, { size: 0.2, sizeEnd: 0.4 }, { size: 0.3, sizes: [{ t: 0.5, size: 0.6 }] }],
    });
    expect(calls.each).toHaveLength(1);
    expect(calls.each[0]?.edges).toEqual([0, 1, 2]);
    expect(result.summary).toContain('3 edge(s)');
    expectPure(doc, () =>
      run(kernel, doc, {
        id,
        edges: [
          { index: 0, size: 0.5 },
          { index: 1, size: 0.1 },
        ],
      }),
    );
  });

  it('equal laws collapse to the single-size recipe every exact kernel reads', () => {
    const { kernel, calls } = kernelWith();
    const { doc, id } = box();
    const result = run(kernel, doc, {
      id,
      edges: [
        { index: 0, size: 0.4, sizeEnd: 0.6 },
        { index: 1, size: 0.4, sizeEnd: 0.6 },
      ],
    });
    const mesh = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({ op: 'fillet', edges: [0, 1], size: 0.4, sizeEnd: 0.6 });
    expect(mesh.brep).not.toHaveProperty('radii');
    expect(calls.fillet).toEqual([{ edges: [0, 1], radius: 0.4, radiusEnd: 0.6 }]);
  });

  it('a kernel without per-edge radii refuses differing laws without changing the document', () => {
    const { kernel } = kernelWith();
    const { doc, id } = box();
    const result = run(kernel, doc, {
      id,
      edges: [
        { index: 0, size: 0.4 },
        { index: 1, size: 0.1 },
      ],
    });
    expectNoOp(result, doc, 'per-edge radii');
  });

  it('refuses malformed entries, duplicates, seams, mixed shorthand and unknown targets', () => {
    const { kernel } = kernelWith({ each: true });
    const { doc, id } = box();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ edges: [{ size: 0.2 }] }, 'exactly one of index or near'],
      [{ edges: [{ index: 0, near: [0, 0, 0], size: 0.2 }] }, 'exactly one of index or near'],
      [{ edges: [{ index: 0, size: -1 }] }, 'size must be > 0'],
      [
        {
          edges: [
            {
              index: 0,
              size: 1,
              sizes: [
                { t: 0.6, size: 1 },
                { t: 0.4, size: 1 },
              ],
            },
          ],
        },
        'strictly increasing',
      ],
      [
        {
          edges: [
            { index: 0, size: 1 },
            { near: [0, 1, 0], size: 2 },
          ],
        },
        'already given',
      ],
      [{ edges: [{ index: 3, size: 1 }] }, 'seam'],
      [{ edges: [{ index: 9, size: 1 }] }, 'out of range'],
      [{ edges: [] }, 'must not be empty'],
      [{ edges: [{ index: 0, size: 1 }], radius: 1 }, 'not both'],
    ];
    for (const [extra, message] of cases) expectNoOp(run(kernel, doc, { id, ...extra }), doc, message);
    expectNoOp(run(kernel, doc, { id: 'missing', edges: [{ index: 0, size: 1 }] }), doc, 'not found');
    expectNoOp(execute(doc, 'fillet_edge', { id, edges: [{ index: 0, size: 1 }] }, { ...defaultContext(), kernel: null }), doc);
    expectNoOp(run(kernel, doc, { id }), doc, 'give radius');
  });
});

describe('fillet_edge mode chord', () => {
  it('converts each chord to a radius from the wedge angle of the two planar faces', () => {
    const { kernel, calls } = kernelWith({ each: true });
    const { doc, id } = box();
    const result = run(kernel, doc, {
      id,
      mode: 'chord',
      edges: [
        { index: 0, size: Math.SQRT2 },
        { index: 1, size: Math.sqrt(3) },
      ],
    });
    expect(result.affected).toHaveLength(1);
    const laws = calls.each[0]?.laws ?? [];
    expect(laws[0]?.size).toBeCloseTo(1, 9);
    expect(laws[1]?.size).toBeCloseTo(1, 9);
    expect(result.summary).toContain('chord lengths');
  });

  it('shorthand radius in chord mode rounds every roundable edge with a converted radius', () => {
    const { kernel, calls } = kernelWith();
    const { doc, id } = box();
    const result = run(kernel, doc, { id, mode: 'chord', edgeIndices: [0], radius: 2 * Math.SQRT2 });
    expect(result.affected).toHaveLength(1);
    expect(calls.fillet[0]?.radius).toBeCloseTo(2, 9);
  });

  it('refuses an edge without two planar faces, a missing face graph and a flat wedge', () => {
    const { doc, id } = box();
    expectNoOp(run(kernelWith({ each: true }).kernel, doc, { id, mode: 'chord', edges: [{ index: 2, size: 1 }] }), doc, 'two planar faces');
    expectNoOp(run(kernelWith({ graph: false }).kernel, doc, { id, mode: 'chord', edges: [{ index: 0, size: 1 }] }), doc, 'face adjacency');
  });
});

describe('fillet recipe validation (untrusted documents)', () => {
  const source = {
    op: 'solid',
    entity: { id: 'b', kind: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], layerId: '0', color: '#fff' },
  };
  const node = (extra: Record<string, unknown>): unknown => ({ op: 'fillet', source, edges: [0, 1], size: 0, ...extra });
  it('accepts matching per-edge laws and rejects the malformed ones', () => {
    expect(validateShapeRecipe(node({ radii: [{ size: 1 }, { size: 2, sizeEnd: 3, sizes: [{ t: 0.5, size: 1 }] }] }))).toBeNull();
    const bad: unknown[] = [
      node({ radii: [{ size: 1 }] }),
      node({ radii: [{ size: 1 }, { size: 0 }] }),
      node({ radii: [{ size: 1 }, { size: 1, sizeEnd: -1 }] }),
      node({ radii: [{ size: 1 }, { size: 1, sizes: [{ t: 1, size: 1 }] }] }),
      node({ radii: [{ size: 1 }, { size: 1, sizes: 4 }] }),
      node({ radii: 'x' }),
      { ...(node({ radii: [{ size: 1 }, { size: 1 }] }) as object), op: 'chamfer' },
      node({}),
    ];
    for (const recipe of bad) expect(validateShapeRecipe(recipe)).not.toBeNull();
  });
});
