/**
 * Model review data of a document (`CadDocument.review`, plant 09 VIS §3.2), BCF-aligned. This is the VIS-M9 slice: viewpoints,
 * walkthroughs and minimal issues (what headless renders, walkthroughs and BCF snapshots need). Section boxes, markups and comments are
 * reserved for later VIS milestones; they arrive as optional fields, so documents saved now load unchanged.
 */

import type { Vec3 } from './vectors';

type EntityId = string;

/**
 * A BCF camera. `direction` and `up` are unit and orthogonal (normalised on save).
 * @invariant |direction| = |up| = 1 ± 1e-6, |direction·up| ≤ 1e-6; fovDeg ∈ (0, 180); viewHeight > 0 (document units)
 */
export type ViewpointCamera =
  | { readonly projection: 'perspective'; eye: Vec3; direction: Vec3; up: Vec3; fovDeg: number }
  | { readonly projection: 'orthographic'; eye: Vec3; direction: Vec3; up: Vec3; viewHeight: number };

export interface Viewpoint {
  /** `vp-<n>` from `ReviewModel.nextNumber`. */
  readonly id: string;
  /** Name-based UUID (RFC 9562 v8 over sha256 of the id and its content at creation): stable for BCF. */
  readonly guid: string;
  name: string;
  camera: ViewpointCamera;
}

interface WalkthroughKey {
  readonly viewpointId: string;
  /** Seconds from this key to the next one (> 0; the last key's value is ignored). */
  readonly seconds: number;
}

export interface Walkthrough {
  /** `wt-<n>`. */
  readonly id: string;
  name: string;
  keys: readonly WalkthroughKey[];
}

export const ISSUE_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** A review topic (BCF Topic); status transitions arrive with VIS-M3, so every issue is created `open`. */
export interface ReviewIssue {
  /** `iss-<n>`. */
  readonly id: string;
  readonly guid: string;
  title: string;
  type: string;
  priority: IssuePriority;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  description?: string;
  labels: readonly string[];
  viewpointIds: readonly string[];
  entityIds: readonly EntityId[];
}

export interface ReviewModel {
  viewpoints: Record<string, Viewpoint>;
  viewpointOrder: string[];
  walkthroughs: Record<string, Walkthrough>;
  issues: Record<string, ReviewIssue>;
  issueOrder: string[];
  /** Next review id number (review commands are metaHistory: they never consume a feature step). */
  nextNumber: number;
}

export function createReviewModel(): ReviewModel {
  return { viewpoints: {}, viewpointOrder: [], walkthroughs: {}, issues: {}, issueOrder: [], nextNumber: 1 };
}
