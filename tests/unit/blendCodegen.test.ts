/**
 * BLD M1: export_code lowers radius laws to the OCP / FreeCAD runtimes (`fillet_laws`) and names what it cannot express
 * (BLD_CODEGEN_UNSUPPORTED), over a scripted exact kernel.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { scriptedKernel } from '../helpers/blendKernel';

afterEach(() => setGeometryKernel(null));

/** What each language writes for the exact mesh that replaces an inexpressible blend, and for the removal of the unblended source. */
const MESH_EXPORT: Readonly<Record<string, { mesh: string; removed: string }>> = {
  cadquery: { mesh: 'mesh([', removed: 'remove(box_1)' },
  build123d: { mesh: 'mesh([', removed: 'remove(box_1)' },
  freecad: { mesh: 'mesh([', removed: 'box_1 = None' },
  openscad: { mesh: 'polyhedron', removed: '// box_1 removed' },
};
const expectMeshInstead = (doc: CadDocument, language: string): void => {
  const { text, summary } = code(doc, language);
  const expected = MESH_EXPORT[language] as { mesh: string; removed: string };
  expect(summary, language).toContain('BLD_CODEGEN_UNSUPPORTED');
  expect(text, language).toContain(expected.mesh);
  expect(text, language).toContain(expected.removed);
};

const step = (doc: CadDocument, name: string, params: unknown): { doc: CadDocument; id: string } => {
  const result = execute(doc, name, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return { doc: result.document, id: result.affected[0] as string };
};
const code = (doc: CadDocument, language: string): { text: string; summary: string } => {
  const result = execute(doc, 'export_code', { language });
  return { text: (result.data as { text: string }).text, summary: result.summary };
};

function modelWith(edges: unknown[]): CadDocument {
  setGeometryKernel(scriptedKernel());
  const box = step(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return step(box.doc, 'fillet_edge', { id: box.id, edges }).doc;
}

describe('export_code of radius laws', () => {
  it('a start -> end law is a fillet_laws call with plain radii (no nodes)', () => {
    const { text, summary } = code(modelWith([{ index: 0, size: 1, sizeEnd: 2 }]), 'cadquery');
    expect(text).toMatch(/^box_1 = fillet_laws\(box_1, \[0\], \[\(1, 2, \[\], False, None\)\], near=\[\(10, 0, 0\)\]\)$/m);
    expect(text).toContain('def fillet_laws(solid, edges, laws, near=None):');
    expect(text).toContain('BRepFilletAPI_MakeFillet');
    expect(summary).not.toMatch(/triangle mesh/);
  });

  it('a smooth law with control points sends the nodes OCCT interpolates; a straight one sends the graded polyline', () => {
    const smooth = code(modelWith([{ index: 0, size: 1, sizeEnd: 3, sizes: [{ t: 0.5, size: 2 }] }]), 'build123d').text;
    expect(smooth).toMatch(/fillet_laws\(box_1, \[0\], \[\(1, 3, \[\(0\.5, 2\)\], False, \[\(0, 1\), \(0\.5, 2\), \(1, 3\)\]\)\]/);
    const straight = code(
      modelWith([{ index: 0, size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }]),
      'cadquery',
    ).text;
    const line = /^box_1 = fillet_laws\(.*$/m.exec(straight)?.[0] ?? '';
    expect(line).toContain('[(0.5, 2)], True, [(0, 1), ');
    expect(line.match(/\(/g)?.length).toBeGreaterThan(40);
  });

  it('the history of a law fillet also reaches the recorded trace as the llull edges entries', () => {
    const { text } = code(modelWith([{ index: 0, size: 1, sizeEnd: 2, interpolation: 'linear' }]), 'cadquery');
    expect(text).toContain('feature = _record("fillet_edge", {"id": {"ref": solid.ref}, "edges": entries})');
    expect(text).toContain('entry["interpolation"] = "linear"');
  });

  it('FreeCAD: a plain start -> end law is makeFillet(r1, r2); nodes are refused loudly with BLD_CODEGEN_UNSUPPORTED', () => {
    const { text } = code(modelWith([{ index: 0, size: 1, sizeEnd: 2 }]), 'freecad');
    expect(text).toMatch(/^box_1 = fillet_laws\(box_1, \[0\], \[\(1, 2, \[\], False, None\)\], near=/m);
    expect(text).toContain('def fillet_laws(shape, edges, laws, near=None):');
    expect(text).toContain('BLD_CODEGEN_UNSUPPORTED');
    expect(text).toContain('shape.makeFillet(float(first[0]), float(end)');
  });

  it('a straight law is exported as a graded-node spline and says so (OCP has no exact straight law); a smooth law carries no such note', () => {
    const straight = code(modelWith([{ index: 0, size: 1, sizeEnd: 2, interpolation: 'linear' }]), 'cadquery');
    expect(straight.summary).toContain('straight radius law exported as a graded-node spline');
    expect(straight.summary).toContain('within 1e-8 relative of the exact volume');
    expect(code(modelWith([{ index: 0, size: 1, sizeEnd: 2 }]), 'cadquery').summary).not.toContain('graded-node');
  });

  it('OpenSCAD keeps the exact result as triangles for a law fillet', () => {
    const { text } = code(modelWith([{ index: 0, size: 1, sizeEnd: 2 }]), 'openscad');
    expect(text).toMatch(/polyhedron|module/);
    expect(text).not.toContain('fillet_laws');
  });

  it('a sided chamfer is not expressible: BLD_CODEGEN_UNSUPPORTED names it and the export carries the exact result as a mesh', () => {
    setGeometryKernel(scriptedKernel());
    const box = step(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const chamfered = step(box.doc, 'chamfer_edge', { id: box.id, edgeIndices: [0], distance: 1, distance2: 2, side1Near: [0, 0, 0] });
    for (const language of Object.keys(MESH_EXPORT)) expectMeshInstead(chamfered.doc, language);
    const snapshot = code({ ...chamfered.doc, featureHistory: [] }, 'cadquery');
    expect(snapshot.summary).toContain('BLD_CODEGEN_UNSUPPORTED');
  });

  it('a variable chamfer is not expressible either: never exported as a constant chamfer', () => {
    setGeometryKernel(scriptedKernel());
    const box = step(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const chamfered = step(box.doc, 'chamfer_edge', { id: box.id, edgeIndices: [0], distance: 1, distanceEnd: 2 });
    for (const language of Object.keys(MESH_EXPORT)) expectMeshInstead(chamfered.doc, language);
  });
});
