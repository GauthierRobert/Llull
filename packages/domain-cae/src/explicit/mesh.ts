/**
 * Solver mesh of an explicit case: a structured hexahedral grid on axis-aligned boxes (hex8) or the linear tets of the 05 mesh artifact (tet4).
 * Coordinates in the case length unit. Hex node order: bottom face (local z-) counter-clockwise seen from +z, then the top face above it
 * (node k + 4 above node k) - the order Flanagan & Belytschko (1981) and the LS-DYNA solid element use.
 */

import type { AnalysisCase, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { MAX_STRUCTURED_NODES } from './defaults';

export interface ExplicitMesh {
  /** 3 coordinates per node. */
  readonly nodes: readonly number[];
  /** 8 node indices per hex8 element. */
  readonly hex8: readonly number[];
  /** 4 node indices per tet4 element. */
  readonly tet4: readonly number[];
  /** 4 node indices per Belytschko–Tsay shell. */
  readonly shell4: readonly number[];
  /** Thickness per shell, case length unit. */
  readonly shellThickness: readonly number[];
  /** Part (entity id) per element: hex8 elements first, then tet4, then shells. */
  readonly elementPart: readonly string[];
  /** Part per node (the first element that uses it). */
  readonly nodePart: readonly string[];
}

export interface MeshRefusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

const CORNERS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

/**
 * Structured hex8 grid over every part (each part meshed on its own: no shared nodes between parts); the parts in `shells` become a grid of
 * shells on their mid-surface across the two largest dimensions (thickness = the smallest one, normal along it).
 * @failure a part that is not an unrotated box, or a grid above MAX_STRUCTURED_NODES -> EXP_MESH_UNSUPPORTED
 */
export function structuredHexMesh(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  size: number,
  lengthToAnalysis: number,
  shells: Readonly<Record<string, unknown>> = {},
): ExplicitMesh | MeshRefusal {
  const nodes: number[] = [];
  const hex8: number[] = [];
  const shell4: number[] = [];
  const shellThickness: number[] = [];
  const shellPart: string[] = [];
  const elementPart: string[] = [];
  const nodePart: string[] = [];
  for (const entityId of Object.keys(analysisCase.parts).sort()) {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity?.kind !== 'box' || entity.rotation.some((angle) => angle !== 0))
      return {
        code: 'EXP_MESH_UNSUPPORTED',
        message: `structured_hex meshes unrotated boxes only; '${entityId}' is ${entity === undefined ? 'missing' : entity.kind === 'box' ? 'rotated' : entity.kind}`,
        ids: [entityId],
      };
    const min = entity.position.map((centre, axis) => centre - (entity.size[axis] ?? 0) / 2);
    if (Object.hasOwn(shells, entityId)) {
      const thin = [0, 1, 2].reduce((best, axis) => ((entity.size[axis] ?? 0) < (entity.size[best] ?? 0) ? axis : best), 0);
      const [u, v] = thin === 2 ? [0, 1] : thin === 0 ? [1, 2] : [2, 0];
      const [nu, nv] = [u, v].map((axis) => Math.max(1, Math.round((entity.size[axis] ?? 0) / size)));
      const base = nodes.length / 3;
      for (let j = 0; j <= (nv ?? 1); j++)
        for (let i = 0; i <= (nu ?? 1); i++) {
          const point = [0, 0, 0];
          point[u] = (min[u] ?? 0) + (i * (entity.size[u] ?? 0)) / (nu ?? 1);
          point[v] = (min[v] ?? 0) + (j * (entity.size[v] ?? 0)) / (nv ?? 1);
          point[thin] = (min[thin] ?? 0) + (entity.size[thin] ?? 0) / 2;
          nodes.push(...point.map((value) => value * lengthToAnalysis));
          nodePart.push(entityId);
        }
      const at = (i: number, j: number): number => base + i + ((nu ?? 1) + 1) * j;
      for (let j = 0; j < (nv ?? 1); j++)
        for (let i = 0; i < (nu ?? 1); i++) {
          shell4.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
          shellThickness.push((entity.size[thin] ?? 0) * lengthToAnalysis);
          shellPart.push(entityId);
        }
      continue;
    }
    const counts = entity.size.map((extent) => Math.max(1, Math.round(extent / size)));
    const [nx = 1, ny = 1, nz = 1] = counts;
    if (nodes.length / 3 + (nx + 1) * (ny + 1) * (nz + 1) > MAX_STRUCTURED_NODES)
      return {
        code: 'EXP_MESH_UNSUPPORTED',
        message: `the structured grid exceeds ${MAX_STRUCTURED_NODES} nodes: use a larger size`,
        ids: [entityId],
      };
    const base = nodes.length / 3;
    const node = (i: number, j: number, k: number): number => base + i + (nx + 1) * (j + (ny + 1) * k);
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) {
          nodes.push(
            ((min[0] ?? 0) + (i * entity.size[0]) / nx) * lengthToAnalysis,
            ((min[1] ?? 0) + (j * entity.size[1]) / ny) * lengthToAnalysis,
            ((min[2] ?? 0) + (k * entity.size[2]) / nz) * lengthToAnalysis,
          );
          nodePart.push(entityId);
        }
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          for (const [di, dj, dk] of CORNERS) hex8.push(node(i + di, j + dj, k + dk));
          elementPart.push(entityId);
        }
  }
  return { nodes, hex8, tet4: [], shell4, shellThickness, elementPart: [...elementPart, ...shellPart], nodePart };
}

/**
 * tet4 mesh from the 05 mesh artifact (its coordinates are already in the case unit system).
 * @failure any block other than C3D4 (quadratic or 2D elements) -> EXP_MESH_UNSUPPORTED
 */
export function feaTetMesh(mesh: FeMeshArtifact): ExplicitMesh | MeshRefusal {
  const unsupported = mesh.blocks.find((block) => block.type !== 'C3D4');
  if (unsupported !== undefined)
    return {
      code: 'EXP_MESH_UNSUPPORTED',
      message: `the case mesh has ${unsupported.type} elements on '${unsupported.entityId}': llull_explicit reads linear tets (set_mesh_controls order 1, elementFamily tet)`,
      ids: [unsupported.entityId],
    };
  const index = new Map<number, number>();
  const nodes: number[] = [];
  for (const [id, x, y, z] of mesh.nodes) {
    index.set(id, index.size);
    nodes.push(x, y, z);
  }
  const nodePart: string[] = new Array<string>(index.size).fill('');
  const tet4: number[] = [];
  const elementPart: string[] = [];
  for (const block of mesh.blocks)
    for (const element of block.elements) {
      for (const id of element.slice(1, 5)) {
        const at = index.get(id) ?? 0;
        tet4.push(at);
        if (nodePart[at] === '') nodePart[at] = block.entityId;
      }
      elementPart.push(block.entityId);
    }
  return { nodes, hex8: [], tet4, shell4: [], shellThickness: [], elementPart, nodePart };
}
