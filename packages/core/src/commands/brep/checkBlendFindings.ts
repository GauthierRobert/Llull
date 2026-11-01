/**
 * The findings of check_blends (BLD M0): the coded remediations, the tolerances a contact is judged against and the findings one measured contact raises.
 * @invariant pure; lengths in document units, angles in radians
 */

import type { CliffEdge } from '../../geometry/blend/cliffEdge';
import { measureContact, type ContactSample } from '../../geometry/blend/continuity';
import { roundSignificant } from '../../lib/significant';

const sig = (value: number): number => roundSignificant(value, 10);

export type Severity = 'fail' | 'warn' | 'info';

export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly entityId: string;
  readonly face?: number;
  readonly edge?: number;
  readonly value?: number;
  readonly limit?: number;
  readonly unit: string;
  readonly remediation: string;
  readonly message: string;
}

export interface Tolerances {
  readonly g0: number;
  readonly g1AngleRad: number;
  readonly g2Rel: number;
  /** Normal curvature (1/unit) below which a face is flat for the G2 reading: relative to the part, not absolute. */
  readonly flatCurvature?: number;
}

export const REMEDIATION = {
  BLD_CHECK_CHAMFER_UNVERIFIED:
    'the kernel did not give what the leg readback needs (the chamfer face by name, its contact lines, the faces of the edge): rebuild with the native kernel, or read the legs with inspect_topology and measure_distance',
  BLD_CHECK_CHAMFER_LEGS:
    'the chamfer face does not keep the legs of its law (a leg is measured on each face from the edge in the plane perpendicular to it): use smaller distances, or a constant chamfer, or report the part',
  BLD_CHECK_BLEND_UNVERIFIED:
    'the kernel did not give what the leg readback needs (the blend face by name, its contact lines, the faces of the edge): rebuild with the native kernel, or read the legs with inspect_topology and measure_distance',
  BLD_CHECK_BLEND_LEGS:
    'the blend face does not keep the legs of its law (a leg is measured on each face from the edge in the plane perpendicular to it): use smaller sizes, or report the part',
  BLD_CHECK_CLIFF_EDGE:
    'none needed: a cliff edge (fillet_faces cliff) is where the ball touches the far edge of a narrow face, so it is sharp there by construction',
  BLD_CHECK_G0_GAP: 'the faces do not meet at the contact: use a smaller radius or fewer edges per step',
  BLD_CHECK_G1_ANGLE: 'the blend is not tangent to a support face: rebuild the fillet with a smaller radius or fewer edges per step',
  BLD_CHECK_G2_JUMP: 'a circular fillet is never G2 to a plane: use a curvature-continuous profile when G2 is required',
  BLD_CHECK_SPOKE_G2_LOST:
    'the corner star declared curvature-continuous seams beyond the stretch next to its vertices (data.profile.corners[].spokeReach) but the kernel reads a jump there: rebuild the fillet and report the part',
  BLD_CHECK_SPOKE_G2:
    'none needed unless the whole corner must be curvature-continuous: the sub-patches of a G2 corner star meet each other with G2 beyond the first fifth of each spoke from its vertex (data.profile.corners[].spokes "G2-beyond-reach", spokeReach) and with G1 within that stretch next to the vertices (or all along a spoke when the build could not meet its gate: spokes "G1", spokeRefused); its contacts with the blend and flat faces are G2',
  BLD_CHECK_CORNER_OVERSHOOT:
    'none needed below the build gate: a trimmed corner star (rolling-ball builder) stands that far on the wrong side of the part (outside it for a convex corner, inside for a concave one), as measured at the build; if it matters, use a smaller setback ball or a smaller radius at the vertex, or report the part',
  BLD_CHECK_INVALID: 'rebuild the blend with a smaller radius or fewer edges per step',
  BLD_CHECK_RADIUS_LAW:
    'the realised radius is off the law that was asked for: rebuild with a smaller radius or a smoother law, or split the chain',
  BLD_CHECK_UNVERIFIED_PICK: 'use the native exact kernel (kernel_info), which keeps persistent names',
  BLD_CHECK_UNVERIFIED_CONTACT: 'rebuild the blend with a smaller radius, or inspect_topology / check_continuity the blend by hand',
  BLD_CHECK_TOLERANCE_DEFAULTED: 'pass g0, g1AngleRad and g2Rel explicitly to accept them',
  BLD_CHECK_REVIEW: 'a release check needs a human review of the radii (stress-relevant): sign off through the PLM release',
} as const;

export function contactFindings(
  entityId: string,
  face: number,
  edge: number,
  contact: NonNullable<ReturnType<typeof measureContact>>,
  tolerances: Tolerances,
  requireG2: boolean,
  unit: string,
): Finding[] {
  const found: Finding[] = [];
  const at = { entityId, face, edge };
  if (contact.g0Gap > tolerances.g0)
    found.push({
      ...at,
      code: 'BLD_CHECK_G0_GAP',
      severity: 'fail',
      value: sig(contact.g0Gap),
      limit: sig(tolerances.g0),
      unit,
      remediation: REMEDIATION.BLD_CHECK_G0_GAP,
      message: `faces ${face} and its support are ${sig(contact.g0Gap)} ${unit} apart along edge ${edge}`,
    });
  if (contact.g1AngleRad > tolerances.g1AngleRad)
    found.push({
      ...at,
      code: 'BLD_CHECK_G1_ANGLE',
      severity: 'fail',
      value: sig(contact.g1AngleRad),
      limit: sig(tolerances.g1AngleRad),
      unit: 'rad',
      remediation: REMEDIATION.BLD_CHECK_G1_ANGLE,
      message: `the normals differ by ${sig(contact.g1AngleRad)} rad along edge ${edge} (blend face ${face} is not tangent)`,
    });
  else if (contact.g2Rel > tolerances.g2Rel)
    found.push({
      ...at,
      code: 'BLD_CHECK_G2_JUMP',
      severity: requireG2 ? 'fail' : 'info',
      value: sig(contact.g2Rel),
      limit: sig(tolerances.g2Rel),
      unit: 'ratio',
      remediation: REMEDIATION.BLD_CHECK_G2_JUMP,
      message: `curvature jumps by ${sig(contact.g2Gap)} 1/${unit} (relative ${sig(contact.g2Rel)}) across edge ${edge}: G1 only`,
    });
  return found;
}

export const statusOf = (findings: readonly Finding[]): 'pass' | 'warn' | 'fail' =>
  findings.some((finding) => finding.severity === 'fail')
    ? 'fail'
    : findings.some((finding) => finding.severity === 'warn')
      ? 'warn'
      : 'pass';

/** The info finding for the cliff edge of a cliff blend (fillet_faces cliff): a sharp edge by construction, never a failure. */
export function cliffFinding(entityId: string, face: number, name: string, cliff: CliffEdge): Finding {
  return {
    code: 'BLD_CHECK_CLIFF_EDGE',
    severity: 'info',
    entityId,
    face,
    edge: cliff.edge,
    value: sig(cliff.angleRad),
    unit: 'rad',
    remediation: REMEDIATION.BLD_CHECK_CLIFF_EDGE,
    message: `cliff edge, not a tangent contact (angle ${sig((cliff.angleRad * 180) / Math.PI)}°): blend face ${face} (${name}) touches the far edge of a consumed face at edge ${cliff.edge}`,
  };
}

/** The last share of a spoke the seam is read to (the pole itself is degenerate). */
const SPOKE_LAST_SAMPLE = 0.97;

/**
 * The findings for the curvature jump across a spoke (an edge between two sub-patches) of a corner star whose contacts with the blend and flat faces are G2 (06 BLD 13.36, 13.38).
 * `reach` > 0: the star declares curvature-continuous spokes beyond that share of each spoke from its vertex (`fromVertex`: the samples' t counts from the vertex): a jump above g2Rel
 * within the stretch is a warn BLD_CHECK_SPOKE_G2 (declared), beyond it a FAIL BLD_CHECK_SPOKE_G2_LOST (the correction was lost). `reach` 0: the spokes are G1 seams, one warn on the whole seam.
 * @failure no samples beyond the stretch -> nothing for it
 */
export function spokeFinding(
  entityId: string,
  face: number,
  edge: number,
  samples: readonly ContactSample[],
  reach: number,
  fromVertex: boolean,
  tolerances: Tolerances,
  unit: string,
): Finding[] {
  const where = (sample: ContactSample): number => (fromVertex ? sample.t : 1 - sample.t);
  const seam = (kept: readonly ContactSample[]): NonNullable<ReturnType<typeof measureContact>> | null => measureContact(kept, tolerances);
  const readings =
    reach > 0
      ? [
          {
            code: 'BLD_CHECK_SPOKE_G2',
            severity: 'warn' as const,
            measure: seam(samples.filter((sample) => where(sample) < reach)),
            place: `within the declared stretch next to the vertex (spokeReach ${sig(reach)} of the spoke, where the seam is tangent only)`,
          },
          {
            code: 'BLD_CHECK_SPOKE_G2_LOST',
            severity: 'fail' as const,
            measure: seam(samples.filter((sample) => where(sample) >= reach && where(sample) <= SPOKE_LAST_SAMPLE)),
            place: `beyond the declared stretch of ${sig(reach)} next to the vertex, where the corner was built curvature-continuous`,
          },
        ]
      : [{ code: 'BLD_CHECK_SPOKE_G2', severity: 'warn' as const, measure: seam(samples), place: 'all along the seam' }];
  const found: Finding[] = [];
  for (const { code, severity, measure, place } of readings) {
    if (measure === null || measure.g2Rel <= tolerances.g2Rel) continue;
    found.push({
      code,
      severity,
      entityId,
      face,
      edge,
      value: sig(measure.g2Rel),
      limit: sig(tolerances.g2Rel),
      unit: 'ratio',
      remediation: REMEDIATION[code as 'BLD_CHECK_SPOKE_G2' | 'BLD_CHECK_SPOKE_G2_LOST'],
      message: `curvature jumps by ${sig(measure.g2Gap)} 1/${unit} (relative ${sig(measure.g2Rel)}) ${place} across edge ${edge}, a seam between two sub-patches of corner patch ${face}`,
    });
  }
  return found;
}
