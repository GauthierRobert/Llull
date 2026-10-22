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
  | 'BLD_INVALID_RESULT';

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
  BLD_RADIUS_TOO_LARGE: 'use a smaller radius (probe_fillet returns the largest radius that builds), or fewer edges per step',
  BLD_WALKING_FAILURE: 'use a smaller radius or a smoother law, or split the chain (fillet in two steps)',
  BLD_TWISTED_SURFACE: 'reduce the radius law slope or the radius on concave faces',
  BLD_CORNER_UNSUPPORTED: 'round fewer of the edges meeting at that vertex per step, or use a smaller radius there',
  BLD_CORNER_FAILED: 'try a different radius at that corner, or round fewer edges per step',
  BLD_INVALID_RESULT: 'use a smaller radius or fewer edges per step',
};

export const remediationOf = (code: BlendFailureCode): string => REMEDIATION[code];
