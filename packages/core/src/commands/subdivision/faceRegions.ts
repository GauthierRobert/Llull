/** Face-region selection of extrude / inset: references, mirror closure, edge-connected regions with their normals. */

import type { SubdivisionEntity, Vec3 } from '../../model/types';
import { type FaceRef, isRefProblem, resolveFaces } from '../../geometry/subd/elements';
import { regionNormal, regionsOf } from '../../geometry/subd/regionOps';
import { closeFacesUnderSymmetry } from '../../geometry/subd/symmetry';
import { type CageTopology, buildTopology, regionBoundary } from '../../geometry/subd/topology';

export interface FaceRegions {
  readonly topology: CageTopology;
  readonly faces: number[];
  readonly regions: number[][];
  /** Unit normal of each region (null: its faces cancel out). */
  readonly normals: Array<Vec3 | null>;
  readonly record: Record<string, unknown> | null;
  /** Faces added by the mirror closure. */
  readonly mirrored: number;
}

export interface RegionProblem {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** Regions of the faces `refs`, mirrored when the cage has symmetry (unless `ignoreSymmetry`), or the problem. */
export function faceRegions(
  entity: SubdivisionEntity,
  refs: readonly FaceRef[],
  individual: boolean,
  ignoreSymmetry = false,
): FaceRegions | RegionProblem {
  const named = resolveFaces(entity, refs, 'params.faces');
  if (isRefProblem(named)) return named;
  if (named.items.length === 0) return { code: 'DIR_SELECTION_EMPTY', message: 'no face given', path: 'params.faces' };
  const topology = buildTopology(entity.vertices.length, entity.faces);
  const faces =
    entity.symmetry === undefined || ignoreSymmetry
      ? [...new Set(named.items)].sort((a, b) => a - b)
      : closeFacesUnderSymmetry(entity.faces, named.items, entity.symmetry);
  const regions = regionsOf(topology, faces, individual);
  const boundaries = regions.map((region) => regionBoundary(topology, new Set(region)));
  if (boundaries.some((boundary) => boundary.length === 0))
    return { code: 'DIR_REGION_DEGENERATE', message: 'the faces form a closed surface with no boundary', path: 'params.faces' };
  if (boundaries.some((boundary) => new Set(boundary.map(([a]) => a)).size !== boundary.length))
    return { code: 'DIR_REGION_PINCH', message: 'a region boundary passes through one vertex twice', path: 'params.faces' };
  return {
    topology,
    faces,
    regions,
    normals: regions.map((region) => regionNormal(entity.vertices, topology, region)),
    record: named.byIndex ? { faces: named.ids } : null,
    mirrored: faces.length - new Set(named.items).size,
  };
}

export const isRegionProblem = (value: FaceRegions | RegionProblem): value is RegionProblem => 'code' in value;
