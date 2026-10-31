/** The rows check_blends reports (BLD M0, TECHNICAL_SPEC §4, §5.9): a contact, a blend face, and the check of one solid. */

import type { Finding } from './checkBlendFindings';
import type { RadiusReadback } from './checkBlendRadius';

export interface Contact {
  readonly edge: number;
  readonly name?: string;
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  /** Corner patches only: the largest angle at the two end points of the contact, where three faces meet (g1AngleRad covers the open interior). */
  readonly g1EndAngleRad?: number;
  /** Junctions only: the blend face on the other side. */
  readonly neighbour?: string;
  /** Junctions across a crease of the part only: the angle between the two blends' normals at the ends of the junction (each is tangent to its own support there); the junction is judged by what g1AngleRad allows beyond it. */
  readonly creaseRad?: number;
  readonly g2Gap: number;
  readonly g2Rel: number;
  readonly order: string;
}

export interface BlendRow {
  readonly entityId: string;
  readonly face: number;
  readonly name: string;
  readonly kind: 'edge' | 'corner';
  readonly sourceEdges: readonly string[];
  readonly contacts: readonly Contact[];
  /** Where this blend face meets the next blend face of its tangent chain (not a support): G0 / G1 across the junction edge, measured once from the lower face. */
  readonly junctions?: readonly Contact[];
  /** Realised radius along the blend (absent when the kernel cannot section the face). */
  readonly radius?: RadiusReadback;
  /** Whether the recipe's radius law was compared with the realised radius. */
  readonly lawChecked?: boolean;
  /** Why a law that could be compared was not (an edge of uneven speed whose spine position could not be read): named, never a guess. */
  readonly lawNote?: string;
  /** blend_union joints: where the radius asked for came from, the pick ("joints[i]") or "default". */
  readonly source?: string;
  /** Section the recipe asked for: "circular", "conic" or "curvature" (a non-circular section has no radius readback). */
  readonly profile: string;
}

export interface EntityCheck {
  readonly blends: BlendRow[];
  readonly findings: Finding[];
  readonly unverified: number;
  /** Junctions between blends of a chain that the kernel could not measure (counted apart from the contacts). */
  readonly unverifiedJunctions: number;
  /** The gap tolerance applied to this solid (document units). */
  readonly g0: number;
  /** Why nothing could be measured, when that is so. */
  readonly notRun?: string;
}
