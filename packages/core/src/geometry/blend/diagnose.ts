/**
 * Maps the OCCT failure report of a fillet recipe (`kernel.blendReport`) to a stable BLD_* code (BLD M0, TECHNICAL_SPEC §5.8, §7.1).
 * @invariant pure; the first failing contour decides, then faulty vertices, then validity
 * @failure a report that says the fillet builds (stage "none") -> null (no diagnosis)
 */

import type { BlendReport } from '../kernelPorts';
import type { Vec3 } from '../../model/types';

export type BlendFailureCode =
  | 'BLD_RADIUS_TOO_LARGE'
  | 'BLD_WALKING_FAILURE'
  | 'BLD_TWISTED_SURFACE'
  | 'BLD_CORNER_UNSUPPORTED'
  | 'BLD_CORNER_FAILED'
  | 'BLD_SETBACK_TOO_SHORT'
  | 'BLD_INVALID_RESULT'
  | 'BLD_PROFILE_FAILED'
  | 'BLD_CHAMFER_FAILED'
  | 'BLD_FACE_FILLET_NO_SOLUTION'
  | 'BLD_FACESETS_OVERLAP'
  | 'BLD_FACE_BLEND_UNSUPPORTED'
  | 'BLD_FULL_ROUND_NOT_OPPOSED'
  | 'BLD_FULL_ROUND_NO_SOLUTION';

const CODED_REASON = /^\[(BLD_[A-Z_]+)\]\s*([\s\S]*)$/;
const REASON_CODES: ReadonlySet<string> = new Set([
  'BLD_SETBACK_TOO_SHORT',
  'BLD_CORNER_UNSUPPORTED',
  'BLD_CORNER_FAILED',
  'BLD_FACE_FILLET_NO_SOLUTION',
  'BLD_FACESETS_OVERLAP',
  'BLD_FACE_BLEND_UNSUPPORTED',
  'BLD_FULL_ROUND_NOT_OPPOSED',
  'BLD_FULL_ROUND_NO_SOLUTION',
]);

/** The stable code and text of a profile / face-blend reason ("[BLD_X] text"; no prefix = BLD_PROFILE_FAILED). */
function codedReason(
  message: string | undefined,
  fallback: BlendFailureCode = 'BLD_PROFILE_FAILED',
): { readonly code: BlendFailureCode; readonly text: string } {
  const found = message === undefined ? null : CODED_REASON.exec(message);
  const named = found?.[1];
  if (named !== undefined && REASON_CODES.has(named)) return { code: named as BlendFailureCode, text: found?.[2] ?? '' };
  return { code: fallback, text: message ?? 'the kernel gave no reason' };
}

export interface BlendFailure {
  readonly code: BlendFailureCode;
  /** Unique-edge indices the failure is about (contour edges, or the edges meeting at the faulty vertex). */
  readonly edges: readonly number[];
  /** The faulty vertex, when the failure is a corner. */
  readonly vertex?: Vec3;
  readonly message: string;
}

/** Edges meeting at a faulty vertex at which OCCT documents the corner as not handled. */
const UNSUPPORTED_VALENCE = 4;

const list = (edges: readonly number[]): string => edges.join(', ');

/** The failure `report` describes, or null when it describes a successful build. */
export function diagnoseBlend(report: BlendReport): BlendFailure | null {
  if (report.stage === 'setback') {
    const { code, text } = codedReason(report.message, 'BLD_CORNER_FAILED');
    return { code, edges: [], message: text };
  }
  if (report.stage === 'chamfer')
    return {
      code: 'BLD_CHAMFER_FAILED',
      edges: [],
      message: `the variable chamfer cannot be built: ${report.message === undefined || report.message === '' ? 'the kernel gave no reason' : report.message}`,
    };
  if (report.stage === 'profile' || report.stage === 'faceBlend' || report.stage === 'fullRound') {
    const { code, text } = codedReason(report.message);
    return { code, edges: [], message: code === 'BLD_PROFILE_FAILED' ? `the profile blend cannot be built: ${text}` : text };
  }
  for (const contour of report.contours) {
    const { edges } = contour;
    switch (contour.status) {
      case 'ok':
        break;
      case 'startsol_failure':
        return {
          code: 'BLD_RADIUS_TOO_LARGE',
          edges,
          message: `OCCT could not start the blend on edge(s) ${list(edges)} (StartsolFailure: the radius is too big for the adjacent faces)`,
        };
      case 'walking_failure':
        return {
          code: 'BLD_WALKING_FAILURE',
          edges,
          message: `OCCT lost the blend while walking along edge(s) ${list(edges)} (WalkingFailure)`,
        };
      case 'twisted_surface':
        return { code: 'BLD_TWISTED_SURFACE', edges, message: `the blend surface along edge(s) ${list(edges)} twists (TwistedSurface)` };
      case 'error':
        return { code: 'BLD_INVALID_RESULT', edges, message: `OCCT reported a generic error for the blend along edge(s) ${list(edges)}` };
    }
  }
  const [vertex] = report.vertices;
  if (vertex !== undefined) {
    const unsupported = vertex.edges.length >= UNSUPPORTED_VALENCE;
    return {
      code: unsupported ? 'BLD_CORNER_UNSUPPORTED' : 'BLD_CORNER_FAILED',
      edges: vertex.edges,
      vertex: vertex.point,
      message: unsupported
        ? `OCCT cannot round the corner at [${vertex.point.join(', ')}] where ${vertex.edges.length} edges meet (edges ${list(vertex.edges)})`
        : `OCCT could not build the corner at [${vertex.point.join(', ')}] (edges ${list(vertex.edges)})`,
    };
  }
  if (report.stage === 'contours' && report.message !== undefined)
    return { code: 'BLD_INVALID_RESULT', edges: [], message: `OCCT failed before any contour was built: ${report.message}` };
  if (report.stage === 'corners')
    return { code: 'BLD_INVALID_RESULT', edges: [], message: 'OCCT finished without a result and named no vertex' };
  if (report.stage === 'validity')
    return { code: 'BLD_INVALID_RESULT', edges: [], message: 'the rounded solid fails the BRepCheck validity analysis' };
  return null;
}

const REMEDIATION: Readonly<Record<BlendFailureCode, string>> = {
  BLD_CHAMFER_FAILED:
    'use smaller distances (they must stay inside both faces along the whole edge), unlist edges that share a vertex, or use a constant chamfer (no distanceEnd); a variable chamfer needs straight edges between planar faces ending on flat square faces',
  BLD_RADIUS_TOO_LARGE: 'use a smaller radius (probe_fillet returns the largest radius that builds), or fewer edges per step',
  BLD_WALKING_FAILURE: 'use a smaller radius or a smoother law, or split the chain (fillet in two steps)',
  BLD_TWISTED_SURFACE: 'reduce the radius law slope or the radius on concave faces',
  BLD_CORNER_UNSUPPORTED:
    'give the vertex a setback corner: corners: [{ near: <the vertex>, type: "setback", setback: <distance> }] (every edge there rounded, constant radius; along the edge on straight edges between planar faces, all convex or all concave, or, on a curved edge or face, the radius of a ball around the vertex (equal distances) or a plane normal to each edge at its distance (different ones), one kind per step), or round fewer of the edges meeting there per step',
  BLD_CORNER_FAILED: 'try a setback corner at that vertex (corners), a different radius or setback there, or round fewer edges per step',
  BLD_SETBACK_TOO_SHORT:
    'use at least the minimum the message names (it is the distance along the edge that the neighbouring blends reach)',
  BLD_INVALID_RESULT: 'use a smaller radius or fewer edges per step',
  BLD_FACE_FILLET_NO_SOLUTION: 'use at least the radius the message names, or a smaller one if the legs leave the faces',
  BLD_FACESETS_OVERLAP: 'give two different faces (inspect_faces lists them)',
  BLD_FACE_BLEND_UNSUPPORTED:
    'blend one planar face against another that end on flat square faces (this build), or round the real edge with fillet_edge',
  BLD_FULL_ROUND_NOT_OPPOSED:
    'give two parallel side faces facing away from each other and the center face square to both; or use fillet_faces',
  BLD_FULL_ROUND_NO_SOLUTION:
    'the center face must be exactly as wide as the gap between the sides; use fillet_faces for a different width',
  BLD_PROFILE_FAILED:
    'try the circular profile (probe_fillet) or a smaller size; a profile blend ends on a flat face square to it, on the next blend of a tangent chain, or closes on itself; edges that meet at a vertex are profiled together with one section; size2 needs a straight edge between planar faces',
};

export const remediationOf = (code: BlendFailureCode): string => REMEDIATION[code];
