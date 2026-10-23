/** Editing ops of the TypeScript mesh engine (07 MSH M1): repair, hole filling, decimation, remeshing, smoothing, plane cut. */

import { decimateMesh } from './decimate';
import { symmetricDeviation } from './deviation';
import { segmentMesh } from './segment';
import { sculptMesh } from './sculpt';
import { DECIMATE_DESCRIPTION, editableProblem, smoothDescription } from './editable';
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
import { remeshMesh } from './remesh';
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
  { op: 'repair' | 'fill_holes' | 'decimate' | 'remesh' | 'smooth' | 'cut' | 'deviation' | 'segment' | 'sculpt' }
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
];

export function runEditOp(input: MeshInput, op: EditOp): MeshOpResult | MeshEngineFailure {
  const mesh = input.mesh;
  switch (op.op) {
    case 'repair': {
      const result = repairTriangles(mesh, op);
      return {
        mesh: result.mesh,
        report: { mode: op.mode, changes: result.changes, notes: result.notes, skippedHoles: result.skippedHoles },
        provenance: provenance(
          `repair ${op.mode}: weld, clean (duplicate / degenerate faces), BFS orientation, boundary-vertex stitch, shell removal, Liepa fill`,
          'Fusion Repair / Rhino MeshRepair / Magics Fix semantics; Liepa 2003',
        ),
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
        provenance: provenance(
          'Liepa hole filling: O(n^3) dihedral/area triangulation, centroid refinement with Delaunay relaxation, membrane / thin-plate fairing (CG)',
          'Liepa, Filling Holes in Meshes, SGP 2003, pp. 200-206',
        ),
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
      return {
        mesh: result.mesh,
        report: { ...result.report },
        provenance: provenance(
          'incremental remeshing: split 4/3 L, collapse 4/5 L, flip to valence 6, tangential relaxation, projection',
          'Botsch and Kobbelt, A Remeshing Approach to Multiresolution Modeling, SGP 2004',
        ),
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
        provenance: provenance(
          `sculpt brush ${op.brush}: falloff-weighted displacement of the vertices within the radius of each stamp, stamps in order, mirrored in the same pass`,
          'Blender sculpt brush definitions (draw, inflate, grab, smooth, flatten, pinch, crease, layer); TECHNICAL_SPEC 5.7',
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
