/**
 * Model review data of a document (`CadDocument.review`, plant 09 VIS §3.2), BCF-aligned: viewpoints, section boxes, markups, walkthroughs,
 * issues with their status history, and comments. Every command that writes it is metaHistory (no feature step).
 */

import type { Vec2, Vec3 } from './vectors';

type EntityId = string;

/**
 * A BCF camera. `direction` and `up` are unit and orthogonal (normalised on save).
 * @invariant |direction| = |up| = 1 ± 1e-6, |direction·up| ≤ 1e-6; fovDeg ∈ (0, 180); viewHeight > 0 (document units)
 */
export type ViewpointCamera =
  | { readonly projection: 'perspective'; eye: Vec3; direction: Vec3; up: Vec3; fovDeg: number }
  | { readonly projection: 'orthographic'; eye: Vec3; direction: Vec3; up: Vec3; viewHeight: number };

/** A clipping half-space: the points with `normal · p > offset` are removed (BCF ClippingPlane: the normal points to the invisible side). */
export interface SectionPlane {
  readonly normal: Vec3;
  readonly offset: number;
}

/**
 * A section box. Exactly one form: the box `min` / `max` (document units, min < max per axis, turned by `rotationZ` radians about its centre), or
 * 1..6 half-space `planes`.
 */
export interface SectionBox {
  /** `sb-<n>`. */
  readonly id: string;
  name: string;
  min?: Vec3;
  max?: Vec3;
  rotationZ?: number;
  planes?: readonly SectionPlane[];
}

/** BCF Visibility: what the viewpoint shows besides the default (`exceptions` are shown when `defaultVisible` is false, hidden when true). */
export interface ViewpointVisibility {
  readonly defaultVisible: boolean;
  readonly exceptions: readonly EntityId[];
}

export interface Viewpoint {
  /** `vp-<n>` from `ReviewModel.nextNumber`. */
  readonly id: string;
  /** Name-based UUID (RFC 9562 v8 over sha256 of the id and its content at creation): stable for BCF. */
  readonly guid: string;
  name: string;
  camera: ViewpointCamera;
  sectionBoxId?: string;
  colourProfileId?: string;
  visibility?: ViewpointVisibility;
  selection?: readonly EntityId[];
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

export const MARKUP_SHAPES = ['line', 'polyline', 'arrow', 'cloud', 'ellipse', 'text'] as const;
export type MarkupShape = (typeof MARKUP_SHAPES)[number];

/** A redline on a viewpoint: `screen` points are in [0, 1]² of the viewpoint image, `world` points are Vec3 in document units (BCF Lines). */
export interface Markup {
  /** `mk-<n>`. */
  readonly id: string;
  readonly viewpointId: string;
  shape: MarkupShape;
  space: 'screen' | 'world';
  points: ReadonlyArray<Vec2 | Vec3>;
  /** `#rrggbb`. */
  colour: string;
  text?: string;
  lineWidthPx?: number;
  author: 'agent' | 'human';
}

export const ISSUE_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** One status change of an issue; `by: 'human'` only when a human signature verified (then `signatureId` and `signer` are set). */
export interface IssueHistoryEntry {
  readonly status: IssueStatus;
  readonly by: 'agent' | 'human';
  readonly reason: string;
  readonly signatureId?: string;
  readonly signer?: string;
}

/** A review topic (BCF Topic). Created `open`; `history` lists every later status change. */
export interface ReviewIssue {
  /** `iss-<n>`. */
  readonly id: string;
  readonly guid: string;
  title: string;
  type: string;
  priority: IssuePriority;
  status: IssueStatus;
  description?: string;
  assignedTo?: string;
  /** ISO 8601 date (`YYYY-MM-DD`). */
  dueDate?: string;
  labels: readonly string[];
  viewpointIds: readonly string[];
  entityIds: readonly EntityId[];
  history: readonly IssueHistoryEntry[];
}

export interface ReviewComment {
  /** `cm-<n>`. */
  readonly id: string;
  readonly issueId: string;
  text: string;
  /** A comment refers to at most one viewpoint (BCF). */
  viewpointId?: string;
  author: 'agent' | 'human';
}

export interface ReviewModel {
  viewpoints: Record<string, Viewpoint>;
  viewpointOrder: string[];
  sectionBoxes: Record<string, SectionBox>;
  /** The section box `apply_viewpoint` / `set_section_box` made active for the viewport and renderer, if any. */
  activeSectionBoxId?: string;
  markups: Record<string, Markup>;
  walkthroughs: Record<string, Walkthrough>;
  issues: Record<string, ReviewIssue>;
  issueOrder: string[];
  comments: Record<string, ReviewComment>;
  /** Next review id number (review commands are metaHistory: they never consume a feature step). */
  nextNumber: number;
}

export function createReviewModel(): ReviewModel {
  return {
    viewpoints: {},
    viewpointOrder: [],
    sectionBoxes: {},
    markups: {},
    walkthroughs: {},
    issues: {},
    issueOrder: [],
    comments: {},
    nextNumber: 1,
  };
}
