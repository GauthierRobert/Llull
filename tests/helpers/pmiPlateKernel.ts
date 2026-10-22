/**
 * Analytic fake exact kernel for the 03 GDT tests: every shape is the validation plate (120 x 80 x 12, anchor min, four holes of radius
 * 3.3 at (20,20) (100,20) (20,60) (100,60) and a bore of radius 10 at (60,40)), with exact faces, topology and the face-query port answering
 * from closed forms. `thickness` models the parametric edit of VC-GDT-02 (top face and hole height follow it).
 */
import type { GeometryKernel, ShapeTopology } from '@core/geometry/kernel';
import type { FaceDetail, FaceQueryPort } from '@core/geometry/kernelPorts';
import type { MeshData, Vec3 } from '@core/model/types';
import { fakeKernel } from './fakeKernel';

const HOLES: ReadonlyArray<readonly [number, number, number]> = [
  [20, 20, 3.3],
  [100, 20, 3.3],
  [20, 60, 3.3],
  [100, 60, 3.3],
  [60, 40, 10],
];

export interface PlateOptions {
  thickness: number;
  /** Drop the optional face-query port (a mesh kernel). */
  noFaceQuery?: boolean;
  /** Pretend the bottom face (datum A) is a bspline (surface type change). */
  bottomAsBspline?: boolean;
}

function plateMesh(t: number): MeshData {
  const c = [0, 0, 0, 120, 0, 0, 120, 80, 0, 0, 80, 0, 0, 0, t, 120, 0, t, 120, 80, t, 0, 80, t];
  return { positions: c, indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4] };
}

function plateFaces(t: number, options: Pick<PlateOptions, 'bottomAsBspline'> = {}): FaceDetail[] {
  const planes: Array<[string, Vec3, Vec3]> = [
    ['bottom', [0, 0, -1], [60, 40, 0]],
    ['top', [0, 0, 1], [60, 40, t]],
    ['front', [0, -1, 0], [60, 0, t / 2]],
    ['back', [0, 1, 0], [60, 80, t / 2]],
    ['left', [-1, 0, 0], [0, 40, t / 2]],
    ['right', [1, 0, 0], [120, 40, t / 2]],
  ];
  const faces: FaceDetail[] = planes.map(([name, normal, centroid], index) => ({
    index,
    surface: name === 'bottom' && options.bottomAsBspline === true ? 'bspline' : 'plane',
    area: 1,
    centroid,
    ...(name === 'bottom' && options.bottomAsBspline === true ? {} : { normal }),
    samples: name === 'bottom' ? [centroid, [30, 10, 0]] : [centroid],
  }));
  HOLES.forEach(([x, y, r], k) =>
    faces.push({
      index: 6 + k,
      surface: 'cylinder',
      area: 2 * Math.PI * r * t,
      centroid: [x, y, t / 2],
      axis: { origin: [x, y, 0], dir: [0, 0, 1] },
      radius: r,
      samples: [
        [x + r, y, t / 2],
        [x - r, y, t / 2],
        [x, y + r, t / 2],
        [x, y - r, t / 2],
      ],
    }),
  );
  return faces;
}

function contains(faces: readonly FaceDetail[], t: number, index: number, p: Vec3): boolean {
  const eps = 1e-6;
  const inBox = p[0] >= -eps && p[0] <= 120 + eps && p[1] >= -eps && p[1] <= 80 + eps && p[2] >= -eps && p[2] <= t + eps;
  const face = faces[index];
  if (face === undefined || !inBox) return false;
  if (face.surface === 'cylinder') return p[2] >= -eps && p[2] <= t + eps;
  const inHole = HOLES.some(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) < r - eps);
  return face.normal !== undefined && Math.abs(face.normal[2]) === 1 ? !inHole : true;
}

/** The plate kernel; `options.thickness` can be changed between calls (the next evaluation uses it). */
export function plateKernel(options: PlateOptions = { thickness: 12 }): GeometryKernel & { readonly options: PlateOptions } {
  const mesh = plateMesh(options.thickness);
  const topology = (): ShapeTopology => ({
    solids: 1,
    faces: plateFaces(options.thickness, options).map((face) => ({
      index: face.index,
      surface: face.surface,
      area: face.area,
      ...(face.surface === 'cylinder' ? { convex: false } : {}),
    })),
    edges: [],
    vertices: 8,
    volume: 1,
  });
  const port: FaceQueryPort = {
    faceDetails: () => plateFaces(options.thickness, options),
    faceContains: (_shape, face, point) => contains(plateFaces(options.thickness, options), options.thickness, face, point),
    faceGraph: () => null,
    faceGeometry: () => null,
    projectOnFace: () => null,
    evaluateFace: () => null,
    tessellateFace: () => null,
    faceSamples: () => null,
    edgeSamples: () => null,
    edgeContinuity: () => null,
    distance: () => null,
    bspline: () => null,
    projectCurves: () => null,
  };
  const base = fakeKernel({ solid: mesh, boolean: mesh, fillet: mesh, chamfer: mesh });
  const kernel = Object.assign(base, { topology, tessellate: () => plateMesh(options.thickness), options });
  return options.noFaceQuery === true ? kernel : Object.assign(kernel, { faceQuery: port });
}
