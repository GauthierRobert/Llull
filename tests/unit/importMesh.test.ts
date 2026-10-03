import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { MAX_IMPORT_BODIES, MAX_IMPORT_TRIANGLES } from '@core/commands/limits';

const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];

function importMesh(doc: CadDocument, bodies: unknown): ReturnType<typeof execute> {
  return execute(doc, 'import_mesh', { bodies });
}

function meshOf(doc: CadDocument, id: string): MeshSolidEntity {
  return doc.entities[id] as MeshSolidEntity;
}

describe('import_mesh', () => {
  it('imports a triangle soup as one mesh entity with sequential indices', () => {
    const doc = createEmptyDocument();
    const result = importMesh(doc, [{ positions: TRIANGLE }]);
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toBe(`Imported 1 mesh body (1 triangles): ${result.affected[0]}.`);
    const mesh = meshOf(result.document, result.affected[0]!);
    expect(mesh.kind).toBe('mesh');
    expect(mesh.mesh.positions).toEqual(TRIANGLE);
    expect(mesh.mesh.indices).toEqual([0, 1, 2]);
    expect(mesh.position).toEqual([0, 0, 0]);
    expect(mesh.rotation).toEqual([0, 0, 0]);
    expect(mesh.color).toBe('#9aa5b1');
    expect(mesh.name).toBeUndefined();
    expect(result.document.order).toEqual(result.affected);
    expect(result.document.featureHistory.map((s) => s.name)).toEqual(['import_mesh']);
  });

  it('expands indexed geometry into a soup so every consumer agrees', () => {
    const quadPositions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const result = importMesh(createEmptyDocument(), [
      { positions: quadPositions, indices: [0, 1, 2, 0, 2, 3] },
    ]);
    const mesh = meshOf(result.document, result.affected[0]!);
    expect(mesh.mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(mesh.mesh.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.summary).toContain('(2 triangles)');
  });

  it('keeps a trimmed name and a valid hex color, ignores blank names and bad colors', () => {
    const result = importMesh(createEmptyDocument(), [
      { positions: TRIANGLE, name: 'Bracket', color: '#AaBb01' },
      { positions: TRIANGLE, name: '   ', color: 'red' },
      { positions: TRIANGLE, name: 7, color: 12 },
    ]);
    const [a, b, c] = result.affected.map((id) => meshOf(result.document, id)) as [
      MeshSolidEntity,
      MeshSolidEntity,
      MeshSolidEntity,
    ];
    expect(a.name).toBe('Bracket');
    expect(a.color).toBe('#AaBb01');
    expect(b.name).toBeUndefined();
    expect(b.color).toBe('#9aa5b1');
    expect(c.name).toBeUndefined();
    expect(c.color).toBe('#9aa5b1');
    expect(result.summary).toContain('Imported 3 mesh bodies (3 triangles)');
  });

  it('appends to existing entities and keeps them', () => {
    const base = execute(createEmptyDocument(), 'add_sphere', { radius: 1 }).document;
    const result = importMesh(base, [{ positions: TRIANGLE }]);
    expect(result.document.order).toEqual([base.order[0], result.affected[0]]);
    expect(result.document.entities[base.order[0]!]).toBe(base.entities[base.order[0]!]);
  });

  describe('invalid input is a no-op with an explanatory summary', () => {
    function expectNoOp(bodies: unknown, reason: string): void {
      const doc = execute(createEmptyDocument(), 'add_sphere', { radius: 1 }).document;
      const result = importMesh(doc, bodies);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain('import_mesh:');
      expect(result.summary).toContain(reason);
      expect(result.summary).toContain('no-op');
    }

    it('rejects missing, non-array and empty bodies', () => {
      for (const bodies of [undefined, 'x']) {
        const doc = createEmptyDocument();
        const result = importMesh(doc, bodies);
        expect(result.document).toBe(doc);
        expect(result.affected).toEqual([]);
        expect(result.summary).toContain('import_mesh rejected: invalid params');
      }
      expectNoOp([], 'bodies must be a non-empty array');
    });

    it('rejects too many bodies', () => {
      expectNoOp(
        Array.from({ length: MAX_IMPORT_BODIES + 1 }, () => ({ positions: TRIANGLE })),
        'exceeds MAX_IMPORT_BODIES',
      );
    });

    it('rejects positions that are not a multiple of 3 or not an array', () => {
      expectNoOp([{ positions: [0, 0, 0, 1] }], 'body 0: positions must be a flat');
      expectNoOp([{ positions: 'abc' }], 'body 0: positions must be a flat');
    });

    it('rejects non-finite or non-numeric positions', () => {
      expectNoOp(
        [{ positions: [0, 0, Number.NaN, 0, 0, 0, 0, 0, 0] }],
        'positions must be finite numbers',
      );
      expectNoOp(
        [{ positions: [0, 0, '1', 0, 0, 0, 0, 0, 0] }],
        'positions must be finite numbers',
      );
      expectNoOp(
        [{ positions: [0, 0, Number.POSITIVE_INFINITY, 0, 0, 0, 0, 0, 0] }],
        'positions must be finite numbers',
      );
    });

    it('rejects partial triangles and empty positions without indices', () => {
      expectNoOp([{ positions: [0, 0, 0, 1, 0, 0] }], 'whole triangles (9 numbers each)');
      expectNoOp([{ positions: [] }], 'whole triangles (9 numbers each)');
    });

    it('rejects bad index lists', () => {
      const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
      expectNoOp([{ positions, indices: [] }], 'indices must be a non-empty multiple of 3');
      expectNoOp([{ positions, indices: [0, 1] }], 'indices must be a non-empty multiple of 3');
      expectNoOp([{ positions, indices: 'x' }], 'indices must be a non-empty multiple of 3');
      expectNoOp([{ positions, indices: [0, 1, 3] }], 'index 3 is outside 0..2');
      expectNoOp([{ positions, indices: [0, 1, -1] }], 'index -1 is outside 0..2');
      expectNoOp([{ positions, indices: [0, 1, 1.5] }], 'index 1.5 is outside 0..2');
    });

    it('reports the failing body index and imports nothing from earlier bodies', () => {
      expectNoOp([{ positions: TRIANGLE }, { positions: [1, 2] }], 'body 1:');
    });

    it('rejects more than MAX_IMPORT_TRIANGLES triangles in total', () => {
      const positions = new Array<number>(9 * (MAX_IMPORT_TRIANGLES / 2 + 1)).fill(0);
      expectNoOp(
        [{ positions }, { positions }],
        `more than MAX_IMPORT_TRIANGLES (${MAX_IMPORT_TRIANGLES})`,
      );
    });
  });

  it('is pure: the input document is unchanged', () => {
    const doc = execute(createEmptyDocument(), 'add_sphere', { radius: 1 }).document;
    const before = JSON.stringify(doc);
    importMesh(doc, [{ positions: TRIANGLE, name: 'A' }]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
