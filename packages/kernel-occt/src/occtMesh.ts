/**
 * @layer kernel
 * Display tessellation of an OCC shape (BRepMesh_IncrementalMesh, world space, outward winding).
 * Output only: a mesh never goes back into the kernel.
 */

import type { MeshData } from '@core/geometry/kernel';
import {
  explorer,
  release,
  type OccApi,
  type OccHandle,
  type OccShape,
  type OccTopoDS,
  type OccTriangulation,
} from './occtTypes';

export function extractMeshData(api: OccApi, shape: OccShape): MeshData | null {
  const mesher = new api.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false) as OccHandle & {
    Perform(): void;
  };
  mesher.Perform();

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
        const reversed =
          face.Orientation_1().value === api.TopAbs_Orientation.TopAbs_REVERSED.value;
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

  if (positions.length === 0) return null;
  return { positions, indices };
}
