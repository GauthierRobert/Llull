import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type Entity, type ShapeRecipe } from '@core/model/types';
import { setGeometryKernel } from '@core/geometry/kernel';
import { deformNodeOf, hasUnverifiedLeaf, sourceMeshOf } from '@core/commands/deform/sourceMesh';
import { deformNode, region } from './nodes';
import { installKernel } from './harness';

afterEach(() => setGeometryKernel(null));

const BOX = { id: 'b', kind: 'box', size: [2, 2, 2], position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'l', color: '#888' } as Entity;
const IMPORTED = {
  id: 'm',
  kind: 'mesh',
  mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'l',
  color: '#888',
} as unknown as Entity;
const leafOf = (entity: Entity): ShapeRecipe => ({ op: 'solid', entity });

describe('sourceMeshOf', () => {
  it('evaluates solid leaves and chains of deform nodes without a kernel, nothing else', () => {
    const doc = createEmptyDocument();
    expect(sourceMeshOf(null, leafOf(BOX), doc)?.indices.length).toBe(36);
    const chain = deformNode(
      { kind: 'twist', angleRad: 1 },
      { region: region(-1, 1), source: leafOf(BOX), output: { mode: 'mesh', tolerance: 0.1, preserveAnalytic: false } },
    );
    expect(sourceMeshOf(null, chain, doc)?.indices.length).toBeGreaterThan(36);
    expect(sourceMeshOf(null, { op: 'shell', source: leafOf(BOX), thickness: 0.1 }, doc)).toBeNull();
    const broken = deformNode(
      { kind: 'twist', angleRad: 1 },
      { region: region(-1, 1), source: leafOf(BOX), frame: { origin: [0, 0, 0], axis: [0, 0, 0], reference: [1, 0, 0] } },
    );
    expect(sourceMeshOf(null, broken, doc)).toBeNull();
    const empty = { ...BOX, kind: 'mesh', mesh: { positions: [], indices: [] } } as unknown as Entity;
    expect(sourceMeshOf(null, leafOf(empty), doc)).toBeNull();
  });

  it('asks the kernel first and falls back to the leaf when it refuses', async () => {
    const kernel = await installKernel('manifold');
    const doc = createEmptyDocument();
    expect(sourceMeshOf(kernel, leafOf(BOX), doc)?.indices.length).toBe(36);
    expect(sourceMeshOf(kernel, { op: 'shell', source: leafOf(BOX), thickness: 0.1 }, doc)).toBeNull();
  });
});

describe('deformNodeOf / hasUnverifiedLeaf', () => {
  it('finds the outermost deform node only on a mesh entity', () => {
    const node = deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 1) });
    expect(deformNodeOf({ kind: 'mesh', brep: node })).toBe(node);
    expect(deformNodeOf({ kind: 'box' })).toBeNull();
    expect(deformNodeOf({ kind: 'mesh', brep: leafOf(BOX) })).toBeNull();
  });

  it('walks booleans, blends and single-source nodes to the leaves', () => {
    expect(hasUnverifiedLeaf(leafOf(BOX))).toBe(false);
    expect(hasUnverifiedLeaf(leafOf(IMPORTED))).toBe(true);
    expect(hasUnverifiedLeaf({ op: 'boolean', boolean: 'union', a: leafOf(BOX), b: leafOf(IMPORTED) })).toBe(true);
    expect(hasUnverifiedLeaf({ op: 'boolean', boolean: 'union', a: leafOf(BOX), b: leafOf(BOX) })).toBe(false);
    expect(hasUnverifiedLeaf({ op: 'blend', sources: [leafOf(BOX), leafOf(IMPORTED)], radius: 1 })).toBe(true);
    expect(hasUnverifiedLeaf({ op: 'brep', blob: 'a'.repeat(64), format: 'occt-brep-v1' })).toBe(false);
    expect(hasUnverifiedLeaf({ op: 'shell', source: leafOf(IMPORTED), thickness: 1 })).toBe(true);
  });
});
