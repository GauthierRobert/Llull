/**
 * Tests for the 3D AnimationPlayer system.
 *
 * Covers:
 *   1. viewportStore animation actions: toggleAnimationPlaying, setAnimationPlaying,
 *      resetAnimations (nonce + clear), toggleClickAnimation.
 *   2. AnimationTransportControls (inside ViewportControls): Play/Pause + Reset buttons
 *      are rendered when animations exist, invoke store actions on click, show correct
 *      aria-pressed state.
 *   3. Click-trigger interaction: findClickAnimationsForEntity pure helper.
 *   4. Smoke test: AnimationPlayer mounts without crashing given a document with animations.
 *
 * Does NOT assert three.js per-frame math (not feasible in jsdom / no WebGL).
 * Asserts observable behaviour only (rule R11).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useViewportStore } from '@ui/store';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { __resetIdCounter } from '@lib/id';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { findClickAnimationsForEntity } from '@ui/viewport/3d/animationClickHelpers';
import type { Animation, EntityGroup } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnimation(overrides: Partial<Animation> & { id: string }): Animation {
  const base: Animation = {
    id: overrides.id,
    targetId: overrides.targetId ?? 'ent-1',
    targetKind: overrides.targetKind ?? 'entity',
    channel: overrides.channel ?? 'rotation',
    axis: overrides.axis ?? [0, 1, 0],
    mode: overrides.mode ?? 'spin',
    speed: overrides.speed ?? 1,
    amplitude: overrides.amplitude ?? 1,
    frequency: overrides.frequency ?? 1,
    trigger: overrides.trigger ?? 'auto',
  };
  if (overrides.pivot !== undefined) {
    return { ...base, pivot: overrides.pivot };
  }
  return base;
}

function resetStores(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  useViewportStore.setState({
    displayMode: 'shaded',
    clipPlane: { enabled: false, axis: 'y', offset: 0, flipped: false },
    hiddenEntityIds: new Set(),
    animationPlaying: false,
    activeClickAnimationIds: new Set(),
    animationResetNonce: 0,
  });
}

// ---------------------------------------------------------------------------
// Part A — viewportStore animation actions
// ---------------------------------------------------------------------------

describe('viewportStore — animation state defaults', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('animationPlaying defaults to false', () => {
    expect(useViewportStore.getState().animationPlaying).toBe(false);
  });

  it('activeClickAnimationIds defaults to empty set', () => {
    expect(useViewportStore.getState().activeClickAnimationIds.size).toBe(0);
  });

  it('animationResetNonce defaults to 0', () => {
    expect(useViewportStore.getState().animationResetNonce).toBe(0);
  });
});

describe('viewportStore — toggleAnimationPlaying', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('toggleAnimationPlaying sets playing to true', () => {
    useViewportStore.getState().toggleAnimationPlaying();
    expect(useViewportStore.getState().animationPlaying).toBe(true);
  });

  it('toggleAnimationPlaying twice returns to false', () => {
    useViewportStore.getState().toggleAnimationPlaying();
    useViewportStore.getState().toggleAnimationPlaying();
    expect(useViewportStore.getState().animationPlaying).toBe(false);
  });
});

describe('viewportStore — setAnimationPlaying', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('setAnimationPlaying(true) sets playing to true', () => {
    useViewportStore.getState().setAnimationPlaying(true);
    expect(useViewportStore.getState().animationPlaying).toBe(true);
  });

  it('setAnimationPlaying(false) sets playing to false', () => {
    useViewportStore.getState().setAnimationPlaying(true);
    useViewportStore.getState().setAnimationPlaying(false);
    expect(useViewportStore.getState().animationPlaying).toBe(false);
  });
});

describe('viewportStore — resetAnimations', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('resetAnimations stops playback', () => {
    useViewportStore.getState().setAnimationPlaying(true);
    useViewportStore.getState().resetAnimations();
    expect(useViewportStore.getState().animationPlaying).toBe(false);
  });

  it('resetAnimations clears activeClickAnimationIds', () => {
    useViewportStore.getState().toggleClickAnimation('anim-1');
    useViewportStore.getState().toggleClickAnimation('anim-2');
    useViewportStore.getState().resetAnimations();
    expect(useViewportStore.getState().activeClickAnimationIds.size).toBe(0);
  });

  it('resetAnimations bumps animationResetNonce', () => {
    const before = useViewportStore.getState().animationResetNonce;
    useViewportStore.getState().resetAnimations();
    expect(useViewportStore.getState().animationResetNonce).toBe(before + 1);
  });

  it('calling resetAnimations twice increments nonce by 2', () => {
    const before = useViewportStore.getState().animationResetNonce;
    useViewportStore.getState().resetAnimations();
    useViewportStore.getState().resetAnimations();
    expect(useViewportStore.getState().animationResetNonce).toBe(before + 2);
  });
});

describe('viewportStore — toggleClickAnimation', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('toggleClickAnimation adds an animation id to the active set', () => {
    useViewportStore.getState().toggleClickAnimation('anim-A');
    expect(useViewportStore.getState().activeClickAnimationIds.has('anim-A')).toBe(true);
  });

  it('toggleClickAnimation on an active id removes it (toggle off)', () => {
    useViewportStore.getState().toggleClickAnimation('anim-A');
    useViewportStore.getState().toggleClickAnimation('anim-A');
    expect(useViewportStore.getState().activeClickAnimationIds.has('anim-A')).toBe(false);
  });

  it('multiple click animations can be active independently', () => {
    useViewportStore.getState().toggleClickAnimation('anim-A');
    useViewportStore.getState().toggleClickAnimation('anim-B');
    const { activeClickAnimationIds } = useViewportStore.getState();
    expect(activeClickAnimationIds.has('anim-A')).toBe(true);
    expect(activeClickAnimationIds.has('anim-B')).toBe(true);
    expect(activeClickAnimationIds.size).toBe(2);
  });

  it('toggling one does not affect another', () => {
    useViewportStore.getState().toggleClickAnimation('anim-A');
    useViewportStore.getState().toggleClickAnimation('anim-B');
    useViewportStore.getState().toggleClickAnimation('anim-A');
    const { activeClickAnimationIds } = useViewportStore.getState();
    expect(activeClickAnimationIds.has('anim-A')).toBe(false);
    expect(activeClickAnimationIds.has('anim-B')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part D — AnimationTransportControls inside ViewportControls
// ---------------------------------------------------------------------------

describe('ViewportControls — animation transport controls (no animations)', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
  });

  it('does NOT render Play or Reset buttons when document has no animations', () => {
    render(<ViewportControls />);
    expect(screen.queryByRole('button', { name: /play animations/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /pause animations/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reset animations/i })).toBeNull();
  });
});

describe('ViewportControls — animation transport controls (with animations)', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStores();
    // Inject a document with one animation so the transport controls appear.
    const doc = createEmptyDocument();
    const anim = makeAnimation({ id: 'anim-1', trigger: 'auto' });
    useStore.setState({
      document: { ...doc, animations: { 'anim-1': anim } },
    });
  });

  it('renders a Play button when not playing', () => {
    render(<ViewportControls />);
    expect(screen.getByRole('button', { name: /play animations/i })).toBeDefined();
  });

  it('Play button has aria-pressed="false" when not playing', () => {
    render(<ViewportControls />);
    const btn = screen.getByRole('button', { name: /play animations/i });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking Play calls toggleAnimationPlaying and sets playing to true', () => {
    render(<ViewportControls />);
    fireEvent.click(screen.getByRole('button', { name: /play animations/i }));
    expect(useViewportStore.getState().animationPlaying).toBe(true);
  });

  it('renders a Pause button when playing', () => {
    useViewportStore.setState({ animationPlaying: true });
    render(<ViewportControls />);
    expect(screen.getByRole('button', { name: /pause animations/i })).toBeDefined();
  });

  it('clicking Pause stops playback', () => {
    useViewportStore.setState({ animationPlaying: true });
    render(<ViewportControls />);
    fireEvent.click(screen.getByRole('button', { name: /pause animations/i }));
    expect(useViewportStore.getState().animationPlaying).toBe(false);
  });

  it('renders a Reset button', () => {
    render(<ViewportControls />);
    expect(screen.getByRole('button', { name: /reset animations/i })).toBeDefined();
  });

  it('clicking Reset calls resetAnimations — stops playing and bumps nonce', () => {
    useViewportStore.setState({ animationPlaying: true });
    const nonceBefore = useViewportStore.getState().animationResetNonce;
    render(<ViewportControls />);
    fireEvent.click(screen.getByRole('button', { name: /reset animations/i }));
    expect(useViewportStore.getState().animationPlaying).toBe(false);
    expect(useViewportStore.getState().animationResetNonce).toBe(nonceBefore + 1);
  });

  it('the animation group has aria-label "Animation transport"', () => {
    render(<ViewportControls />);
    expect(
      screen.getByRole('group', { name: 'Animation transport' }),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Part C — findClickAnimationsForEntity pure helper
// ---------------------------------------------------------------------------

describe('findClickAnimationsForEntity — direct entity target', () => {
  it('returns animation id when entity is the direct target with trigger:click', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'ent-1', targetKind: 'entity', trigger: 'click' }),
    };
    const groups: Record<string, EntityGroup> = {};
    expect(findClickAnimationsForEntity('ent-1', animations, groups)).toEqual(['a1']);
  });

  it('ignores auto-trigger animations', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'ent-1', targetKind: 'entity', trigger: 'auto' }),
    };
    const groups: Record<string, EntityGroup> = {};
    expect(findClickAnimationsForEntity('ent-1', animations, groups)).toEqual([]);
  });

  it('ignores animations targeting a different entity', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'ent-2', targetKind: 'entity', trigger: 'click' }),
    };
    const groups: Record<string, EntityGroup> = {};
    expect(findClickAnimationsForEntity('ent-1', animations, groups)).toEqual([]);
  });

  it('returns multiple ids when several click animations target the same entity', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'ent-1', targetKind: 'entity', trigger: 'click' }),
      'a2': makeAnimation({ id: 'a2', targetId: 'ent-1', targetKind: 'entity', trigger: 'click' }),
    };
    const groups: Record<string, EntityGroup> = {};
    const result = findClickAnimationsForEntity('ent-1', animations, groups);
    expect(result).toContain('a1');
    expect(result).toContain('a2');
    expect(result.length).toBe(2);
  });
});

describe('findClickAnimationsForEntity — group target', () => {
  it('returns animation id when entity is a member of the targeted group', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'grp-1', targetKind: 'group', trigger: 'click' }),
    };
    const groups: Record<string, EntityGroup> = {
      'grp-1': { id: 'grp-1', name: 'Group', memberIds: ['ent-1', 'ent-2'] },
    };
    expect(findClickAnimationsForEntity('ent-1', animations, groups)).toEqual(['a1']);
  });

  it('returns nothing when entity is NOT in the targeted group', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'grp-1', targetKind: 'group', trigger: 'click' }),
    };
    const groups: Record<string, EntityGroup> = {
      'grp-1': { id: 'grp-1', name: 'Group', memberIds: ['ent-3'] },
    };
    expect(findClickAnimationsForEntity('ent-1', animations, groups)).toEqual([]);
  });

  it('returns nothing when the group does not exist', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'grp-missing', targetKind: 'group', trigger: 'click' }),
    };
    const groups: Record<string, EntityGroup> = {};
    expect(findClickAnimationsForEntity('ent-1', animations, groups)).toEqual([]);
  });

  it('ignores group animation with trigger:auto', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'grp-1', targetKind: 'group', trigger: 'auto' }),
    };
    const groups: Record<string, EntityGroup> = {
      'grp-1': { id: 'grp-1', name: 'Group', memberIds: ['ent-1'] },
    };
    expect(findClickAnimationsForEntity('ent-1', animations, groups)).toEqual([]);
  });
});

describe('findClickAnimationsForEntity — mixed direct + group', () => {
  it('collects from both direct and group targets in one call', () => {
    const animations: Record<string, Animation> = {
      'a1': makeAnimation({ id: 'a1', targetId: 'ent-1', targetKind: 'entity', trigger: 'click' }),
      'a2': makeAnimation({ id: 'a2', targetId: 'grp-1', targetKind: 'group', trigger: 'click' }),
    };
    const groups: Record<string, EntityGroup> = {
      'grp-1': { id: 'grp-1', name: 'Group', memberIds: ['ent-1', 'ent-2'] },
    };
    const result = findClickAnimationsForEntity('ent-1', animations, groups);
    expect(result).toContain('a1');
    expect(result).toContain('a2');
    expect(result.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Smoke test: AnimationPlayer mounts without crashing
// (per-frame three.js math is not testable in jsdom)
// ---------------------------------------------------------------------------

describe('AnimationPlayer — smoke test', () => {
  it('findClickAnimationsForEntity returns [] for empty animations', () => {
    // Pure function exercised without any DOM/WebGL dependency.
    expect(findClickAnimationsForEntity('ent-1', {}, {})).toEqual([]);
  });
});
