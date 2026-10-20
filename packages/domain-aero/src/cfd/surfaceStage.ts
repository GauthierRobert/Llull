/** Surface stage of cfd_prepare (TECHNICAL_SPEC §5.1 steps 2-5): union, case frame in metres, weld, watertight, orientation, self-intersection, hash. */

import type { GeometryKernel } from '@core/geometry/kernel';
import { toMetres } from '@core/model/units';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { CfdCase } from '@core/model/cfd';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { add3, scale3 } from '@lib/vec3';
import { buildSurface, leafBounds, type BuiltSurface, type Leaf } from './flowSurface';
import { caseFrame, toCaseFrame, type CaseFrame } from './frame';
import { findSelfIntersections, type IntersectionReport } from './selfIntersection';
import { edgeReport, flipped, signedVolume, surfaceArea, surfaceBounds, type EdgeReport } from './topology';
import { weldSurface, type IndexedSurface } from './weld';

/** Vertices closer than this fraction of the body length are one vertex. */
export const WELD_TOLERANCE_PER_LENGTH = 1e-6;
/** Triangles smaller than this fraction of the squared body length are dropped. */
export const DEGENERATE_AREA_PER_LENGTH_SQ = 1e-12;

export interface SurfaceStage {
  readonly built: BuiltSurface;
  /** Welded, outward oriented when closed; metres, case frame. */
  readonly surface: IndexedSurface;
  readonly frame: CaseFrame;
  readonly metresPerUnit: number;
  readonly degenerate: number;
  readonly edges: EdgeReport;
  /** Closed, consistently oriented 2-manifold, apart from open edges of bodies tagged inlet / outlet (`edges.openingEdges`). */
  readonly closed: boolean;
  /** The winding was reversed because the signed volume was negative. */
  readonly flipped: boolean;
  readonly areaM2: number;
  readonly volumeM3: number;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  /** Largest body extent, m. */
  readonly lengthM: number;
  /** Null when the test was not run (too many triangles). */
  readonly intersections: IntersectionReport | null;
  readonly geometryHash: string;
}

const hashSurface = ({ vertices, triangles }: IndexedSurface): string =>
  sha256Hex(canonicalJson({ v: vertices.map((value) => Math.round(value * 1e9)), t: triangles }));

/** Case-frame metres of a flat world xyz array in document units. */
function toFrameMetres(positions: readonly number[], frame: CaseFrame, scale: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const point: Vec3 = [(positions[i] ?? 0) * scale, (positions[i + 1] ?? 0) * scale, (positions[i + 2] ?? 0) * scale];
    out.push(...toCaseFrame(frame, point));
  }
  return out;
}

/**
 * @invariant the hash covers the welded, oriented surface (1e-9 m grid) and nothing else, so equal documents give equal hashes
 * @invariant the self-intersection test is skipped (null) when the bodies need a kernel union or there are too many triangles
 */
export function prepareSurface(doc: CadDocument, cfdCase: CfdCase, leaves: readonly Leaf[], kernel: GeometryKernel | null): SurfaceStage {
  const built = buildSurface(doc, leaves, kernel);
  const openingKinds: readonly string[] = ['inlet', 'outlet'];
  const openingOwners = cfdCase.boundaries.filter((tag) => openingKinds.includes(tag.kind)).map((tag) => tag.entityId);
  const openingBoxes = leafBounds(doc, leaves).filter((box) => openingOwners.includes(box.ownerId));
  const frame = caseFrame(cfdCase.flowAxis, cfdCase.upAxis);
  const metresPerUnit = toMetres(doc, 1);
  const raw = toFrameMetres(built.positions, frame, metresPerUnit);
  const rough = surfaceBounds({ vertices: raw, triangles: [] });
  const roughLength = raw.length === 0 ? 0 : Math.max(...[0, 1, 2].map((axis) => (rough.max[axis] ?? 0) - (rough.min[axis] ?? 0)));
  const welded = weldSurface(raw, built.indices, WELD_TOLERANCE_PER_LENGTH * roughLength, DEGENERATE_AREA_PER_LENGTH_SQ * roughLength ** 2);
  const slack = (WELD_TOLERANCE_PER_LENGTH * roughLength + 1e-9) / metresPerUnit;
  const inOpening = (mid: Vec3): boolean => {
    if (openingBoxes.length === 0) return false;
    const world = scale3(add3(add3(scale3(frame.x, mid[0]), scale3(frame.y, mid[1])), scale3(frame.z, mid[2])), 1 / metresPerUnit);
    return openingBoxes.some(({ min, max }) =>
      [0, 1, 2].every((a) => (world[a] ?? 0) >= (min[a] ?? 0) - slack && (world[a] ?? 0) <= (max[a] ?? 0) + slack),
    );
  };
  const edges = edgeReport(welded, inOpening);
  const closed = welded.triangles.length > 0 && edges.openEdges === 0 && edges.nonManifoldEdges === 0 && edges.misorientedEdges === 0;
  const volume = signedVolume(welded);
  const reverse = closed && edges.openingEdges === 0 && volume < 0;
  const oriented: IndexedSurface = reverse ? flipped(welded) : welded;
  const blocked = built.method === 'display_triangles' && built.overlaps.length > 0;
  const bounds = surfaceBounds(oriented);
  return {
    built,
    surface: oriented,
    frame,
    metresPerUnit,
    degenerate: welded.degenerate,
    edges,
    closed,
    flipped: reverse,
    areaM2: surfaceArea(oriented),
    volumeM3: Math.abs(volume),
    bounds: welded.triangles.length === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : bounds,
    lengthM: welded.triangles.length === 0 ? 0 : Math.max(...[0, 1, 2].map((axis) => (bounds.max[axis] ?? 0) - (bounds.min[axis] ?? 0))),
    intersections: blocked ? null : findSelfIntersections(oriented),
    geometryHash: hashSurface(oriented),
  };
}
