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

  it('an instance of a kernel result is re-tessellated through its component, and the summary names the instance', () => {
    setGeometryKernel(kernelOf(true));
    let doc = documentWithResult();
    const bodyId = doc.order[0] as string;
    doc = execute(doc, 'create_component', { name: 'Part', entityIds: [bodyId], componentId: 'comp-part' }).document;
    const inserted = execute(doc, 'insert_instance', { componentId: 'comp-part', position: [0, 0, 0] });
    const result = execute(inserted.document, 'export_stl', { chordTolerance: 0.05 });
    // the body itself (8 triangles re-tessellated) and its instance (8): the stored meshes would be 4 + 4
    expect((result.data as { triangleCount: number }).triangleCount).toBe(16);
    expect(requested).toContainEqual({ linearDeflection: 0.05, angularDeflection: 0.5 });
    expect(result.summary).toContain(inserted.affected[0] as string);
    setGeometryKernel(null);
    expect((execute(inserted.document, 'export_stl', {}).data as { triangleCount: number }).triangleCount).toBe(8);
  });

  it('chordTolerance below the floor is rejected as an invalid parameter', () => {
    const result = execute(createEmptyDocument(), 'export_stl', { chordTolerance: 1e-5 });
    expect(result.summary).toMatch(/rejected: invalid params/);
  });

  it('a tolerance finer than diagonal / 1e6 is refused with a named code and the smallest allowed value', () => {
    const big = { positions: TETRA.positions.map((v) => v * 1000), indices: TETRA.indices };
    setGeometryKernel(
      fakeKernel({
        boolean: big,
        honoursTessellationOptions: true,
        tessellate: (native, options) => (options === undefined ? native.mesh : FINE),
      }),
    );
    const doc = documentWithResult();
    const refused = execute(doc, 'export_stl', { chordTolerance: 1e-4 });
    expect(refused.error?.code).toBe('EXPORT_TESSELLATION_BUDGET');
    expect(refused.data).toBeUndefined();
    expect(refused.error?.remediation).toMatch(/chordTolerance 0\.00\d+ or larger/);
    const allowed = execute(doc, 'export_stl', { chordTolerance: 0.01 });
    expect(allowed.error).toBeUndefined();
    expect(execute(doc, 'export_obj', { chordTolerance: 1e-4 }).error?.code).toBe('EXPORT_TESSELLATION_BUDGET');
    expect(execute(doc, 'export_3mf', { chordTolerance: 1e-4 }).error?.code).toBe('EXPORT_TESSELLATION_BUDGET');
  });

  it('the kernel keeps at most three explicit meshes per shape (the latest)', () => {
    const kernel = kernelOf(true);
    setGeometryKernel(kernel);
    const doc = documentWithResult();
    const entity = Object.values(doc.entities).find((candidate) => candidate.kind === 'mesh');
    const shape = kernel.evaluate((entity as Extract<typeof entity, { kind: 'mesh' }>).brep as never);
    const at = (linearDeflection: number): unknown => kernel.tessellate(shape as never, { linearDeflection, angularDeflection: 0.5 });
    [0.1, 0.2, 0.3, 0.4].forEach(at);
    const calls = requested.length;
    at(0.4);
    expect(requested.length).toBe(calls);
    at(0.1);
    expect(requested.length).toBe(calls + 1);
  });

  it('the summary says nothing about tessellation when no body keeps an exact recipe, and tells a mesh kernel from no kernel', () => {
    setGeometryKernel(kernelOf(true));
    const primitives = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    expect(execute(primitives, 'export_stl', {}).summary).not.toMatch(/Tessellation:/);
    const withResult = documentWithResult();
    setGeometryKernel(null);
    expect(execute(withResult, 'export_stl', {}).summary).toMatch(/because no exact kernel is installed/);
    setGeometryKernel(kernelOf(false));
    expect(execute(withResult, 'export_stl', {}).summary).toMatch(
      /because the installed kernel \(a mesh kernel\) ignores tessellation options/,
    );
  });
});
