import { describe, it, expect, afterEach } from 'vitest';
import { type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { type MeshData, setGeometryKernel } from '@core/geometry/kernel';
import { fakeKernel, type FakeKernel } from '../helpers/fakeKernel';

const SHELL_MESH: MeshData = {
  positions: [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
};

function thicknessesOf(fake: FakeKernel): (number | undefined)[] {
  return fake.calls.filter((call) => call.op === 'shell').map((call) => call.size);
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
    const fake = fakeKernel({ shell: SHELL_MESH });
    setGeometryKernel(fake);
    const result = execute(doc, 'shell_solid', { id, thickness: 0.5 });
    expect(result.affected).toHaveLength(1);
    const shell = result.document.entities[result.affected[0]!] as MeshSolidEntity;
    expect(shell.kind).toBe('mesh');
    expect(shell.mesh).toEqual(SHELL_MESH);
    expect(shell.color).toBe('#aabbcc');
    expect(shell.brep).toMatchObject({
      op: 'shell',
      source: { op: 'solid', entity: doc.entities[id] },
      thickness: 0.5,
    });
    expect(result.document.entities[id]).toBeUndefined();
    expect(thicknessesOf(fake)).toEqual([0.5]);
    expect(result.summary).toContain('shelled');
  });

  it('is a no-op when the kernel cannot shell (e.g. Manifold)', () => {
    setGeometryKernel(fakeKernel({ shell: null }));
    const result = execute(doc, 'shell_solid', { id, thickness: 0.5 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('does not support shell_solid');
    expect(result.summary).toContain('?kernel=occt in the browser');
    expect(result.summary).toContain('LLULL_KERNEL=occt on the server');
  });

  it('is a no-op when the kernel cannot build the source solid', () => {
    setGeometryKernel(fakeKernel({ solid: null }));
    const result = execute(doc, 'shell_solid', { id, thickness: 0.5 });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('kernel could not build entity');
  });

  it('refuses without a kernel', () => {
    const result = execute(doc, 'shell_solid', { id, thickness: 0.5 });
    expect(result.document).toBe(doc);
  });

  it.each([0, -1])('rejects thickness %s without calling the kernel', (thickness) => {
    const fake = fakeKernel({ shell: SHELL_MESH });
    setGeometryKernel(fake);
    const result = execute(doc, 'shell_solid', { id, thickness });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('thickness must be > 0');
    expect(thicknessesOf(fake)).toEqual([]);
  });

  it('rejects missing ids and 2D shapes', () => {
    setGeometryKernel(fakeKernel({ shell: SHELL_MESH }));
    expect(execute(doc, 'shell_solid', { id: 'ghost', thickness: 1 }).summary).toContain(
      'not found',
    );
    const line = execute(doc, 'draw_line', { start: [0, 0], end: [1, 0] });
    const result = execute(line.document, 'shell_solid', { id: line.affected[0]!, thickness: 1 });
    expect(result.document).toBe(line.document);
    expect(result.summary).toContain('2D shape');
  });
});
