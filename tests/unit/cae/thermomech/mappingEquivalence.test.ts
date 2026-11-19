/**
 * PERF1 §5 row 11: the flat element locator of `mapNodalField` returns exactly what the recursive search did (frozen copy
 * `legacyMapNodalField.ts`): the same value, element and distance per node, Float64 bit for bit, and the same report and refusals, on
 * coincident meshes (many containing elements per node), shuffled element orders, nodes outside, equidistant candidates, micro-scale meshes
 * (distances in the 1e-15 tie band), degenerate and non-finite elements.
 */
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import { mapNodalField } from '@cae/thermomech/mapping';
import { gridMesh, seeded } from '../gridMesh';
import { legacyMapNodalField } from './legacyMapNodalField';

type Nodes = FeMeshArtifact['nodes'];

const artifact = (nodes: Nodes, elements: readonly (readonly number[])[]): FeMeshArtifact => ({
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '0',
  inputHash: 'h',
  nodes,
  blocks: [{ type: elements[0]?.length === 10 ? 'C3D10' : 'C3D4', entityId: 'box', elements: elements.map((e, i) => [i + 1, ...e]) }],
  nodeSets: {},
  faceSets: {},
  targets: {},
});

const field = (nodes: Nodes): Map<number, number> =>
  new Map(nodes.map(([id, x, y, z]) => [id, 20 + 0.3 * x + 0.01 * y * y - z + 1e-3 * x * z]));

/** Float64 bits of every number, so -0 / +0 and the last bit count. */
const bits = (values: readonly number[]): string[] => {
  const view = new DataView(new ArrayBuffer(8));
  return values.map((value) => {
    view.setFloat64(0, value);
    return view.getBigUint64(0).toString(16);
  });
};

function expectSame(source: FeMeshArtifact, values: ReadonlyMap<number, number>, target: FeMeshArtifact): void {
  const before = legacyMapNodalField(source, values, target);
  const after = mapNodalField(source, values, target);
  if (!before.ok || !after.ok) {
    expect(after).toEqual(before);
    return;
  }
  expect(bits(after.values)).toEqual(bits(before.values));
  expect(after.elements).toEqual(before.elements);
  expect(bits(after.distances)).toEqual(bits(before.distances));
  expect(bits(Object.values(after.report))).toEqual(bits(Object.values(before.report)));
}

/** Elements in a seeded random order: index order then has nothing to do with position, so ties are decided by index for real. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = seeded(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const scaled = (nodes: Nodes, factor: number, offset = 0): Nodes =>
  nodes.map(([id, x, y, z]) => [id, offset + x * factor, offset + y * factor, offset + z * factor] as const);

function randomPoints(count: number, seed: number, low: number, high: number, firstId = 1): Nodes {
  const random = seeded(seed);
  return Array.from(
    { length: count },
    (_, i) => [firstId + i, low + random() * (high - low), low + random() * (high - low), low + random() * (high - low)] as const,
  );
}

describe('mapNodalField matches the frozen recursive search bit for bit', () => {
  const linear = gridMesh({ cells: [5, 4, 3], size: [10, 8, 6] });
  const quadratic = gridMesh({ cells: [4, 3, 3], size: [8, 6, 6], quadratic: true });

  it('maps a mesh onto itself (every node on shared vertices, edges and faces), elements in mesh and in shuffled order', () => {
    for (const grid of [linear, quadratic])
      for (const order of [grid.elements, shuffled(grid.elements, 7), shuffled(grid.elements, 11)]) {
        const source = artifact(grid.nodes, order);
        expectSame(source, field(grid.nodes), artifact(grid.nodes, grid.elements));
      }
  });

  it('maps random points inside and outside, a shifted finer grid and points far away', () => {
    const source = artifact(quadratic.nodes, shuffled(quadratic.elements, 3));
    const values = field(quadratic.nodes);
    expectSame(source, values, artifact(randomPoints(400, 5, -3, 11), [[1, 2, 3, 4]]));
    const shifted = gridMesh({ cells: [7, 5, 6], size: [9, 7, 7], origin: [-0.5, 0.25, -0.5] });
    expectSame(source, values, artifact(shifted.nodes, shifted.elements));
    expectSame(source, values, artifact(randomPoints(50, 9, 1e3, 1e4), [[1, 2, 3, 4]]));
  });

  it('breaks ties between equidistant elements outside the mesh by the lowest index (mirror-symmetric points)', () => {
    const source = artifact(linear.nodes, shuffled(linear.elements, 13));
    const points: [number, number, number, number][] = [];
    let id = 1;
    for (const x of [-1, 0, 2, 5, 10, 11])
      for (const y of [-2, 0, 4, 8, 10]) for (const z of [-1, 0, 3, 6, 7]) points.push([id++, x, y, z]);
    expectSame(source, field(linear.nodes), artifact(points, [[1, 2, 3, 4]]));
  });

  it('agrees on micro-scale meshes, where distances fall inside the 1e-15 tie band, and on jittered unstructured tets', () => {
    for (const factor of [1e-14, 3e-15, 1e-16]) {
      const nodes = scaled(linear.nodes, factor, 1e-15);
      const target = scaled(randomPoints(300, 17, -1, 11), factor, 1e-15);
      expectSame(artifact(nodes, shuffled(linear.elements, 19)), field(nodes), artifact(target, [[1, 2, 3, 4]]));
    }
    const random = seeded(23);
    const jittered: Nodes = linear.nodes.map(([id, x, y, z]) => [
      id,
      x + (random() - 0.5) * 0.4,
      y + (random() - 0.5) * 0.4,
      z + (random() - 0.5) * 0.4,
    ]);
    expectSame(artifact(jittered, shuffled(linear.elements, 29)), field(jittered), artifact(randomPoints(400, 31, -1, 11), [[1, 2, 3, 4]]));
  });

  it('agrees with degenerate elements in the source, whether or not one is picked (refusal)', () => {
    const extra: Nodes = [
      [1001, 20, 0, 0],
      [1002, 21, 0, 0],
      [1003, 20, 1, 0],
      [1004, 21, 1, 0],
    ];
    const nodes = [...linear.nodes, ...extra];
    const flat = [1001, 1002, 1003, 1004];
    const repeated = [1, 1, 2, 3];
    const elements = shuffled([...linear.elements, flat, repeated], 37);
    const values = field(nodes);
    expectSame(artifact(nodes, elements), values, artifact(randomPoints(200, 41, 0, 10), [[1, 2, 3, 4]]));
    expectSame(artifact(nodes, elements), values, artifact([[1, 20.5, 0.5, 0.25]], [[1, 2, 3, 4]]));
    expectSame(artifact(nodes, elements), values, artifact([[1, 0, 0, 0]], [[1, 2, 3, 4]]));
  });

  it('agrees on non-finite coordinates (the per-node sort fallback) and on a missing source value', () => {
    const broken: Nodes = linear.nodes.map(([id, x, y, z]) =>
      id === 7 ? [id, Number.NaN, y, z] : id === 9 ? [id, x, Infinity, z] : [id, x, y, z],
    );
    expectSame(
      artifact(broken, shuffled(linear.elements, 43)),
      field(linear.nodes),
      artifact(randomPoints(100, 47, 0, 10), [[1, 2, 3, 4]]),
    );
    const values = field(linear.nodes);
    values.delete(5);
    expectSame(artifact(linear.nodes, linear.elements), values, artifact(linear.nodes, linear.elements));
    values.set(5, Number.NaN);
    expectSame(artifact(linear.nodes, linear.elements), values, artifact(linear.nodes, linear.elements));
  });

  it('agrees on the refusals of a source that is not C3D4 / C3D10 or misses a node, and of an empty source', () => {
    const values = field(linear.nodes);
    const target = artifact(linear.nodes.slice(0, 5), [[1, 2, 3, 4]]);
    expectSame(artifact(linear.nodes, [...linear.elements, [1, 2, 3, 4, 5]]), values, target);
    expectSame(artifact(linear.nodes, [[1, 2, 3, 99_999]]), values, target);
    expectSame({ ...artifact(linear.nodes, [[1, 2, 3, 4]]), blocks: [] }, values, target);
  });
});
