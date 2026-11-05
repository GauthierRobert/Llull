/**
 * Synthetic tetrahedral meshes for the through-thickness adequacy tests (no mesher needed): a structured block and thin-walled tubes. A layer
 * of cells (Kuhn split: 6 tets around the 0-7 diagonal; or an extruded triangle: 3 tets) is crossed by 3 tets of a ray through the wall.
 */
import type { FeMeshArtifact } from '@core/model/analysis';
import { gridMesh } from './gridMesh';

type Point = readonly [number, number, number];

const meshOf = (
  nodes: FeMeshArtifact['nodes'],
  elements: readonly (readonly number[])[],
  type: 'C3D4' | 'C3D10',
  entityId: string,
): FeMeshArtifact => ({
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '1',
  inputHash: 'synthetic',
  nodes,
  blocks: [{ type, entityId, elements: elements.map((element, index) => [index + 1, ...element]) }],
  nodeSets: {},
  faceSets: {},
  targets: {},
});

/** A lattice of `cells` cells whose node (u, v, w in [0, 1]) sits at `place(u, v, w)`; nodes at the same place are merged (a closed seam). */
function lattice(
  cells: readonly [number, number, number],
  place: (u: number, v: number, w: number) => Point,
  entityId: string,
): FeMeshArtifact {
  const [nx, ny, nz] = cells;
  const nodes: [number, number, number, number][] = [];
  const merged = new Map<string, number>();
  const nodeAt = (i: number, j: number, k: number): number => {
    const point = place(i / nx, j / ny, k / nz);
    const key = point.map((value) => (Math.round(value * 1e6) / 1e6 + 0).toFixed(6)).join(',');
    const known = merged.get(key);
    if (known !== undefined) return known;
    nodes.push([nodes.length + 1, point[0], point[1], point[2]]);
    merged.set(key, nodes.length);
    return nodes.length;
  };
  const elements: number[][] = [];
  const grid = gridMesh({ cells, size: [nx, ny, nz] });
  const ids = new Map(grid.nodes.map((node) => [node[0], nodeAt(node[1], node[2], node[3])]));
  for (const element of grid.elements) elements.push(element.map((id) => ids.get(id) ?? id));
  return meshOf(nodes, elements, 'C3D4', entityId);
}

/** A box of `cells` cells of the given `size`; quadratic (Kuhn only) = C3D10. */
export function blockMesh(
  cells: readonly [number, number, number],
  size: readonly [number, number, number],
  options: { readonly quadratic?: boolean; readonly entityId?: string } = {},
): FeMeshArtifact {
  if (options.quadratic === true) {
    const grid = gridMesh({ cells, size, quadratic: true });
    return meshOf(grid.nodes, grid.elements, 'C3D10', options.entityId ?? 'block');
  }
  return lattice(cells, (u, v, w) => [u * size[0], v * size[1], w * size[2]], options.entityId ?? 'block');
}

/**
 * A tube (axis z) of outer diameter `outerDiameter`, wall `wall` and length `length`, with `wallLayers` cell layers through the wall,
 * `around` (even) cells around and `along` cells along the axis; the seam is closed, so the only boundary is the wall surfaces.
 */
export function tubeMesh(
  outerDiameter: number,
  wall: number,
  length: number,
  counts: { readonly wallLayers: number; readonly around: number; readonly along: number },
  entityId = 'tube',
): FeMeshArtifact {
  const outer = outerDiameter / 2;
  return lattice(
    [counts.wallLayers, counts.around, counts.along],
    (u, v, w) => [(outer - wall + wall * u) * Math.cos(2 * Math.PI * v), (outer - wall + wall * u) * Math.sin(2 * Math.PI * v), length * w],
    entityId,
  );
}

/**
 * A tube (axis z) with ONE element through the wall: the inner ring is rotated half a step against the outer ring, so each triangle of the
 * 2D section spans the wall; every triangle is extruded to a prism of 3 tets (ordered by node id, so the faces of neighbours match).
 */
export function singleLayerTubeMesh(
  outerDiameter: number,
  wall: number,
  length: number,
  around: number,
  along: number,
  entityId = 'tube',
): FeMeshArtifact {
  const outer = outerDiameter / 2;
  const nodes: [number, number, number, number][] = [];
  const levelNodes = (level: number, radius: number, phase: number): number[] =>
    Array.from({ length: around }, (_, i) => {
      const angle = (2 * Math.PI * (i + phase)) / around;
      nodes.push([nodes.length + 1, radius * Math.cos(angle), radius * Math.sin(angle), (length * level) / along]);
      return nodes.length;
    });
  const rings = Array.from({ length: along + 1 }, (_, level) => ({
    outer: levelNodes(level, outer, 0),
    inner: levelNodes(level, outer - wall, 0.5),
  }));
  const elements: number[][] = [];
  for (let level = 0; level < along; level += 1) {
    const [low, high] = [rings[level], rings[level + 1]];
    for (let i = 0; i < around; i += 1) {
      const next = (i + 1) % around;
      const section = [
        [
          ['outer', i],
          ['outer', next],
          ['inner', i],
        ],
        [
          ['inner', i],
          ['inner', next],
          ['outer', next],
        ],
      ] as const;
      for (const triangle of section) {
        const corners = triangle
          .map(([ring, index]) => ({ bottom: low?.[ring][index] ?? 0, top: high?.[ring][index] ?? 0 }))
          .sort((left, right) => left.bottom - right.bottom);
        const [v0, v1, v2] = corners;
        if (v0 === undefined || v1 === undefined || v2 === undefined) continue;
        elements.push(
          [v0.bottom, v1.bottom, v2.bottom, v0.top],
          [v1.bottom, v2.bottom, v0.top, v1.top],
          [v2.bottom, v0.top, v1.top, v2.top],
        );
      }
    }
  }
  return meshOf(nodes, elements, 'C3D4', entityId);
}

const tetVolume = (corners: readonly Point[]): number => {
  const [a, b, c, d] = corners as [Point, Point, Point, Point];
  const u: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Point = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const w: Point = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  return (u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
};

/** Signed volumes of the tets of a mesh (the first block). */
export function tetVolumes(mesh: FeMeshArtifact): number[] {
  const position = new Map(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]] as const]));
  return (mesh.blocks[0]?.elements ?? []).map((element) => tetVolume(element.slice(1, 5).map((id) => position.get(id) as Point)));
}

/** Deterministic offset in [-1, 1) of (node id, axis). */
const unit = (id: number, axis: number): number => (Math.imul(id * 3 + axis + 1, 2654435761) >>> 0) / 2 ** 31 - 1;

/**
 * An unstructured stand-in for a mesher output, without a mesher: the structured block with every interior node displaced by a hash-derived offset
 * of up to `amplitude` x the cell side per axis; a displacement that would invert a tet (volume changing sign) is halved until none does.
 */
export function jitteredBlockMesh(
  cells: readonly [number, number, number],
  size: readonly [number, number, number],
  amplitude: number,
): FeMeshArtifact {
  const base = blockMesh(cells, size);
  const side = Math.min(size[0] / cells[0], size[1] / cells[1], size[2] / cells[2]);
  const interior = (node: readonly number[]): boolean =>
    [1, 2, 3].every((axis) => (node[axis] as number) > 1e-9 && (node[axis] as number) < (size[axis - 1] as number) - 1e-9);
  const scale = new Map(base.nodes.map((node) => [node[0], 1]));
  const build = (): FeMeshArtifact => ({
    ...base,
    nodes: base.nodes.map((node) =>
      interior(node)
        ? ([
            node[0],
            ...[1, 2, 3].map((axis) => (node[axis] as number) + unit(node[0], axis) * amplitude * side * (scale.get(node[0]) ?? 1)),
          ] as unknown as FeMeshArtifact['nodes'][number])
        : node,
    ),
  });
  const reference = tetVolumes(base);
  for (let round = 0; round < 40; round += 1) {
    const mesh = build();
    const inverted = tetVolumes(mesh).flatMap((volume, index) =>
      volume > 0 === (reference[index] as number) > 0 && volume !== 0 ? [] : [index],
    );
    if (inverted.length === 0) return mesh;
    for (const index of inverted)
      for (const id of (base.blocks[0]?.elements[index] ?? []).slice(1, 5)) scale.set(id, (scale.get(id) ?? 1) / 2);
  }
  return build();
}

/** `a` and `b` as one mesh of one part (b's node ids shifted by 100000, its element ids too): the two share no node. */
export function unionMesh(a: FeMeshArtifact, b: FeMeshArtifact): FeMeshArtifact {
  const shift = 100000;
  return {
    ...a,
    nodes: [...a.nodes, ...b.nodes.map((node) => [node[0] + shift, node[1], node[2], node[3]] as const)],
    blocks: [
      ...a.blocks,
      ...b.blocks.map((block) => ({
        ...block,
        elements: block.elements.map((element, index) => [index + 100001, ...element.slice(1).map((id) => id + shift)]),
      })),
    ],
  };
}
