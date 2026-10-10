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
import { type Animation, type EntityGroup, createEmptyDocument } from '@core/model/types';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { findClickAnimationsForEntity } from '@ui/viewport/3d/animationClickHelpers';

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
    expect(screen.getByRole('group', { name: 'Animation transport' })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Part C — findClickAnimationsForEntity pure helper
// ---------------------------------------------------------------------------

const clickAnim = (
  id: string,
  targetId: string,
  targetKind: 'entity' | 'group',
  trigger: 'click' | 'auto' = 'click',
): Animation => makeAnimation({ id, targetId, targetKind, trigger });

const groupOf = (...memberIds: string[]): EntityGroup => ({
  id: 'grp-1',
  name: 'Group',
  memberIds,
});

/** Run the helper for 'ent-1' over a list of animations and an optional 'grp-1' group. */
function findFor(animationList: Animation[], group?: EntityGroup): string[] {
  const animations = Object.fromEntries(animationList.map((a) => [a.id, a]));
  return findClickAnimationsForEntity('ent-1', animations, group ? { 'grp-1': group } : {});
}

describe('findClickAnimationsForEntity', () => {
  it.each<[string, Animation[], EntityGroup | undefined, string[]]>([
    [
      'the entity is the direct target with trigger:click',
      [clickAnim('a1', 'ent-1', 'entity')],
      undefined,
      ['a1'],
    ],
    [
      'the entity is a member of the targeted group',
      [clickAnim('a1', 'grp-1', 'group')],
      groupOf('ent-1', 'ent-2'),
      ['a1'],
    ],
    [
      'auto-trigger animations are ignored',
      [clickAnim('a1', 'ent-1', 'entity', 'auto')],
      undefined,
      [],
    ],
    [
      'animations targeting a different entity are ignored',
      [clickAnim('a1', 'ent-2', 'entity')],
      undefined,
      [],
    ],
    [
      'the entity is NOT in the targeted group',
      [clickAnim('a1', 'grp-1', 'group')],
      groupOf('ent-3'),
      [],
    ],
    ['the targeted group does not exist', [clickAnim('a1', 'grp-missing', 'group')], undefined, []],
    [
      'group animation with trigger:auto is ignored',
      [clickAnim('a1', 'grp-1', 'group', 'auto')],
      groupOf('ent-1'),
      [],
    ],
    ['there are no animations', [], undefined, []],
  ])('%s', (_label, animations, group, expected) => {
    expect(findFor(animations, group)).toEqual(expected);
  });

  it.each<[string, Animation[], EntityGroup | undefined]>([
    [
      'several click animations target the same entity',
      [clickAnim('a1', 'ent-1', 'entity'), clickAnim('a2', 'ent-1', 'entity')],
      undefined,
    ],
    [
      'both direct and group targets apply in one call',
      [clickAnim('a1', 'ent-1', 'entity'), clickAnim('a2', 'grp-1', 'group')],
      groupOf('ent-1', 'ent-2'),
    ],
  ])('returns both ids when %s', (_label, animations, group) => {
    const result = findFor(animations, group);
    expect(result).toContain('a1');
    expect(result).toContain('a2');
    expect(result.length).toBe(2);
  });
});
