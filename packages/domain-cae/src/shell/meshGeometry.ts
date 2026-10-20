/**
 * Mesher geometry of a shell / plane-stress part (bridge op `mesh`, geometry kind `midsurface`): the planar faces to mesh in 2D, each with the
 * normal its elements must follow, in document units (the bridge scales). Offset top / bottom shells mesh the wall surface: the faces move by
 * +- t / 2 along their normal and the deck writes OFFSET = +- 0.5.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { add3, scale3 } from '@lib/vec3';
import { caseOf } from '../shared/access';
import { laminateOf, isLaminateRefusal } from './laminate';
import { DEFAULT_MIN_COVERAGE, midsurfaceOf } from './midsurface';
import { planeStressDomain } from './planeStressFace';
import { isMidsurfaceRefusal, type MidsurfaceRefusal } from './types';

export interface MidsurfaceGeometry {
  readonly kind: 'midsurface';
  /** Element family the bridge writes: S* (shell) or CPS* (plane stress). */
  readonly element: 'shell' | 'plane_stress';
  /** Section thickness, document units. */
  readonly thickness: number;
  readonly faces: readonly { readonly outer: readonly Vec3[]; readonly holes: readonly (readonly Vec3[])[]; readonly normal: Vec3 }[];
  readonly warnings: readonly string[];
}

/** CalculiX `OFFSET` of a shell section: the reference (meshed) surface relative to the midsurface, in thicknesses along the element normal. */
export const SHELL_OFFSET = { mid: 0, top: 0.5, bottom: -0.5 } as const;

/**
 * Geometry of part `entityId` of `analysisId` for the mesher, or null for a solid part (meshed from STEP / STL as before).
 * @failure every midsurface / plane-stress refusal; coverage below the case's minCoverage -> FEA_MIDSURFACE_COVERAGE; several wall thicknesses
 *   for an 'auto' thickness -> FEA_MIDSURFACE_THICKNESS_VARIES
 */
export function partMidsurfaceGeometry(
  doc: CadDocument,
  analysisId: string,
  entityId: string,
  kernel: GeometryKernel | null,
): MidsurfaceGeometry | MidsurfaceRefusal | null {
  const idealization = caseOf(doc, analysisId)?.parts[entityId];
  if (idealization?.kind === 'plane_stress') {
    const domain = planeStressDomain(doc, entityId, idealization.sourceFacesNear, idealization.thickness, kernel);
    if (isMidsurfaceRefusal(domain)) return domain;
    return { kind: 'midsurface', element: 'plane_stress', thickness: idealization.thickness, faces: domain.faces, warnings: [] };
  }
  if (idealization?.kind !== 'shell') return null;
  const mid = midsurfaceOf(
    doc,
    entityId,
    { ...idealization.midsurface, stripLength: caseOf(doc, analysisId)?.mesh.globalSize ?? 0 },
    kernel,
  );
  if (isMidsurfaceRefusal(mid)) return mid;
  const minCoverage = idealization.midsurface.minCoverage ?? DEFAULT_MIN_COVERAGE;
  if (mid.coverage < minCoverage)
    return {
      code: 'FEA_MIDSURFACE_COVERAGE',
      message: `the midsurface of '${entityId}' covers ${(mid.coverage * 100).toFixed(1)} % of its faces (needs ${(minCoverage * 100).toFixed(1)} %)`,
    };
  const laminate =
    idealization.laminate === undefined
      ? null
      : laminateOf(doc, idealization.laminate.compositePartId, entityId, idealization.laminate.sectionId);
  if (laminate !== null && isLaminateRefusal(laminate)) return laminate;
  let thickness = typeof idealization.thickness === 'number' ? idealization.thickness : (laminate?.thickness ?? mid.thicknesses[0] ?? 0);
  if (idealization.thickness === 'auto' && laminate === null && mid.thicknesses.length !== 1)
    return {
      code: 'FEA_MIDSURFACE_THICKNESS_VARIES',
      message: `'${entityId}' has several wall thicknesses: set_part_idealization thickness=…`,
    };
  if (!(thickness > 0)) thickness = mid.thicknesses[0] ?? 0;
  const shift = SHELL_OFFSET[idealization.offset] * thickness;
  const faces = mid.faces.map((face) => {
    const move = (point: Vec3): Vec3 => add3(point, scale3(face.normal, shift));
    return { outer: face.outer.map(move), holes: face.holes.map((hole) => hole.map(move)), normal: face.normal };
  });
  return { kind: 'midsurface', element: 'shell', thickness, faces, warnings: mid.warnings };
}
