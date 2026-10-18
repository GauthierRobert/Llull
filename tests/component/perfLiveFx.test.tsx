import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { type EntityTransition } from '@ui/viewport/liveFx/planLiveFx';
import { shouldPruneTransitions, useLiveFxStore } from '@ui/store/liveFxStore';
import { useTransitioningIds } from '@ui/store/transitioningIds';

const transition = (id: string, startMs: number, durationMs: number): EntityTransition =>
  ({ id, tone: 'local', change: 'created', startMs, durationMs, poseTween: false, pivot: [0, 0, 0] }) as unknown as EntityTransition;

describe('shouldPruneTransitions', () => {
  it('waits a burst while others still run, and prunes at once when all finished', () => {
    const map = new Map([
      ['a', transition('a', 0, 100)],
      ['b', transition('b', 0, 1000)],
    ]);
    expect(shouldPruneTransitions(map, 50)).toBe(false);
    expect(shouldPruneTransitions(map, 150)).toBe(false);
    expect(shouldPruneTransitions(map, 300)).toBe(true);
    expect(shouldPruneTransitions(map, 2000)).toBe(true);
    expect(shouldPruneTransitions(new Map(), 10)).toBe(false);
  });
});

describe('useTransitioningIds', () => {
  it('changes identity only when membership changes', () => {
    useLiveFxStore.setState({ transitions: new Map([['a', transition('a', 0, 10)]]) });
    const { result } = renderHook(() => useTransitioningIds());
    const first = result.current;
    expect([...first]).toEqual(['a']);
    act(() => useLiveFxStore.setState({ transitions: new Map([['a', transition('a', 5, 10)]]) }));
    expect(result.current).toBe(first);
    act(() => useLiveFxStore.setState({ transitions: new Map() }));
    expect(result.current.size).toBe(0);
  });
});
