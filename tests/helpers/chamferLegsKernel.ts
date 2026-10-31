/** A stub exact kernel for the chamfer leg readback tests: contact lines at known distances from a chamfered edge along x. */
import type { GeometryKernel } from '@core/geometry/kernel';
import type { MeshSolidEntity, ShapeRecipe, Vec3 } from '@core/model/types';

export const SOURCE: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };
export const chamfer = (extra: Record<string, unknown> = {}): ShapeRecipe =>
  ({ op: 'chamfer', source: SOURCE, edges: [0], size: 1, sizeEnd: 2, faces: [0], size2: 2, size2End: 4, ...extra }) as ShapeRecipe;

export const entityOf = (brep: ShapeRecipe): MeshSolidEntity => ({ id: 'm', kind: 'mesh', brep }) as never;

/** The edge runs along x from 0 to 10; contact line k lies at the distance `legs[k](x)` from it in the plane perpendicular to x. */
export function stub(
  options: {
    first?: (x: number) => number;
    second?: (x: number) => number;
    missing?: 'chamfer' | 'contact' | 'graph' | 'names' | 'build' | 'crossing';
    /** The face normals at a station (the dihedral of a distance-angle chamfer): the faces 0 and 1 of the source; omitted = the kernel gives no normals. */
    normals?: readonly [Vec3, Vec3];
  } = {},
): GeometryKernel {
  const first = options.first ?? ((x: number) => 1 + x / 10);
  const second = options.second ?? ((x: number) => 2 + (2 * x) / 10);
  const line = (offset: (x: number) => number, direction: Vec3): Vec3[] =>
    Array.from({ length: 41 }, (_, k): Vec3 => [k / 4, direction[1] * offset(k / 4), direction[2] * offset(k / 4)]);
  const sourceTopology = {
    solids: 1,
    vertices: 0,
    volume: 1,
    faces: [
      { index: 0, name: options.missing === 'names' ? undefined : 'top', surface: 'plane', area: 1 },
      { index: 1, name: options.missing === 'names' ? undefined : 'side', surface: 'plane', area: 1 },
    ],
    edges: [{ index: 0, name: 'E', curve: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0], mid: [5, 0, 0] }],
  };
  const resultTopology = {
    ...sourceTopology,
    faces: [
      { index: 0, name: 'top', surface: 'plane', area: 1 },
      { index: 1, name: 'side', surface: 'plane', area: 1 },
      { index: 2, name: options.missing === 'chamfer' ? 'chamfer(other)' : 'chamfer(E)', surface: 'plane', area: 1 },
    ],
    edges: [0, 1].map((index) => ({
      index,
      name: `c${index}`,
      curve: 'line',
      length: 10,
      start: [0, 0, 0],
      end: [10, 0, 0],
      mid: [5, 0, 0],
    })),
  };
  const query = {
    projectOnFace: (_shape: { id: string }, face: number, points: readonly Vec3[]) =>
      options.normals === undefined
        ? null
        : points.map((point) => ({ point, normal: options.normals?.[face] as Vec3, uv: [0, 0], distance: 0 })),
    faceGraph: (shape: { id: string }) =>
      options.missing === 'graph' && shape.id === 'result'
        ? null
        : shape.id === 'source'
          ? { faces: [], edgeFaces: [[0, 1]], edgeConvexity: ['convex'] }
          : {
              faces: [{ loops: [] }, { loops: [] }, { loops: [options.missing === 'contact' ? [0] : [0, 1]] }],
              edgeFaces: [
                [2, 0],
                [2, 1],
              ],
              edgeConvexity: ['smooth', 'smooth'],
            },
    edgeSamples: (shape: { id: string }, edge: number) =>
      shape.id === 'source'
        ? Array.from({ length: 21 }, (_, k) => ({
            t: k / 20,
            s: (10 * k) / 20,
            point: [k / 2, 0, 0] as Vec3,
            tangent: [1, 0, 0] as Vec3,
            curvature: 0,
            dCurvatureDs: 0,
            torsion: 0,
            normal: [0, 1, 0] as Vec3,
          }))
        : line(edge === 0 ? first : second, edge === 0 ? [0, 0, 1] : [0, 1, 0]).map((point, k) => ({
            t: k / 40,
            s: k / 4,
            point: options.missing === 'crossing' ? ([point[0] + 100, point[1], point[2]] as Vec3) : point,
            tangent: [1, 0, 0] as Vec3,
            curvature: 0,
            dCurvatureDs: 0,
            torsion: 0,
            normal: [0, 1, 0] as Vec3,
          })),
  };
  return {
    name: 'stub',
    evaluate: (recipe: ShapeRecipe) => (options.missing === 'build' ? null : recipe.op === 'chamfer' ? { id: 'result' } : { id: 'source' }),
    topology: (shape: { id: string }) => (shape.id === 'source' ? sourceTopology : resultTopology),
    faceQuery: query,
  } as unknown as GeometryKernel;
}
