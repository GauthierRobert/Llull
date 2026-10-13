// Render-only live-edit effects (never in the CadDocument): the transitions, ghosts, ripples and badges planned for each
// document change, plus the activity feed of remote (CLI / MCP / API) commands. Fed by useLiveFx; drawn by viewport/liveFx.

import { create } from 'zustand';
import type { EntityId } from '@core/model/types';
import type { Bounds } from '@core/geometry/bounds';
import type { EntityTransition, LiveActivity, LiveBadge, LiveFxPlan, LiveGhost, LiveRipple } from '@ui/viewport/liveFx/planLiveFx';

/** How long a badge / ripple stays on screen. */
const BADGE_MS = 2600;
export const RIPPLE_MS = 1100;
/** Activity feed: newest first, bounded, each entry fades after ACTIVITY_MS. */
export const ACTIVITY_MS = 7000;
const ACTIVITY_LIMIT = 6;

interface FocusRequest {
  readonly bounds: Bounds;
  readonly nonce: number;
}

interface LiveFxState {
  /** Off = changes apply instantly (also forced by prefers-reduced-motion at start-up). */
  enabled: boolean;
  transitions: ReadonlyMap<EntityId, EntityTransition>;
  ghosts: readonly LiveGhost[];
  ripples: readonly LiveRipple[];
  badges: readonly LiveBadge[];
  activity: readonly LiveActivity[];
  /** Latest remote change to bring into view (consumed by the 3D camera). */
  focus: FocusRequest | null;
  apply(plan: LiveFxPlan): void;
  /** Drop everything that finished before `nowMs`; a no-op (no store update) when nothing expired. */
  prune(nowMs: number): void;
  setEnabled(enabled: boolean): void;
}

const prefersReducedMotion = (): boolean =>
  typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

const EMPTY_TRANSITIONS: ReadonlyMap<EntityId, EntityTransition> = new Map();

export function hasActiveLiveFx(state: Pick<LiveFxState, 'transitions' | 'ghosts' | 'ripples' | 'badges'>): boolean {
  return state.transitions.size > 0 || state.ghosts.length > 0 || state.ripples.length > 0 || state.badges.length > 0;
}

export const useLiveFxStore = create<LiveFxState>()((set, get) => ({
  enabled: !prefersReducedMotion(),
  transitions: EMPTY_TRANSITIONS,
  ghosts: [],
  ripples: [],
  badges: [],
  activity: [],
  focus: null,

  apply(plan: LiveFxPlan): void {
    const state = get();
    const patch: Partial<LiveFxState> = {};
    if (plan.activity !== null) patch.activity = [plan.activity, ...state.activity].slice(0, ACTIVITY_LIMIT);
    if (state.enabled) {
      const removedIds = plan.ghosts.filter((ghost) => ghost.mode === 'removed').map((ghost) => ghost.entity.id);
      if (plan.transitions.length > 0 || removedIds.some((id) => state.transitions.has(id))) {
        const transitions = new Map(state.transitions);
        for (const transition of plan.transitions) {
          const running = transitions.get(transition.id);
          // An edit right after a creation must not cut the grow short.
          if (running?.change === 'created' && running.startMs + running.durationMs > transition.startMs) continue;
          transitions.set(transition.id, transition);
        }
        // A removed entity's ghost replaces any transition it still had.
        for (const id of removedIds) transitions.delete(id);
        patch.transitions = transitions;
      }
      if (plan.ghosts.length > 0) patch.ghosts = [...state.ghosts, ...plan.ghosts];
      if (plan.ripples.length > 0) patch.ripples = [...state.ripples, ...plan.ripples];
      if (plan.badge !== null) patch.badges = [...state.badges, plan.badge];
      if (plan.focus !== null && plan.refocus) patch.focus = { bounds: plan.focus, nonce: (state.focus?.nonce ?? 0) + 1 };
    }
    if (Object.keys(patch).length > 0) set(patch);
  },

  prune(nowMs: number): void {
    const state = get();
    const patch: Partial<LiveFxState> = {};
    let transitions: Map<EntityId, EntityTransition> | null = null;
    for (const [id, transition] of state.transitions) {
      if (transition.startMs + transition.durationMs > nowMs) continue;
      transitions ??= new Map(state.transitions);
      transitions.delete(id);
    }
    if (transitions !== null) patch.transitions = transitions;
    const ghosts = state.ghosts.filter((ghost) => ghost.startMs + ghost.durationMs > nowMs);
    if (ghosts.length !== state.ghosts.length) patch.ghosts = ghosts;
    const ripples = state.ripples.filter((ripple) => ripple.startMs + RIPPLE_MS > nowMs);
    if (ripples.length !== state.ripples.length) patch.ripples = ripples;
    const badges = state.badges.filter((badge) => badge.startMs + BADGE_MS > nowMs);
    if (badges.length !== state.badges.length) patch.badges = badges;
    const activity = state.activity.filter((entry) => entry.atMs + ACTIVITY_MS > nowMs);
    if (activity.length !== state.activity.length) patch.activity = activity;
    if (Object.keys(patch).length > 0) set(patch);
  },

  setEnabled(enabled: boolean): void {
    set(enabled ? { enabled } : { enabled, transitions: EMPTY_TRANSITIONS, ghosts: [], ripples: [], badges: [] });
  },
}));
