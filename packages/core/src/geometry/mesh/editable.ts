/** Shared preconditions and texts of the editing ops (decimate, remesh) for every mesh engine, so the TypeScript and native engines refuse alike. */

import type { MeshData } from '../../model/types';
import { fastMeasure } from './fastMeasure';
import type { RepairMode } from './repair';
import type { MeshEngineFailure, MeshProvenance } from './engineTypes';

const failure = (code: string, message: string): MeshEngineFailure => ({ code, message });

/** Refusal of ops that need a manifold, consistently wound mesh without degenerate faces; null when `mesh` qualifies. */
export function editableProblem(mesh: MeshData, op: string): MeshEngineFailure | null {
  const measure = fastMeasure(mesh);
  if (measure.nonManifoldEdges > 0)
    return failure('MESH_NON_MANIFOLD', `${op} needs a manifold mesh: ${measure.nonManifoldEdges} edge(s) have more than two faces`);
  if (measure.degenerateFaces > 0)
    return failure('MESH_DEGENERATE', `${op} needs a mesh without degenerate faces: ${measure.degenerateFaces} found`);
  if (measure.inconsistentEdges > 0)
    return failure('MESH_ORIENTATION_INCONSISTENT', `${op} needs a consistently wound mesh: ${measure.inconsistentEdges} edge(s) disagree`);
  return null;
}

type Description = Pick<MeshProvenance, 'algorithm' | 'reference'>;

export const ANALYZE_DESCRIPTION: Description = {
  algorithm: 'indexed-mesh analysis: edge map, union-find shells, boundary chains, Euler characteristic',
  reference: 'Euler-Poincare: chi = 2 - 2g',
};

export const DECIMATE_DESCRIPTION: Description = {
  algorithm: 'quadric error metric edge collapse with link condition, fold-over test and probe-point deviation bound',
  reference: 'Garland and Heckbert, Surface Simplification Using Quadric Error Metrics, SIGGRAPH 1997',
};

export const REMESH_DESCRIPTION: Description = {
  algorithm: 'incremental remeshing: split 4/3 L, collapse 4/5 L, flip to valence 6, tangential relaxation, projection',
  reference: 'Botsch and Kobbelt, A Remeshing Approach to Multiresolution Modeling, SGP 2004',
};

export const QUAD_DESCRIPTION: Description = {
  algorithm: 'QuadriFlow: 4-RoSy orientation field, position field, integer-grid map by max-flow, single thread and fixed seed',
  reference: 'Huang, Zhou, Niessner, Shewchuk and Guibas, QuadriFlow: A Scalable and Robust Method for Quadrangulation, SGP 2018',
};

export const smoothDescription = (taubin: boolean): Description => ({
  algorithm: taubin ? 'Taubin lambda|mu umbrella smoothing' : 'Laplacian umbrella smoothing',
  reference: 'Taubin, A Signal Processing Approach to Fair Surface Design, SIGGRAPH 1995',
});

export const repairDescription = (mode: RepairMode): Description => ({
  algorithm: `repair ${mode}: weld, clean (duplicate / degenerate faces), BFS orientation, boundary-vertex stitch, shell removal, Liepa fill`,
  reference: 'Fusion Repair / Rhino MeshRepair / Magics Fix semantics; Liepa 2003',
});

export const FILL_HOLES_DESCRIPTION: Description = {
  algorithm:
    'Liepa hole filling: O(n^3) dihedral/area triangulation, centroid refinement with Delaunay relaxation, membrane / thin-plate fairing (CG)',
  reference: 'Liepa, Filling Holes in Meshes, SGP 2003, pp. 200-206',
};
