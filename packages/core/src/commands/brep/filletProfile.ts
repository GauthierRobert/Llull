/**
 * Profile blends of fillet_edge (BLD M2, TECHNICAL_SPEC §5.3, §13.11): the conic / curvature section and the second leg (asymmetric). Checks the
 * parameters that need no kernel (rho / shape range), then, for the planned edges, that a second leg goes with one constant size and that the face
 * carrying the first leg is known; the kernel builds the blend (straight or curved edges, planar or curved faces, constant or varying size) and says
 * why when it cannot (BLD_PROFILE_FAILED).
 * @failure rho or shape outside 0.05..0.95 -> BLD_RHO_RANGE / BLD_SHAPE_RANGE; size2 with a size that varies along the edge -> BLD_PROFILE_FAILED;
 *   size2 without a side -> BLD_ASYMMETRIC_SIDE_MISSING
 */

import { PROFILE_FACTOR_MAX, PROFILE_FACTOR_MIN, type BlendProfile } from '../../model/blendTypes';
import type { EdgeRadius } from '../../model/types';
import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import type { ShapeHandle } from '../../geometry/kernelTypes';
import { isSideProblem, sideFaces, type SideSelector } from '../../geometry/blend/sides';
import { z } from '../schema';

export const profileSchema = z
  .object({
    type: z
      .enum(['circular', 'conic', 'curvature'])
      .describe(
        '"circular" (default: the rolling ball, G1 to the faces), "conic" (needs rho) or "curvature" (needs shape: zero curvature at both contacts, G2 to planar faces).',
      ),
    rho: z
      .number()
      .describe(
        'conic: shoulder ratio in [0.05, 0.95], dimensionless: the section is the rational quadratic between the contact points and the corner with weight rho / (1 - rho). 0.4142 (sqrt 2 - 1) is a circle at a 90 degree edge, 0.5 a parabola, below it flatter, above it fuller.',
      )
      .optional(),
    shape: z
      .number()
      .describe(
        'curvature: fraction in [0.05, 0.95], dimensionless, of the way from each contact point to the corner at which the section leaves the face; larger is fuller.',
      )
      .optional(),
  })
  .describe(
    'Cross-section of the blend. conic and curvature profiles are built on straight or curved edges between planar or curved faces, with a constant or varying size (radiusEnd, sizes, law): the contact lines are those of the circular fillet of that radius, so a blend ends on a flat face square to it, on the next blend of a tangent chain, or closes on itself (a rim). Edges that meet at a vertex are all profiled in the same step with the same section and get a smooth corner patch (straight edges between planar faces). BLD_PROFILE_FAILED says what is not built. curvature is G2 to a planar face and matches the curvature of a curved one (except at a reported fallback to the G1 quartic: data.profile.fallback). Profiled edges that meet at a vertex need one constant size. The measured gap and the corner setbacks are in data.profile. Sizing is by radius or by legs (size2: straight edge between planar faces, one constant size).',
  );

export type ProfileInput = z.infer<typeof profileSchema>;

/** A refusal decided here: stable code, message, param path below the request. */
export interface ProfileRefusal {
  readonly code: 'BLD_RHO_RANGE' | 'BLD_SHAPE_RANGE' | 'BLD_PROFILE_FAILED' | 'BLD_ASYMMETRIC_SIDE_MISSING';
  readonly message: string;
  readonly path: string;
}

const inRange = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= PROFILE_FACTOR_MIN && value <= PROFILE_FACTOR_MAX;

/** The recipe form of `input` (only the field its type reads), or why rho / shape is unusable. */
export function resolveProfile(input: ProfileInput | undefined): { readonly profile: BlendProfile | undefined } | ProfileRefusal {
  if (input === undefined || input.type === 'circular') return { profile: undefined };
  if (input.type === 'conic')
    return inRange(input.rho)
      ? { profile: { type: 'conic', rho: input.rho } }
      : {
          code: 'BLD_RHO_RANGE',
          message: `profile.rho must be in [${PROFILE_FACTOR_MIN}, ${PROFILE_FACTOR_MAX}] (got ${String(input.rho)}); 0.4142 is a circle at 90 degrees, 0.5 a parabola`,
          path: 'profile.rho',
        };
  return inRange(input.shape)
    ? { profile: { type: 'curvature', shape: input.shape } }
    : {
        code: 'BLD_SHAPE_RANGE',
        message: `profile.shape must be in [${PROFILE_FACTOR_MIN}, ${PROFILE_FACTOR_MAX}] (got ${String(input.shape)})`,
        path: 'profile.shape',
      };
}

export const isProfileRefusal = (value: object): value is ProfileRefusal => 'code' in value;

/** The profile as a phrase for a summary ("conic profile rho 0.25"), empty for a circular one. */
export function profileText(profile: BlendProfile | undefined): string {
  if (profile === undefined || profile.type === 'circular') return '';
  return profile.type === 'conic' ? `, conic profile rho ${profile.rho}` : `, curvature profile shape ${profile.shape}`;
}

export interface PlannedProfile {
  readonly edge: number;
  readonly law: EdgeRadius;
  readonly entry?: number | undefined;
  readonly side?: SideSelector | undefined;
}

const where = (entry: number | undefined, field: string): string => (entry === undefined ? field : `edges[${entry}].${field}`);

/**
 * `planned` ready for a profile blend: a second leg only with a constant size, and each leg pair with the unique face index carrying the first leg (`sideFace`).
 * @failure a varying size -> BLD_PROFILE_FAILED; size2 without a usable side -> BLD_ASYMMETRIC_SIDE_MISSING
 */
export function prepareProfile(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  topology: ShapeTopology | null,
  planned: readonly PlannedProfile[],
): { readonly planned: PlannedProfile[] } | ProfileRefusal {
  const ready: PlannedProfile[] = [];
  for (const item of planned) {
    const { law, edge, entry } = item;
    if (law.size2 === undefined) {
      ready.push(item);
      continue;
    }
    if (law.sizeEnd !== undefined || (law.sizes ?? []).length > 0)
      return {
        code: 'BLD_PROFILE_FAILED',
        message: `edge ${edge}: a second leg (size2) takes one constant size (no sizeEnd, control points or expression); a profile whose size varies is symmetric`,
        path: where(entry, 'size2'),
      };
    if (topology === null || item.side === undefined || (item.side.near === undefined && item.side.name === undefined))
      return {
        code: 'BLD_ASYMMETRIC_SIDE_MISSING',
        message: `edge ${edge}: size2 needs side1Near (a point on the face that carries size) or side1Name`,
        path: where(entry, 'side1Near'),
      };
    const faces = sideFaces(kernel, shape, topology, [edge], item.side);
    if (isSideProblem(faces))
      return { code: faces.code, message: faces.message, path: where(entry, item.side.name === undefined ? 'side1Near' : 'side1Name') };
    ready.push({ ...item, law: { ...law, sideFace: faces[0] ?? 0 } });
  }
  return { planned: ready };
}
