/**
 * Display tessellation of an OCC shape (BRepMesh_IncrementalMesh, world space, outward winding).
 * Output only: a mesh never goes back into the kernel.
 */

import type { MeshData } from '@core/model/types';
import { isClosedMesh } from './meshClosure';
import { hasManyFreeformFaces } from './occtFreeform';
import { release } from '@core/geometry/nativeObject';
import { explorer, type OccApi, type OccHandle, type OccExplorer, type OccShape, type OccTopoDS, type OccTriangulation } from './occtTypes';

/** Display deflections: linear (document units), angular (radians). */
const DISPLAY_DEFLECTION = [0.1, 0.5] as const;
/** Retry for freeform-heavy solids (a modelled thread has 0.1 mm features): their faces mesh open at the display deflection. */
const FINE_DEFLECTION = [0.02, 0.2] as const;

/**
 * Display mesh of `shape`, or null. BRepMesh can leave a face without triangles, or a solid's mesh
 * open (a corner where several fillet blends meet); a closed solid is then refused rather than
 * shown and exported as a holed shell (re-meshing finer does not close those, and can overflow the
 * WASM stack; only a freeform-heavy solid is retried finer). Surface parts and compounds with free faces keep the old, lenient behaviour.
 */
export function extractMeshData(api: OccApi, shape: OccShape): MeshData | null {
  const first = triangulate(api, shape, DISPLAY_DEFLECTION);
  if (!isClosedSolid(api, shape)) return first.mesh;
  if (first.missingFaces === 0 && isClosedMesh(first.mesh)) return first.mesh;
  if (!hasManyFreeformFaces(api, shape)) return null;
  const fine = triangulate(api, shape, FINE_DEFLECTION);
  return fine.missingFaces === 0 && isClosedMesh(fine.mesh) ? fine.mesh : null;
}

interface Triangulated {
  readonly mesh: MeshData | null;
  readonly missingFaces: number;
}

/** Whether `shape` holds a solid and no face outside a solid (explorer: faces, avoiding solids). */
function isClosedSolid(api: OccApi, shape: OccShape): boolean {
  const solids = explorer(api, shape, 'TopAbs_SOLID');
  const freeFaces = new api.TopExp_Explorer_2(shape, api.TopAbs_ShapeEnum.TopAbs_FACE, api.TopAbs_ShapeEnum.TopAbs_SOLID) as OccExplorer;
  try {
    return solids.More() === true && freeFaces.More() !== true;
  } finally {
    solids.delete();
    freeFaces.delete();
  }
}

function triangulate(api: OccApi, shape: OccShape, [linear, angular]: readonly [number, number]): Triangulated {
  const mesher = new api.BRepMesh_IncrementalMesh_2(shape, linear, false, angular, false) as OccHandle & { Perform(): void };
  mesher.Perform();
  let missingFaces = 0;

  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  const exp = explorer(api, shape, 'TopAbs_FACE');
  try {
    while (exp.More()) {
      const current = exp.Current();
      const face = (api.TopoDS as OccTopoDS).Face_1(current);
      const loc = new api.TopLoc_Location_1() as OccHandle & { Transformation(): OccHandle };
      const triangulation = api.BRep_Tool.Triangulation(face, loc) as OccTriangulation;

      if (!triangulation.IsNull()) {
        const tri = triangulation.get();
        const nNodes = tri.NbNodes();
        const nTris = tri.NbTriangles();

        // Nodes are stored in the face's own frame; `loc` carries the shape's placement (a prism's
        // top face, a transformed shape's faces), so bring them into world space.
        const placement = loc.Transformation();
        for (let i = 1; i <= nNodes; i++) {
          const node = tri.Node(i);
          node.Transform(placement);
          positions.push(node.X(), node.Y(), node.Z());
          release(node);
        }
        release(placement);

        // A REVERSED face's stored triangles wind against the solid's outward normal: flip them.
        const reversed = face.Orientation_1().value === api.TopAbs_Orientation.TopAbs_REVERSED.value;
        for (let i = 1; i <= nTris; i++) {
          const t = tri.Triangle(i);
          const [first, second, third] = [t.Value(1), t.Value(2), t.Value(3)];
          indices.push(
            vertexOffset + first - 1,
            vertexOffset + (reversed ? third : second) - 1,
            vertexOffset + (reversed ? second : third) - 1,
          );
          release(t);
        }

        vertexOffset += nNodes;
      } else {
        missingFaces++;
      }

      release(triangulation);
      release(face);
      release(current);
      loc.delete();
      exp.Next();
    }
  } finally {
    exp.delete();
    mesher.delete();
  }

  return { mesh: positions.length === 0 ? null : { positions, indices }, missingFaces };
}
