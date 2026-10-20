/**
 * Midsurface by face pairing (05 §5.2 steps 1-3 and 5) over the exact kernel faces (`faceQuery`): planar faces with reversed normals, a gap
 * <= maxThickness and overlapping projections pair up; the mid face is the smaller face projected onto the mid plane. Cylinder pairs, the
 * extension / sewing of mid faces to their neighbours (step 4) and `BRepAlgoAPI_Common` overlap regions are not built (each listed in warnings).
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import type { FaceDetail } from '@core/geometry/kernelPorts';
import type { ShapeHandle } from '@core/geometry/kernelTypes';
import type { Vec3 } from '@core/model/vectors';
import { add3, dot3, normalize3, scale3, sub3 } from '@lib/vec3';
import { planarLoops } from './faceLoops';
import { distinctThicknesses, extentOf, type MidFace, type Midsurface, type MidsurfaceOptions, type MidsurfaceRefusal } from './types';

interface Pair {
  readonly a: FaceDetail;
  readonly b: FaceDetail;
  readonly gap: number;
}

/** Edge strip (05 §5.2 step 5): a face no wider than maxThickness, e.g. the side wall of a plate; it carries no midsurface. */
function isEdgeStrip(face: FaceDetail, maxThickness: number): boolean {
  const samples = face.samples.length > 0 ? face.samples : [face.centroid];
  const extent = extentOf(samples);
  return face.area <= maxThickness * Math.max(extent, Math.sqrt(face.area)) * 1.01;
}

const project = (point: Vec3, origin: Vec3, normal: Vec3): Vec3 => sub3(point, scale3(normal, dot3(sub3(point, origin), normal)));

/** Candidate pair of two planar faces, or null when they do not face each other across a thin wall with overlapping projections. */
function pairOf(kernel: GeometryKernel, shape: ShapeHandle, a: FaceDetail, b: FaceDetail, options: MidsurfaceOptions): Pair | null {
  if (a.normal === undefined || b.normal === undefined) return null;
  const na = normalize3(a.normal);
  const nb = normalize3(b.normal);
  if (dot3(na, nb) > -Math.cos((options.angularTolDeg * Math.PI) / 180)) return null;
  // Outward normals: material lies behind a, so b sits at a positive depth along -na (a negative depth is an air gap).
  const thickness = -dot3(sub3(b.centroid, a.centroid), na);
  if (!(thickness > 0) || thickness > options.maxThickness) return null;
  const tolerance = 1e-6 * Math.max(1, thickness);
  const overlaps = (from: FaceDetail, onto: FaceDetail, normal: Vec3): boolean =>
    [from.centroid, ...from.samples].some(
      (point) => kernel.faceQuery?.faceContains(shape, onto.index, project(point, onto.centroid, normal), tolerance) === true,
    );
  if (!overlaps(a, b, nb) && !overlaps(b, a, na)) return null;
  return { a, b, gap: thickness };
}

function midFace(kernel: GeometryKernel, shape: ShapeHandle, pair: Pair, deflection: number): MidFace | null {
  const smaller = pair.a.area <= pair.b.area ? pair.a : pair.b;
  const normal = normalize3(pair.a.normal ?? [0, 0, 1]);
  const mesh = kernel.faceQuery?.tessellateFace(shape, smaller.index, deflection) ?? null;
  const loops = mesh === null ? null : planarLoops(mesh, normal);
  if (loops === null) return null;
  const middle = scale3(add3(pair.a.centroid, pair.b.centroid), 0.5);
  const onMid = (point: Vec3): Vec3 => project(point, middle, normal);
  return {
    outer: loops.outer.map(onMid),
    holes: loops.holes.map((hole) => hole.map(onMid)),
    normal,
    thickness: pair.gap,
    source: `faces ${Math.min(pair.a.index, pair.b.index)}+${Math.max(pair.a.index, pair.b.index)}`,
  };
}

/**
 * Face-paired midsurface of `shape` (exact B-rep through `kernel.faceQuery`).
 * @invariant each face pairs at most once (smallest gap first); coverage = paired area / area of the faces that are not edge strips
 * @failure no face query (mesh kernel) -> FEA_KERNEL_OCC_REQUIRED; no planar pair -> FEA_MIDSURFACE_NO_PAIRS
 */
export function pairedMidsurface(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  entityId: string,
  options: MidsurfaceOptions,
): Midsurface | MidsurfaceRefusal {
  const details = kernel.faceQuery?.faceDetails(shape) ?? null;
  if (details === null)
    return { code: 'FEA_KERNEL_OCC_REQUIRED', message: `face pairing of '${entityId}' needs the exact OCC kernel (--kernel occt-native)` };
  const planar = details.filter((face) => face.surface === 'plane' && face.normal !== undefined);
  const candidates: Pair[] = [];
  for (let i = 0; i < planar.length; i++)
    for (let j = i + 1; j < planar.length; j++) {
      const a = planar[i];
      const b = planar[j];
      const pair = a === undefined || b === undefined ? null : pairOf(kernel, shape, a, b, options);
      if (pair !== null) candidates.push(pair);
    }
  candidates.sort((x, y) => x.gap - y.gap || Math.min(x.a.index, x.b.index) - Math.min(y.a.index, y.b.index));
  const used = new Set<number>();
  const pairs: Pair[] = [];
  for (const pair of candidates) {
    if (used.has(pair.a.index) || used.has(pair.b.index)) continue;
    used.add(pair.a.index);
    used.add(pair.b.index);
    pairs.push(pair);
  }
  if (pairs.length === 0)
    return {
      code: 'FEA_MIDSURFACE_NO_PAIRS',
      message: `'${entityId}' has no two planar faces facing each other across a wall <= ${options.maxThickness} thick`,
    };
  const deflection = Math.max(1e-3, Math.min(...pairs.map((pair) => pair.gap)) / 4);
  const faces: MidFace[] = [];
  const warnings: string[] = [];
  for (const pair of pairs) {
    const face = midFace(kernel, shape, pair, deflection);
    if (face === null) warnings.push(`faces ${pair.a.index}+${pair.b.index}: the face outline could not be read from the kernel`);
    else faces.push(face);
  }
  const strips = details.filter((face) => !used.has(face.index) && isEdgeStrip(face, options.maxThickness));
  const unpaired = details.filter((face) => !used.has(face.index) && !strips.includes(face));
  const pairedArea = details.filter((face) => used.has(face.index)).reduce((sum, face) => sum + face.area, 0);
  const counted = pairedArea + unpaired.reduce((sum, face) => sum + face.area, 0);
  if (unpaired.some((face) => face.surface === 'cylinder'))
    warnings.push('cylindrical wall pairs are not built (05 §5.2 step 2): curved walls stay unpaired');
  if (faces.length > 1)
    warnings.push('mid faces are not extended to their neighbours or sewn (05 §5.2 step 4): they join only where their edges coincide');
  return {
    entityId,
    method: 'face_pairing',
    faces,
    thicknesses: distinctThicknesses(pairs.map((pair) => pair.gap)),
    coverage: counted > 0 ? pairedArea / counted : 0,
    unpairedFaces: unpaired.map((face) => face.index).sort((x, y) => x - y),
    warnings,
  };
}
