/** Editing ops of the TypeScript mesh engine (07 MSH M1): repair, hole filling, decimation, remeshing, smoothing, plane cut. */

import { decimateMesh } from './decimate';
import { symmetricDeviation } from './deviation';
import { segmentMesh } from './segment';
import { SCULPT_MAX_TRIANGLES, sculptMesh } from './sculpt';
import { displaceMesh, shrinkwrapMesh } from './wrapDisplace';
import {
  DECIMATE_DESCRIPTION,
  FILL_HOLES_DESCRIPTION,
  REMESH_DESCRIPTION,
  editableProblem,
  repairDescription,
  sculptDescription,
  smoothDescription,
} from './editable';
import {
  MESH_TS_TRIANGLE_CAP,
  type MeshEngineFailure,
  type MeshInput,
  type MeshOp,
  type MeshOpResult,
  type MeshProvenance,
} from './engineTypes';
import { fillHoles } from './holeFill';
import { cutMeshByPlane } from './planeCut';
import { REMESH_MAX_TRIANGLES, remeshMesh } from './remesh';
import { repairTriangles } from './repair';
import { smoothMesh } from './smooth';

const TS_VERSION = 'llull-ts-1';

const provenance = (algorithm: string, reference: string): MeshProvenance => ({
  engine: 'ts',
  version: TS_VERSION,
  algorithm,
  reference,
  deterministic: true,
});

const failure = (code: string, message: string): MeshEngineFailure => ({ code, message });

type EditOp = Extract<
  MeshOp,
  {
    op: 'repair' | 'fill_holes' | 'decimate' | 'remesh' | 'smooth' | 'cut' | 'deviation' | 'segment' | 'sculpt' | 'shrinkwrap' | 'displace';
  }
>;

/** Ops answered by `runEditOp`. */
export const EDIT_OPS: ReadonlyArray<EditOp['op']> = [
  'repair',
  'fill_holes',
  'decimate',
  'remesh',
  'smooth',
  'cut',
  'deviation',
  'segment',
  'sculpt',
  'shrinkwrap',
  'displace',
];

export function runEditOp(input: MeshInput, op: EditOp): MeshOpResult | MeshEngineFailure {
  const mesh = input.mesh;
  switch (op.op) {
    case 'repair': {
      const result = repairTriangles(mesh, op);
      return {
        mesh: result.mesh,
        report: { mode: op.mode, changes: result.changes, notes: result.notes, skippedHoles: result.skippedHoles },
        provenance: provenance(repairDescription(op.mode).algorithm, repairDescription(op.mode).reference),
      };
    }
    case 'fill_holes': {
      const result = fillHoles(mesh.positions, mesh.indices, op);
      if (result.notFound !== null) return failure('MESH_HOLE_NOT_FOUND', result.notFound);
      const blocked = result.skipped[0];
      if (result.explicit && blocked !== undefined)
        return failure(blocked.code, `boundary loop ${blocked.loop} (${blocked.edges} edges) cannot be filled: ${blocked.code}`);
      return {
        mesh: result.mesh,
        report: { totalLoops: result.totalLoops, filled: result.filled, skipped: result.skipped },
        provenance: provenance(FILL_HOLES_DESCRIPTION.algorithm, FILL_HOLES_DESCRIPTION.reference),
      };
    }
    case 'decimate': {
      const problem = editableProblem(mesh, 'decimate_mesh');
      if (problem !== null) return problem;
      const result = decimateMesh(mesh, op);
      return {
        mesh: result.mesh,
        report: { ...result.report },
        provenance: provenance(DECIMATE_DESCRIPTION.algorithm, DECIMATE_DESCRIPTION.reference),
      };
    }
    case 'remesh': {
      const problem = editableProblem(mesh, 'remesh_mesh');
      if (problem !== null) return problem;
      const result = remeshMesh(mesh, op);
      if ('tooLarge' in result)
        return failure(
          'MESH_REMESH_RESULT_TOO_LARGE',
          `the remeshed surface passed ${result.tooLarge} triangles (limit ${op.maxTriangles ?? REMESH_MAX_TRIANGLES}): use a longer target edge`,
        );
      return {
        mesh: result.mesh,
        report: { ...result.report },
        provenance: provenance(REMESH_DESCRIPTION.algorithm, REMESH_DESCRIPTION.reference),
      };
    }
    case 'smooth': {
      const result = smoothMesh(mesh.positions, mesh.indices, op);
      return {
        mesh: { positions: result.positions, indices: [...mesh.indices] },
        report: {
          mu: result.mu,
          volumeBefore: result.volumeBefore,
          volumeAfter: result.volumeAfter,
          volumeCorrected: result.volumeCorrected,
          meanDisplacement: result.meanDisplacement,
          maxDisplacement: result.maxDisplacement,
        },
        provenance: provenance(smoothDescription(op.method === 'taubin').algorithm, smoothDescription(op.method === 'taubin').reference),
      };
    }
    case 'deviation': {
      if (op.other.mesh.indices.length / 3 > MESH_TS_TRIANGLE_CAP)
        return failure(
          'MESH_ENGINE_CAP_EXCEEDED',
          `"deviation" against ${op.other.mesh.indices.length / 3} triangles exceeds the ts engine cap of ${MESH_TS_TRIANGLE_CAP}`,
        );
      const deviation = symmetricDeviation(mesh, op.other.mesh, op.maxSamples);
      if (deviation === null) return failure('MESH_NOT_A_MESH', 'a mesh without triangles has no surface to measure');
      return {
        deviation,
        report: {},
        provenance: provenance(
          'closest-surface distance from vertices and triangle centroids, both ways',
          'bounding-volume closest point (Ericson 5.1.5)',
        ),
      };
    }
    case 'segment': {
      const problem = editableProblem(mesh, 'segment_mesh');
      if (problem !== null) return problem;
      return {
        segmentation: segmentMesh(mesh, op),
        report: {},
        provenance: provenance(
          'smooth regions across edges below the feature angle, each fitted by plane / sphere / cylinder / cone (Levenberg-Marquardt), lowest BIC within the tolerance',
          'smooth-region growing with least-squares primitive fits; model choice by the Bayesian information criterion (Schwarz, Estimating the dimension of a model, 1978)',
        ),
      };
    }
    case 'sculpt': {
      const result = sculptMesh(mesh, op);
      if ('tooLarge' in result)
        return failure(
          'MESH_SCULPT_RESULT_TOO_LARGE',
          `the refined surface passed ${result.tooLarge} triangles (limit ${op.maxTriangles ?? SCULPT_MAX_TRIANGLES}): use a longer refineEdge, or sculpt a smaller region`,
        );
      if (result.offSurface !== null)
        return failure(
          'MESH_SCULPT_STAMP_OFF_SURFACE',
          `stamp ${result.offSurface} is farther than the radius ${op.radius} from the mesh surface`,
        );
      return {
        mesh: result.mesh,
        report: {
          movedVertices: result.movedVertices,
          maxDisplacement: result.maxDisplacement,
          displacedVolume: result.displacedVolume,
          volumeBasis: result.volumeBasis,
          symmetryError: result.symmetryError,
          refinedEdges: result.refinedEdges,
          stampsApplied: result.stampsApplied,
        },
        provenance: provenance(sculptDescription(op.brush).algorithm, sculptDescription(op.brush).reference),
      };
    }
    case 'shrinkwrap': {
      if (op.target.mesh.indices.length / 3 > MESH_TS_TRIANGLE_CAP)
        return failure(
          'MESH_ENGINE_CAP_EXCEEDED',
          `"shrinkwrap" onto ${op.target.mesh.indices.length / 3} triangles exceeds the ts engine cap of ${MESH_TS_TRIANGLE_CAP}`,
        );
      if (op.target.mesh.indices.length === 0) return failure('MESH_NOT_A_MESH', 'the target has no triangles to wrap onto');
      const result = shrinkwrapMesh(mesh, op.target.mesh, op);
      return {
        mesh: result.mesh,
        report: {
          moved: result.moved,
          missed: result.missed,
          maxMove: result.maxMove,
          meanMove: result.meanMove,
          residual: result.residual,
        },
        provenance: provenance(
          `shrink-wrap, mode ${op.mode}: each vertex put on the target surface (closest point, or the first hit along its normal / a fixed direction), offset along the target face normal`,
          'Blender Shrinkwrap modifier (nearest surface point, project); closest point by bounding-volume tree (Ericson 5.1.5)',
        ),
      };
    }
    case 'displace': {
      const result = displaceMesh(mesh, op);
      if ('failure' in result) return failure('MESH_DISPLACE_FIELD', result.failure);
      if ('tooLarge' in result)
        return failure(
          'MESH_DISPLACE_RESULT_TOO_LARGE',
          `the refined surface passed ${result.tooLarge} triangles (limit ${op.maxTriangles ?? SCULPT_MAX_TRIANGLES}): use a longer refineEdge`,
        );
      return {
        mesh: result.mesh,
        report: {
          movedVertices: result.movedVertices,
          maxDisplacement: result.maxDisplacement,
          displacedVolume: result.displacedVolume,
          volumeBasis: result.volumeBasis,
          refinedEdges: result.refinedEdges,
        },
        provenance: provenance(
          'displacement of every vertex by strength x a scalar field (expression of x, y, z and the normal, or a bilinear height map) along its normal or a fixed direction, after global edge refinement',
          'Blender Displace modifier (texture, strength, midlevel, direction)',
        ),
      };
    }
    case 'cut': {
      const result = cutMeshByPlane(mesh, op.origin, op.normal, op.side, op.cap, op.epsilon);
      return {
        mesh: result.mesh,
        report: { loops: result.loops, capTriangles: result.capTriangles, capArea: result.capArea, uncapped: result.uncapped },
        provenance: provenance(
          'exact triangle clipping against the plane, section loops chained and capped by polygon triangulation',
          'standard polygon clipping',
        ),
      };
    }
  }
}
