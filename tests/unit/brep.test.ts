/**
 * Exact-shape commands over the fake shape kernel: inspect_topology, export_step_exact, kernel results
 * carrying their brep recipe, the triangle fallback, scale on a brep, and brep validation on load.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { type CadDocument, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { serializeDocument } from '@core/commands/persistence';
import { setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import { fakeKernel, TETRA } from '../helpers/fakeKernel';

const TOPOLOGY: ShapeTopology = {
  solids: 1,
  faces: [
    { index: 0, surface: 'plane', area: 4 },
    { index: 1, surface: 'cylinder', area: 6.28 },
  ],
  edges: Array.from({ length: 30 }, (_, index) => ({
    index,
    curve: index === 0 ? ('circle' as const) : ('line' as const),
    length: 2,
    start: [0, 0, 0] as const,
    end: [2, 0, 0] as const,
    mid: [1, 0, 0] as const,
    seam: index === 29,
    degenerate: false,
  })),
  vertices: 8,
  volume: 8,
};

afterEach(() => setGeometryKernel(null));

function twoBoxes(): { doc: CadDocument; a: string; b: string; line: string } {
  const first = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const second = execute(first.document, 'add_box', { size: [1, 1, 1], position: [1, 0, 0] });
  const line = execute(second.document, 'draw_line', { start: [0, 0], end: [1, 0] });
  return {
    doc: line.document,
    a: first.affected[0]!,
    b: second.affected[0]!,
    line: line.affected[0]!,
  };
}

const run = (
  doc: CadDocument,
  name: string,
  params: unknown,
  kernel: GeometryKernel | null,
): ReturnType<typeof execute> => execute(doc, name, params, { ...defaultContext(), kernel });

describe('kernel results keep their exact construction', () => {
  it('boolean_union stores the boolean recipe of both exact operands and reports the topology', () => {
    const { doc, a, b } = twoBoxes();
    const kernel = fakeKernel({ boolean: TETRA, topology: TOPOLOGY });
    const result = run(doc, 'boolean_union', { a, b }, kernel);
    const mesh = result.document.entities[result.affected[0]!] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({
      op: 'boolean',
      boolean: 'union',
      a: { op: 'solid', entity: { id: a, kind: 'box' } },
      b: { op: 'solid', entity: { id: b, kind: 'box' } },
    });
    expect(result.summary).toContain('Exact B-rep kept: 2 faces, 30 edges');
  });

  it('a fillet on a boolean result builds on its recipe, not on its triangles', () => {
    const { doc, a, b } = twoBoxes();
    const kernel = fakeKernel({ boolean: TETRA, fillet: TETRA });
    const unioned = run(doc, 'boolean_union', { a, b }, kernel);
    const id = unioned.affected[0]!;
    const filleted = run(
      unioned.document,
      'fillet_edge',
      { id, edgeIndices: [3], radius: 0.2 },
      kernel,
    );
    const mesh = filleted.document.entities[filleted.affected[0]!] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({
      op: 'fillet',
      edges: [3],
      size: 0.2,
      source: { op: 'boolean' },
    });
    expect(kernel.calls.at(-1)).toMatchObject({ op: 'fillet', edges: [3], size: 0.2 });
  });

  it('falls back to the stored triangles when this kernel cannot rebuild the exact tree', () => {
    const { doc, a, b } = twoBoxes();
    const filleted = run(doc, 'fillet_edge', { id: a, radius: 0.2 }, fakeKernel({ fillet: TETRA }));
    const id = filleted.affected[0]!;
    const meshOnly = fakeKernel({ boolean: TETRA, unsupported: ['fillet', 'chamfer', 'shell'] });
    const unioned = run(filleted.document, 'boolean_union', { a: id, b }, meshOnly);
    expect(unioned.summary).toContain(
      `This kernel cannot rebuild '${id}' (its exact tree needs fillet)`,
    );
    const mesh = unioned.document.entities[unioned.affected[0]!] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({
      op: 'boolean',
      a: { op: 'solid', entity: { id, kind: 'mesh' } },
    });
    const fallback = mesh.brep?.op === 'boolean' ? mesh.brep.a : null;
    expect(fallback?.op === 'solid' && 'brep' in fallback.entity).toBe(false);
  });

  it('a transient refusal of an exact tree never downgrades it to triangles', () => {
    const { doc, a, b } = twoBoxes();
    const filleted = run(doc, 'fillet_edge', { id: a, radius: 0.2 }, fakeKernel({ fillet: TETRA }));
    const id = filleted.affected[0]!;
    const flaky = fakeKernel({ boolean: TETRA, fillet: null });
    const unioned = run(filleted.document, 'boolean_union', { a: id, b }, flaky);
    expect(unioned.affected).toEqual([]);
    expect(unioned.summary).toMatch(/kernel returned null/);
  });

  it('fillet_edge checks edge indices against the exact topology', () => {
    const { doc, a } = twoBoxes();
    const kernel = fakeKernel({ fillet: TETRA, topology: TOPOLOGY });
    const cases: Array<[number[], RegExp]> = [
      [[0, 57], /edge index 57 out of range \(the solid has 30 edges, 0\.\.29/],
      [[3, 3], /edge index 3 selected twice/],
      [[29], /edge 29 is a seam or degenerate edge/],
    ];
    for (const [edgeIndices, message] of cases) {
      const result = run(doc, 'chamfer_edge', { id: a, edgeIndices, distance: 0.1 }, kernel);
      expect(result.summary).toMatch(message);
      expect(result.document).toBe(doc);
    }
    expect(
      run(doc, 'fillet_edge', { id: a, edgeIndices: [0, 28], radius: 0.1 }, kernel).affected,
    ).toHaveLength(1);
  });

  it('edgesNear picks the roundable edge with the nearest mid point and merges with indices', () => {
    const { doc, a } = twoBoxes();
    const near = TOPOLOGY.edges.map((edge, index) => ({ ...edge, mid: [index, 0, 0] as const }));
    const kernel = fakeKernel({ fillet: TETRA, topology: { ...TOPOLOGY, edges: near } });
    const result = run(
      doc,
      'fillet_edge',
      {
        id: a,
        edgeIndices: [2],
        edgesNear: [
          [7.2, 0.1, 0],
          [2.1, 0, 0],
          [40, 0, 0],
        ],
        radius: 0.1,
      },
      kernel,
    );
    expect(result.summary).toContain('edgesNear selected edges 2, 7, 28');
    const mesh = result.document.entities[result.affected[0]!] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({ op: 'fillet', edges: [2, 7, 28] });
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({
      edgesNear: [
        [7.2, 0.1, 0],
        [2.1, 0, 0],
        [40, 0, 0],
      ],
    });
  });

  it('edgesNear needs exact topology and a roundable edge', () => {
    const { doc, a } = twoBoxes();
    const params = { id: a, edgesNear: [[0, 0, 0]], distance: 0.1 };
    expect(run(doc, 'chamfer_edge', params, fakeKernel({ chamfer: TETRA })).summary).toMatch(
      /edgesNear needs the exact B-rep topology/,
    );
    const seamsOnly = {
      ...TOPOLOGY,
      edges: TOPOLOGY.edges.map((edge) => ({ ...edge, seam: true })),
    };
    expect(
      run(doc, 'chamfer_edge', params, fakeKernel({ chamfer: TETRA, topology: seamsOnly })).summary,
    ).toMatch(/found no roundable edge/);
  });

  it('fillet_edge on a component instance asks to explode it first', () => {
    const { doc, a } = twoBoxes();
    const instance = { ...doc.entities[a]!, id: 'inst', kind: 'instance', componentId: 'c' };
    const withInstance = {
      ...doc,
      entities: { ...doc.entities, inst: instance },
      order: [...doc.order, 'inst'],
    } as CadDocument;
    const result = run(withInstance, 'fillet_edge', { id: 'inst', radius: 0.1 }, fakeKernel());
    expect(result.summary).toMatch(/component instance; run explode_instance first/);
  });

  it('scale_entity on a kernel result scales its recipe too', () => {
    const { doc, a, b } = twoBoxes();
    const unioned = run(doc, 'boolean_union', { a, b }, fakeKernel({ boolean: TETRA }));
    const id = unioned.affected[0]!;
    const scaled = execute(unioned.document, 'scale_entity', { id, factor: 2 });
    const mesh = scaled.document.entities[id] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({ op: 'scale', factor: 2, source: { op: 'boolean' } });
    expect(mesh.mesh.positions[3]).toBe(2);
  });

  it('load_document rejects a malformed brep recipe', () => {
    const { doc, a, b } = twoBoxes();
    const unioned = run(doc, 'boolean_union', { a, b }, fakeKernel({ boolean: TETRA }));
    const id = unioned.affected[0]!;
    const broken = {
      ...unioned.document,
      entities: {
        ...unioned.document.entities,
        [id]: { ...unioned.document.entities[id]!, brep: { op: 'loft' } },
      },
    } as CadDocument;
    const loaded = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(broken),
    });
    expect(loaded.summary).toMatch(/brep recipe invalid — unknown recipe op 'loft'/);
    expect(loaded.affected).toEqual([]);
  });
});

describe('inspect_topology', () => {
  it('returns the exact faces and edges with fillet edge indices, document untouched', () => {
    const { doc, a } = twoBoxes();
    const before = JSON.stringify(doc);
    const result = run(doc, 'inspect_topology', { id: a }, fakeKernel({ topology: TOPOLOGY }));
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.data).toMatchObject({ entityId: a, solids: 1, vertices: 8 });
    expect(result.summary).toContain('2 faces (1 plane, 1 cylinder), 30 edges');
    expect(result.summary).toContain('#0 circle len 2 mid [1, 0, 0]');
    expect(result.summary).toContain('6 more in data.edges');
  });

  it.each([
    ['a missing id', { id: 'nope' }, /not found/],
    ['a 2D entity', 'line', /not a 3D solid/],
  ])('no-ops on %s', (_label, target, message) => {
    const { doc, line } = twoBoxes();
    const params = target === 'line' ? { id: line } : target;
    const result = run(doc, 'inspect_topology', params, fakeKernel({ topology: TOPOLOGY }));
    expect(result.summary).toMatch(message);
    expect(result.data).toBeUndefined();
  });

  it('refuses without a kernel, with a mesh-only kernel, and when the solid cannot be built', () => {
    const { doc, a } = twoBoxes();
    expect(run(doc, 'inspect_topology', { id: a }, null).summary).toMatch(/not available/);
    expect(run(doc, 'inspect_topology', { id: a }, fakeKernel()).summary).toMatch(/no exact B-rep/);
    expect(run(doc, 'inspect_topology', { id: a }, fakeKernel({ solid: null })).summary).toMatch(
      /could not build/,
    );
  });
});

describe('export_step_exact', () => {
  it('writes every 3D solid from its exact shape, document untouched', () => {
    const { doc, a, b } = twoBoxes();
    const result = run(doc, 'export_step_exact', {}, fakeKernel({ step: 'ISO-10303-21;' }));
    expect(result.document).toBe(doc);
    expect(result.data).toEqual({
      format: 'step',
      step: 'ISO-10303-21;',
      solidCount: 2,
      entityIds: [a, b],
      skipped: [],
    });
    expect(result.summary).toMatch(/2 exact solid\(s\).*13 bytes\.$/);
  });

  it('exports a subset and reports skipped ids', () => {
    const { doc, a, line } = twoBoxes();
    const result = run(
      doc,
      'export_step_exact',
      { entityIds: [a, line, 'ghost'] },
      fakeKernel({ step: 'S' }),
    );
    expect(result.data).toMatchObject({
      solidCount: 1,
      skipped: [`${line} (2D)`, 'ghost (not found)'],
    });
    expect(result.summary).toContain('skipped');
  });

  it('refuses: no kernel, no solids, a solid the kernel cannot build, a kernel without STEP', () => {
    const { doc, line } = twoBoxes();
    expect(run(doc, 'export_step_exact', {}, null).summary).toMatch(/not available/);
    expect(
      run(doc, 'export_step_exact', { entityIds: [line] }, fakeKernel({ step: 'S' })).summary,
    ).toMatch(/no 3D solids/);
    expect(
      run(doc, 'export_step_exact', {}, fakeKernel({ solid: null, step: 'S' })).summary,
    ).toMatch(/could not build/);
    expect(run(doc, 'export_step_exact', {}, fakeKernel()).summary).toMatch(
      /cannot write exact STEP/,
    );
  });
});
