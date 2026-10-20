/** Resolution of a shell / plane-stress idealization at `set_part_idealization` time: midsurface found, thickness fixed, laminate checked. */

import type { GeometryKernel } from '@core/geometry/kernel';
import type { Idealization } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { significantNumber } from '@lib/compactNumber';
import { isLaminateRefusal, laminateOf } from './laminate';
import { DEFAULT_ANGULAR_TOL_DEG, DEFAULT_MIN_COVERAGE, midFaceSpan, midsurfaceOf } from './midsurface';
import { planeStressDomain } from './planeStressFace';
import { isMidsurfaceRefusal, type MidsurfaceRefusal } from './types';

export interface ShellRequest {
  readonly thickness?: number;
  readonly offset?: 'mid' | 'top' | 'bottom';
  readonly maxThickness?: number;
  readonly angularTolDeg?: number;
  readonly minCoverage?: number;
  readonly compositePartId?: string;
  readonly sectionId?: string;
}

export interface ResolvedIdealization {
  readonly idealization: Idealization;
  /** Summary fragment, e.g. `box_plate midsurface, t = 2, offset mid, 1 face`. */
  readonly note: string;
}

/** A shell whose thickness exceeds this fraction of its span is a thick shell (a warning, not a refusal). */
const THICK_SHELL_RATIO = 0.1;
/** Laminate and detected wall thickness disagreeing by more than this (relative) is a warning. */
const LAMINATE_MISMATCH = 0.05;

const text = (value: number): string => significantNumber(value, 6);

/**
 * Shell idealization of `entityId`: the midsurface (sheet-metal / box fast path, else kernel face pairing) gives the wall thickness unless
 * `thickness` is given; a composite part's laminate gives it otherwise.
 * @failure midsurface refusals; coverage below minCoverage -> FEA_MIDSURFACE_COVERAGE; several wall thicknesses without an explicit thickness
 *   -> FEA_MIDSURFACE_THICKNESS_VARIES; laminate refusals (FEA_COMPOSITE_*)
 */
export function resolveShell(
  doc: CadDocument,
  entityId: string,
  request: ShellRequest,
  kernel: GeometryKernel | null,
): ResolvedIdealization | MidsurfaceRefusal {
  const laminate = request.compositePartId === undefined ? null : laminateOf(doc, request.compositePartId, entityId, request.sectionId);
  if (laminate !== null && isLaminateRefusal(laminate)) return laminate;
  const given = request.thickness ?? laminate?.thickness;
  const maxThickness = request.maxThickness ?? (given === undefined ? undefined : given * 1.01);
  const mid = midsurfaceOf(
    doc,
    entityId,
    {
      ...(maxThickness !== undefined ? { maxThickness } : {}),
      ...(request.angularTolDeg !== undefined ? { angularTolDeg: request.angularTolDeg } : {}),
    },
    kernel,
  );
  if (isMidsurfaceRefusal(mid)) return mid;
  const minCoverage = request.minCoverage ?? DEFAULT_MIN_COVERAGE;
  if (mid.coverage < minCoverage)
    return {
      code: 'FEA_MIDSURFACE_COVERAGE',
      message: `the midsurface of '${entityId}' covers ${text(mid.coverage * 100)} % of its faces (needs ${text(minCoverage * 100)} %); unpaired faces ${mid.unpairedFaces.join(', ')}`,
    };
  if (given === undefined && mid.thicknesses.length !== 1)
    return {
      code: 'FEA_MIDSURFACE_THICKNESS_VARIES',
      message: `'${entityId}' has wall thicknesses ${mid.thicknesses.map(text).join(', ')}: one shell section per part, give thickness`,
    };
  const thickness = given ?? mid.thicknesses[0] ?? 0;
  const notes: string[] = [];
  const span = Math.max(...mid.faces.map(midFaceSpan));
  if (thickness > THICK_SHELL_RATIO * span) notes.push(`WARNING thick shell (t / span ${text(thickness / span)})`);
  const detected = mid.thicknesses[0];
  if (laminate !== null && detected !== undefined && Math.abs(laminate.thickness - detected) > LAMINATE_MISMATCH * detected)
    notes.push(`WARNING laminate thickness ${text(laminate.thickness)} differs from the wall ${text(detected)}`);
  notes.push(...mid.warnings);
  const offset = request.offset ?? 'mid';
  const idealization: Idealization = {
    kind: 'shell',
    thickness,
    offset,
    midsurface: {
      maxThickness: maxThickness ?? thickness,
      angularTolDeg: request.angularTolDeg ?? DEFAULT_ANGULAR_TOL_DEG,
      ...(request.minCoverage !== undefined ? { minCoverage: request.minCoverage } : {}),
    },
    ...(request.compositePartId !== undefined
      ? {
          laminate: {
            compositePartId: request.compositePartId,
            ...(request.sectionId !== undefined ? { sectionId: request.sectionId } : {}),
          },
        }
      : {}),
  };
  const face = `${mid.faces.length} mid face${mid.faces.length === 1 ? '' : 's'}`;
  const ply = laminate === null ? '' : `, laminate '${laminate.compositePartId}' ${laminate.plies.length} plies`;
  return {
    idealization,
    note: `${mid.method} midsurface, t = ${text(thickness)}, offset ${offset}, ${face}${ply}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`,
  };
}

/**
 * Plane-stress idealization: the faces near `sourceFacesNear` (in z = 0) with thickness `thickness`.
 * @failure planeStressDomain refusals
 */
export function resolvePlaneStress(
  doc: CadDocument,
  entityId: string,
  thickness: number,
  sourceFacesNear: readonly Vec3[],
  kernel: GeometryKernel | null,
): ResolvedIdealization | MidsurfaceRefusal {
  const domain = planeStressDomain(doc, entityId, sourceFacesNear, thickness, kernel);
  if (isMidsurfaceRefusal(domain)) return domain;
  return {
    idealization: { kind: 'plane_stress', thickness, sourceFacesNear },
    note: `plane stress on ${domain.faces.map((face) => face.source).join(', ')}, t = ${text(thickness)}`,
  };
}
