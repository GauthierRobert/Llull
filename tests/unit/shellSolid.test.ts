import { describe, it, expect, afterEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { MeshSolidEntity } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';

const SHELL_MESH: MeshData = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
};
const BOX_MESH: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };

function kernel(shell: GeometryKernel['shellSolid']): GeometryKernel & { thicknesses: number[] } {
  const thicknesses: number[] = [];
  return {
    thicknesses,
    booleanOp: () => null,
    filletEdges: () => null,
    chamferEdges: () => null,
    shellSolid: (shape, thickness) => {
      thicknesses.push(thickness);
      return shell(shape, thickness);
    },
    tessellate: () => BOX_MESH,
  };
}

describe('shell_solid', () => {
  afterEach(() => setGeometryKernel(null));

  const created = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4], color: '#aabbcc' });
  const id = created.affected[0]!;
  const doc = created.document;

  it('is registered and requires a kernel', () => {
    expect(getCommand('shell_solid')?.annotations?.requiresKernel).toBe(true);
  });

  it('replaces the solid with the kernel shell mesh', () => {
    const fake = kernel(() => SHELL_MESH);
    setGeometryKernel(fake);
    const result = execute(doc, 'shell_solid', { id, thickness: 0.5 });
    expect(result.affected).toHaveLength(1);
    const shell = result.document.entities[result.affected[0]!] as MeshSolidEntity;
    expect(shell.kind).toBe('mesh');
    expect(shell.mesh).toEqual(SHELL_MESH);
    expect(shell.color).toBe('#aabbcc');
    expect(result.document.entities[id]).toBeUndefined();
    expect(fake.thicknesses).toEqual([0.5]);
    expect(result.summary).toContain('shelled');
  });

  it('is a no-op when the kernel cannot shell (e.g. Manifold)', () => {
    setGeometryKernel(kernel(() => null));
    const result = execute(doc, 'shell_solid', { id, thickness: 0.5 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('does not support shell_solid');
  });

  it('refuses without a kernel', () => {
    const result = execute(doc, 'shell_solid', { id, thickness: 0.5 });
    expect(result.document).toBe(doc);
  });

  it.each([0, -1])('rejects thickness %s without calling the kernel', (thickness) => {
    const fake = kernel(() => SHELL_MESH);
    setGeometryKernel(fake);
    const result = execute(doc, 'shell_solid', { id, thickness });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('thickness must be > 0');
    expect(fake.thicknesses).toEqual([]);
  });

  it('rejects missing ids and 2D shapes', () => {
    setGeometryKernel(kernel(() => SHELL_MESH));
    expect(execute(doc, 'shell_solid', { id: 'ghost', thickness: 1 }).summary).toContain(
      'not found',
    );
    const line = execute(doc, 'draw_line', { start: [0, 0], end: [1, 0] });
    const result = execute(line.document, 'shell_solid', { id: line.affected[0]!, thickness: 1 });
    expect(result.document).toBe(line.document);
    expect(result.summary).toContain('2D shape');
  });
});
