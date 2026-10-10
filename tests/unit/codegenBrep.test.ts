/**
 * export_code of kernel results: fillet / chamfer / shell steps and `brep` recipes are emitted as their
 * exact construction (CadQuery / build123d / FreeCAD), OpenSCAD gets the result triangles, and
 * apply_code_trace accepts the recorded modification commands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type CadDocument, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type ShapeTopology as Topology, setGeometryKernel } from '@core/geometry/kernel';
import { fakeKernel, TETRA } from '../helpers/fakeKernel';

const TOPOLOGY: Topology = {
  solids: 1,
  faces: [],
  edges: [0, 1, 2].map((index) => ({
    index,
    curve: 'line' as const,
    length: 2,
    start: [0, 0, 0] as const,
    end: [2, 0, 0] as const,
    mid: [index, 0.5, 1] as const,
    seam: false,
    degenerate: false,
  })),
  vertices: 8,
  volume: 8,
};

beforeEach(() =>
  setGeometryKernel(
    fakeKernel({ boolean: TETRA, fillet: TETRA, chamfer: TETRA, shell: TETRA, topology: TOPOLOGY }),
  ),
);
afterEach(() => setGeometryKernel(null));

function step(doc: CadDocument, name: string, params: unknown): ReturnType<typeof execute> {
  const result = execute(doc, name, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result;
}

const code = (doc: CadDocument, language: string): { text: string; summary: string } => {
  const result = execute(doc, 'export_code', { language });
  return { text: (result.data as { text: string }).text, summary: result.summary };
};

/** Box -> fillet edge 1 (r 0.5) -> drilled by a cylinder -> shell 0.2. */
function model(): CadDocument {
  const box = step(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const filleted = step(box.document, 'fillet_edge', {
    id: box.affected[0],
    edgeIndices: [1],
    radius: 0.5,
  });
  const drill = step(filleted.document, 'add_cylinder', { radius: 0.3, height: 4 });
  const drilled = step(drill.document, 'boolean_subtract', {
    a: filleted.affected[0],
    b: drill.affected[0],
  });
  return step(drilled.document, 'shell_solid', { id: drilled.affected[0], thickness: 0.2 })
    .document;
}

describe('export_code of exact kernel results', () => {
  it('history: fillet and shell steps become exact calls with the edge mid points', () => {
    const { text, summary } = code(model(), 'cadquery');
    expect(text).toMatch(/^box_1 = fillet\(box_1, \[1\], 0\.5, near=\[\(1, 0\.5, 1\)\]\)$/m);
    expect(text).toMatch(/^box_1 = cut\(box_1, cylinder_1\)$/m);
    expect(text).toMatch(/^box_1 = shell\(box_1, 0\.2\)$/m);
    expect(text).not.toMatch(/= mesh\(\[/);
    expect(summary).not.toMatch(/triangle mesh/);
  });

  it('snapshot (no history): a brep recipe is rebuilt node by node', () => {
    const doc = model();
    const snapshot = { ...doc, featureHistory: [] };
    const { text } = code(snapshot, 'build123d');
    expect(text).toMatch(/^box_1 = box\(\(2, 2, 2\)/m);
    expect(text).toMatch(/^box_1 = fillet\(box_1, \[1\], 0\.5, near=/m);
    expect(text).toMatch(/^box_1 = cut\(box_1, cylinder_1\)$/m);
    expect(text).toMatch(/^box_1 = shell\(box_1, 0\.2\)$/m);
  });

  it('snapshot: a translated result keeps its recipe and adds the move; a rotated one falls back', () => {
    const doc = model();
    const [id] = doc.order;
    const mesh = doc.entities[id!] as MeshSolidEntity;
    const moved = { ...mesh, position: [5, 0, 0] as const };
    const turned = { ...mesh, rotation: [0, 0, 1] as const };
    const asSnapshot = (entity: MeshSolidEntity): CadDocument => ({
      ...doc,
      featureHistory: [],
      entities: { [entity.id]: entity },
    });
    expect(code(asSnapshot(moved), 'cadquery').text).toMatch(
      /^box_1 = translate\(box_1, \(5, 0, 0\)\)$/m,
    );
    const fallback = code(asSnapshot(turned), 'cadquery');
    expect(fallback.text).toMatch(/= mesh\(\[/);
    expect(fallback.summary).toMatch(/no analytic form; exported as a triangle mesh/);
  });

  it('FreeCAD gets makeFillet / makeChamfer helpers; OpenSCAD gets the result triangles', () => {
    const box = step(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const chamfered = step(box.document, 'chamfer_edge', {
      id: box.affected[0],
      edgeIndices: [2],
      distance: 0.25,
    }).document;
    const freecad = code(chamfered, 'freecad').text;
    expect(freecad).toMatch(/^box_1 = chamfer\(box_1, \[2\], 0\.25, near=\[\(2, 0\.5, 1\)\]\)$/m);
    expect(freecad).toContain('shape.makeChamfer(');
    const openscad = code(chamfered, 'openscad').text;
    expect(openscad).toMatch(/module box_1_v\d+\(\) polyhedron\(/);
  });

  it('OpenSCAD leaves a comment when no triangles are known', () => {
    const snapshot = { ...model(), featureHistory: [] };
    setGeometryKernel(null);
    expect(code(snapshot, 'openscad').text).toMatch(/fillet not expressible in OpenSCAD/);
  });

  it('apply_code_trace replays recorded fillet / chamfer / shell features', () => {
    const trace = {
      parameters: [],
      features: [
        { command: 'add_box', params: { size: [2, 2, 2] }, ref: 'f1' },
        {
          command: 'fillet_edge',
          params: { id: { ref: 'f1' }, edgeIndices: [1], radius: 0.5 },
          ref: 'f2',
        },
        {
          command: 'chamfer_edge',
          params: { id: { ref: 'f2' }, edgeIndices: [], distance: 0.1 },
          ref: 'f3',
        },
        { command: 'shell_solid', params: { id: { ref: 'f3' }, thickness: 0.2 }, ref: 'f4' },
      ],
    };
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace });
    expect(applied.document.featureHistory.map((s) => s.name)).toEqual([
      'add_box',
      'fillet_edge',
      'chamfer_edge',
      'shell_solid',
    ]);
    const [id] = applied.document.order;
    expect((applied.document.entities[id!] as MeshSolidEntity).brep?.op).toBe('shell');
  });
});
