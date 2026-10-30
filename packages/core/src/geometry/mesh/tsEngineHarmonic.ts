/** The `harmonic_map` op of the TypeScript mesh engine (13.26): `harmonicMap` over the whole input mesh, answered as `MeshOpResult.harmonic`. The oracle of the native twin. */

import { harmonicMap } from './harmonicMap';
import type { MeshEngineFailure, MeshInput, MeshOp, MeshOpResult } from './engineTypes';

/** @failure a region that is not a disk, or whose map does not solve or folds -> the refusal of `harmonicMap` (MESH_FIT_NOT_DISK / MESH_FIT_PARAM_FOLDED) */
export function runHarmonicOp(input: MeshInput, op: Extract<MeshOp, { op: 'harmonic_map' }>): MeshOpResult | MeshEngineFailure {
  const faces = Array.from({ length: Math.floor(input.mesh.indices.length / 3) }, (_, f) => f);
  const mapped = harmonicMap(input.mesh, faces, op.maxIterations === undefined ? {} : { maxIterations: op.maxIterations });
  if ('code' in mapped) return { code: mapped.code, message: mapped.message };
  const vertices = [...mapped.uv.keys()].sort((a, b) => a - b);
  return {
    harmonic: {
      vertices,
      uv: vertices.flatMap((v) => mapped.uv.get(v) as [number, number]),
      weights: mapped.weights,
      flippedFirst: mapped.flippedFirst,
      collapsedInParameters: mapped.collapsedInParameters,
      interiorVertices: mapped.interiorVertices,
      boundaryVertices: mapped.boundaryVertices,
      cgIterations: mapped.cgIterations,
      cgResidual: mapped.cgResidual,
      corners: mapped.corners,
    },
    report: { weights: mapped.weights, cgIterations: mapped.cgIterations },
    provenance: {
      engine: 'ts',
      version: 'llull-ts-1',
      algorithm:
        'harmonic map onto the unit square: cotangent Laplacian (Jacobi-preconditioned CG), Floater mean-value weights (BiCGSTAB) when a triangle flips',
      reference: 'Eck et al. 1995 (harmonic maps); Floater 2003 (mean value coordinates)',
      deterministic: true,
    },
  };
}
