import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type TessellationOptions } from '@core/geometry/kernel';
import { fakeKernel, TETRA, type FakeKernel } from '../helpers/fakeKernel';

/** The stored (display) mesh is one tetrahedron; the explicit mesh is two (8 triangles), so the path an export took shows in its triangle count. */
const FINE = {
  positions: [...TETRA.positions, ...TETRA.positions.map((v) => v + 5)],
  indices: [...TETRA.indices, ...TETRA.indices.map((i) => i + 4)],
};
const requested: Array<TessellationOptions | undefined> = [];

function kernelOf(honours: boolean): FakeKernel {
  requested.length = 0;
  return fakeKernel({
    boolean: TETRA,
    honoursTessellationOptions: honours,
    tessellate: (native, options) => {
      requested.push(options);
      return options === undefined || !honours ? native.mesh : FINE;
    },
  });
}

/** A document of one kernel-result body (a mesh entity keeping its exact recipe), built with the installed kernel. */
function documentWithResult(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
  doc = execute(doc, 'add_box', { size: [4, 4, 4], position: [2, 2, 2] }).document;
  doc = execute(doc, 'boolean', { op: 'subtract', a: 'box-1.1', b: 'box-2.1' }).document;
  return doc;
}

afterEach(() => setGeometryKernel(null));

describe('fabrication exports re-tessellate kernel results at chordTolerance', () => {
  it('export_stl: a kernel honouring options is asked for the default 0.1 / 0.5 and its mesh is exported', () => {
    setGeometryKernel(kernelOf(true));
    const doc = documentWithResult();
    const result = execute(doc, 'export_stl', {});
    expect((result.data as { triangleCount: number }).triangleCount).toBe(8);
    expect(requested).toContainEqual({ linearDeflection: 0.1, angularDeflection: 0.5 });
    expect(result.summary).toMatch(/re-tessellated by the exact kernel at chordTolerance 0\.1/);
  });

  it('export_stl: chordTolerance is passed as the absolute linear deflection', () => {
    setGeometryKernel(kernelOf(true));
    const result = execute(documentWithResult(), 'export_stl', { chordTolerance: 0.02 });
    expect(requested).toContainEqual({ linearDeflection: 0.02, angularDeflection: 0.5 });
    expect(result.summary).toContain('chordTolerance 0.02');
  });

  it('export_stl: without a kernel the stored triangles are exported and the summary says the tolerance was not applied', () => {
    setGeometryKernel(kernelOf(true));
    const doc = documentWithResult();
    setGeometryKernel(null);
    const result = execute(doc, 'export_stl', { chordTolerance: 0.02 });
    expect((result.data as { triangleCount: number }).triangleCount).toBe(4);
    expect(result.summary).toMatch(/stored display meshes .* chordTolerance 0\.02 was not applied/);
  });

  it('export_stl: a kernel that ignores options (Manifold) keeps the stored mesh and never receives options', () => {
    setGeometryKernel(kernelOf(false));
    const doc = documentWithResult();
    requested.length = 0;
    const result = execute(doc, 'export_stl', {});
    expect(requested.every((options) => options === undefined)).toBe(true);
    expect(result.summary).toMatch(/stored display meshes/);
  });

  it('export_stl: rejects a non-positive chordTolerance', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'export_stl', { chordTolerance: 0 });
    expect(result.summary).toMatch(/rejected: invalid params/);
    expect(result.data).toBeUndefined();
  });

  it('export_obj and export_3mf take the same path', () => {
    setGeometryKernel(kernelOf(true));
    const doc = documentWithResult();
    const obj = execute(doc, 'export_obj', { chordTolerance: 0.5 });
    expect((obj.data as { triangleCount: number }).triangleCount).toBe(8);
    expect(obj.summary).toContain('chordTolerance 0.5');
    const threeMf = execute(doc, 'export_3mf', { chordTolerance: 0.5 });
    expect(threeMf.summary).toContain('re-tessellated by the exact kernel at chordTolerance 0.5');
    setGeometryKernel(null);
    expect(execute(doc, 'export_3mf', {}).summary).toMatch(/stored display meshes/);
  });

  it('the display mesh is unchanged by an explicit request (kernel cache)', () => {
    const kernel = kernelOf(true);
    setGeometryKernel(kernel);
    const doc = documentWithResult();
    const entity = Object.values(doc.entities).find((candidate) => candidate.kind === 'mesh');
    expect(entity?.kind).toBe('mesh');
    const shape = kernel.evaluate((entity as Extract<typeof entity, { kind: 'mesh' }>).brep as never);
    const display = kernel.tessellate(shape as never);
    const explicit = kernel.tessellate(shape as never, { linearDeflection: 0.1, angularDeflection: 0.5 });
    expect(explicit?.indices.length).toBe(24);
    expect(kernel.tessellate(shape as never)).toBe(display);
    const calls = requested.length;
    kernel.tessellate(shape as never, { linearDeflection: 0.1, angularDeflection: 0.5 });
    expect(requested.length).toBe(calls);
    kernel.tessellate(shape as never, { linearDeflection: 0.2, angularDeflection: 0.5 });
    expect(requested.length).toBe(calls + 1);
  });
});
