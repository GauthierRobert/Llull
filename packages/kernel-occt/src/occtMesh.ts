/**
 * @layer kernel
 * Display tessellation of an OCC shape (BRepMesh_IncrementalMesh, world space, outward winding).
 * Output only: a mesh never goes back into the kernel.
 */

import type { MeshData } from '@core/model/types';
import {
  explorer,
  release,
  type OccApi,
  type OccHandle,
  type OccShape,
  type OccTopoDS,
  type OccTriangulation,
} from './occtTypes';

/** Display deflections: linear (document units), angular (radians). */
const DISPLAY_DEFLECTION = [0.1, 0.5] as const;

/**
 * Display mesh of `shape`, or null. BRepMesh can leave a face without triangles, or a solid's mesh
 * open (a corner where several fillet blends meet); such a shape is refused rather than shown and
 * exported as a holed shell (re-meshing finer does not close those, and can overflow the WASM
 * stack). Open shells (surface parts) are not required to close.
 */
export function extractMeshData(api: OccApi, shape: OccShape): MeshData | null {
  const { mesh, missingFaces } = triangulate(api, shape, DISPLAY_DEFLECTION);
  return missingFaces === 0 && (!hasSolid(api, shape) || isClosed(mesh)) ? mesh : null;
}

interface Triangulated {
  readonly mesh: MeshData | null;
  readonly missingFaces: number;
}

function hasSolid(api: OccApi, shape: OccShape): boolean {
  const exp = explorer(api, shape, 'TopAbs_SOLID');
  try {
    return exp.More() === true;
  } finally {
    exp.delete();
  }
}

/**
 * Whether every triangle edge is shared, vertices welded on a 1e-5 grid. Checked on two grids half
 * a cell apart, so two copies of one vertex that straddle a cell boundary still weld on one of them.
 */
function isClosed(mesh: MeshData | null): boolean {
  return openEdgeCount(mesh) === 0 || openEdgeCount(mesh, 0.5) === 0;
}

/** Triangle edges used by one triangle only, vertices welded by position (0 for a closed mesh). */
function openEdgeCount(mesh: MeshData | null, gridOffset = 0): number {
  if (mesh === null) return 0;
  const { positions, indices } = mesh;
  const weld = new Map<string, number>();
  const vertexId = (corner: number): number => {
    // Integer grid (1e-5) keys: toFixed would key -0.000001 and 0.000001 apart ("-0.00000").
    const key = [0, 1, 2]
      .map((axis) => `${Math.round((positions[corner * 3 + axis] ?? 0) * 1e5 + gridOffset)}`)
      .join(',');
    const known = weld.get(key);
    if (known !== undefined) return known;
    weld.set(key, weld.size);
    return weld.size - 1;
  };
  const uses = new Map<string, number>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => vertexId(indices[t + k] ?? 0));
    for (let k = 0; k < 3; k++) {
      const [a, b] = [corners[k] ?? 0, corners[(k + 1) % 3] ?? 0];
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const count of uses.values()) if (count === 1) open++;
  return open;
}

function triangulate(
  api: OccApi,
  shape: OccShape,
  [linear, angular]: readonly [number, number],
): Triangulated {
  const mesher = new api.BRepMesh_IncrementalMesh_2(
    shape,
    linear,
    false,
    angular,
    false,
  ) as OccHandle & {
    Perform(): void;
  };
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
