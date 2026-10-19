// Pure: (document before, document after, origin) → the visual transitions that make the change readable. Every command
// is covered because the plan is derived from the entity diff, never from the command name (L1: no per-tool UI logic).

import { type CadDocument, type Entity, type EntityId, type Vec3, is2D } from '@core/model/types';
import { type Bounds, entityBoundsInDoc, mergeBounds } from '@core/geometry/bounds';
import type { LiveCommandSource } from '@protocol/liveSync';

/** Where a document change came from: a broadcast command of someone else, a server snapshot, or this client. */
export type LiveFxOrigin =
  | { readonly kind: 'remote'; readonly name: string; readonly source: LiveCommandSource; readonly userName?: string }
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'local' };

/** Colour family of an effect: who made the change. */
export type LiveFxTone = LiveCommandSource | 'snapshot' | 'local';

export interface EntityTransition {
  readonly id: EntityId;
  readonly tone: LiveFxTone;
  readonly change: 'created' | 'modified';
  readonly startMs: number;
  readonly durationMs: number;
  /** Modified entities: the previous version (pose tween source). */
  readonly before?: Entity;
  /** Tween from `before`'s position/rotation (remote edits only: a local drag already shows the move). */
  readonly poseTween: boolean;
  /** Grow / pulse around this point (bottom-centre for solids, centre for 2D shapes). */
  readonly pivot: Vec3;
}

/** The previous version of a removed (or remotely reshaped) entity, drawn as a fading hologram. */
export interface LiveGhost {
  readonly key: string;
  readonly tone: LiveFxTone;
  readonly entity: Entity;
  readonly document: CadDocument;
  readonly mode: 'removed' | 'replaced';
  readonly startMs: number;
  readonly durationMs: number;
  readonly center: Vec3;
  /** Largest extent of its bounds (how far a removed ghost drifts up). */
  readonly size: number;
}

export interface LiveRipple {
  readonly key: string;
  readonly tone: LiveFxTone;
  readonly center: Vec3;
  readonly radius: number;
  readonly startMs: number;
}

export interface LiveBadge {
  readonly key: string;
  readonly label: string;
  readonly source: LiveCommandSource;
  readonly anchor: Vec3;
  readonly startMs: number;
}

export interface LiveActivity {
  readonly key: string;
  readonly name: string;
  readonly source: LiveCommandSource;
  readonly userName?: string;
  readonly created: number;
  readonly modified: number;
  readonly removed: number;
  readonly atMs: number;
}

export interface LiveFxPlan {
  readonly transitions: readonly EntityTransition[];
  readonly ghosts: readonly LiveGhost[];
  readonly ripples: readonly LiveRipple[];
  readonly badge: LiveBadge | null;
  readonly activity: LiveActivity | null;
  /** World bounds of everything that changed (camera focus); null when nothing visible changed. */
  readonly focus: Bounds | null;
  /** Bring `focus` into view: remote commands only, and not when the command moved the (shared) camera itself. */
  readonly refocus: boolean;
}

export const CREATE_MS = 950;
const MODIFY_MS = 850;
const REMOVE_MS = 750;
/** Above this many changed entities only the activity entry is kept (a whole-model reload must stay instant). */
export const MAX_ANIMATED_CHANGES = 400;
const STAGGER_MS = 45;
const MAX_STAGGER_SPAN_MS = 1400;

interface EntityDiff {
  readonly created: Entity[];
  readonly modified: Array<{ before: Entity; after: Entity }>;
  readonly removed: Entity[];
}

/** A snapshot (connect, undo/redo, resync) deserializes fresh objects: equal content is not a change. */
function sameContent(a: Entity, b: Entity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Reference diff (commands are pure, so an untouched entity keeps its identity), confirmed by content. */
export function diffEntities(before: CadDocument, after: CadDocument): EntityDiff {
  const diff: EntityDiff = { created: [], modified: [], removed: [] };
  if (before.entities === after.entities) return diff;
  for (const id of after.order) {
    const next = after.entities[id];
    if (next === undefined) continue;
    const previous = before.entities[id];
    if (previous === undefined) diff.created.push(next);
    else if (previous !== next && !sameContent(previous, next)) diff.modified.push({ before: previous, after: next });
  }
  for (const id of before.order) {
    const previous = before.entities[id];
    if (previous !== undefined && after.entities[id] === undefined) diff.removed.push(previous);
  }
  return diff;
}

/** Bounds that never throw: a malformed entity just gets no effect anchor. */
function safeBounds(document: CadDocument, entity: Entity): Bounds | null {
  try {
    const bounds = entityBoundsInDoc(document, entity);
    return bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite) ? bounds : null;
  } catch {
    return null;
  }
}

const centerOf = (b: Bounds): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

const extentOf = (b: Bounds): number => Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);

function pivotOf(entity: Entity, b: Bounds | null): Vec3 {
  if (b === null) return [entity.position[0], entity.position[1], entity.position[2]];
  const center = centerOf(b);
  return is2D(entity) ? center : [center[0], center[1], b.min[2]];
}

const samePose = (a: Entity, b: Entity): boolean =>
  a.position.every((value, axis) => value === b.position[axis]) && a.rotation.every((value, axis) => value === b.rotation[axis]);

const sourceLabel: Record<LiveCommandSource, string> = { mcp: 'MCP agent', cli: 'CLI', rest: 'API' };

export function liveSourceLabel(source: LiveCommandSource, userName?: string): string {
  return userName === undefined ? sourceLabel[source] : `${userName} · ${sourceLabel[source]}`;
}

/** Staggered start: a 50-entity plan builds up as a cascade instead of popping in at once. */
export function staggerDelay(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.min(index * STAGGER_MS, (MAX_STAGGER_SPAN_MS * index) / (count - 1));
}

function activityFor(origin: LiveFxOrigin, diff: EntityDiff, nowMs: number, seq: number): LiveActivity | null {
  if (origin.kind !== 'remote') return null;
  return {
    key: `activity-${seq}`,
    name: origin.name,
    source: origin.source,
    ...(origin.userName !== undefined ? { userName: origin.userName } : {}),
    created: diff.created.length,
    modified: diff.modified.length,
    removed: diff.removed.length,
    atMs: nowMs,
  };
}

const EMPTY_PLAN: LiveFxPlan = { transitions: [], ghosts: [], ripples: [], badge: null, activity: null, focus: null, refocus: false };

/**
 * @param seq monotonically increasing per call; keys ghosts/ripples/badges so repeated edits never collide
 * @invariant pure: never reads the clock (nowMs is injected) or mutates either document
 */
export function planLiveFx(before: CadDocument, after: CadDocument, origin: LiveFxOrigin, nowMs: number, seq: number): LiveFxPlan {
  const diff = diffEntities(before, after);
  const total = diff.created.length + diff.modified.length + diff.removed.length;
  if (total === 0) return EMPTY_PLAN;
  const activity = activityFor(origin, diff, nowMs, seq);
  if (total > MAX_ANIMATED_CHANGES) return { ...EMPTY_PLAN, activity };

  const remote = origin.kind !== 'local';
  const tone: LiveFxTone = origin.kind === 'remote' ? origin.source : origin.kind;
  const transitions: EntityTransition[] = [];
  const ghosts: LiveGhost[] = [];
  const ripples: LiveRipple[] = [];
  let focus: Bounds | null = null;
  let index = 0;
  const widen = (b: Bounds | null): void => {
    if (b !== null) focus = focus === null ? b : mergeBounds(focus, b);
  };

  for (const entity of diff.created) {
    const bounds = safeBounds(after, entity);
    const startMs = nowMs + staggerDelay(index++, total);
    const pivot = pivotOf(entity, bounds);
    transitions.push({ id: entity.id, tone, change: 'created', startMs, durationMs: CREATE_MS, poseTween: false, pivot });
    if (bounds !== null) {
      const radius = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], 1e-3) / 2;
      ripples.push({ key: `ripple-${seq}-${entity.id}`, tone, center: pivot, radius, startMs });
    }
    widen(bounds);
  }
  for (const { before: previous, after: entity } of diff.modified) {
    const bounds = safeBounds(after, entity);
    const startMs = nowMs + staggerDelay(index++, total);
    const poseTween = remote && !samePose(previous, entity);
    transitions.push({
      id: entity.id,
      tone,
      change: 'modified',
      startMs,
      durationMs: MODIFY_MS,
      before: previous,
      poseTween,
      pivot: pivotOf(entity, bounds),
    });
    if (remote && !poseTween) {
      const previousBounds = safeBounds(before, previous);
      if (previousBounds !== null) {
        const center = centerOf(previousBounds);
        ghosts.push({
          key: `ghost-${seq}-${entity.id}`,
          tone,
          size: extentOf(previousBounds),
          entity: previous,
          document: before,
          mode: 'replaced',
          startMs,
          durationMs: MODIFY_MS,
          center,
        });
      }
    }
    widen(bounds);
  }
  for (const entity of diff.removed) {
    const bounds = safeBounds(before, entity);
    const startMs = nowMs + staggerDelay(index++, total);
    const center = bounds === null ? entity.position : centerOf(bounds);
    const size = bounds === null ? 1 : extentOf(bounds);
    ghosts.push({
      key: `ghost-${seq}-${entity.id}`,
      tone,
      size,
      entity,
      document: before,
      mode: 'removed',
      startMs,
      durationMs: REMOVE_MS,
      center,
    });
    widen(bounds);
  }

  const badge = badgeFor(origin, focus, nowMs, seq);
  const refocus = origin.kind === 'remote' && before.camera === after.camera;
  return { transitions, ghosts, ripples, badge, activity, focus, refocus };
}

function badgeFor(origin: LiveFxOrigin, focus: Bounds | null, nowMs: number, seq: number): LiveBadge | null {
  if (origin.kind !== 'remote' || focus === null) return null;
  const box: Bounds = focus;
  const anchor: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.max[2]];
  return {
    key: `badge-${seq}`,
    label: `${liveSourceLabel(origin.source, origin.userName)} · ${origin.name}`,
    source: origin.source,
    anchor,
    startMs: nowMs,
  };
}
