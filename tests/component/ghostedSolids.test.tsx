import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMaterialProps } from '@ui/viewport/3d/useMaterialProps';
import { useGhostStore } from '@ui/store/ghostStore';

describe('ghosted solids (a painted FEA result stands in for the part)', () => {
  it('draws a ghosted solid see-through without writing depth', () => {
    const { result } = renderHook(() => useMaterialProps({ color: '#888888', selected: false, ghosted: true }));
    expect(result.current.transparent).toBe(true);
    expect(result.current.opacity).toBeLessThan(0.2);
    expect(result.current.depthWrite).toBe(false);
  });

  it('a normal solid stays opaque', () => {
    const { result } = renderHook(() => useMaterialProps({ color: '#888888', selected: false }));
    expect(result.current.opacity).toBe(1);
  });

  it('ghosts the union of every source and clears per source', () => {
    act(() => useGhostStore.getState().setGhosted('analysis', new Set(['box-1.1'])));
    act(() => useGhostStore.getState().setGhosted('structural', new Set(['wall-1'])));
    expect([...useGhostStore.getState().ghostedIds].sort()).toEqual(['box-1.1', 'wall-1']);
    act(() => useGhostStore.getState().setGhosted('analysis', new Set()));
    expect([...useGhostStore.getState().ghostedIds]).toEqual(['wall-1']);
    act(() => useGhostStore.getState().setGhosted('structural', new Set()));
    expect(useGhostStore.getState().ghostedIds.size).toBe(0);
  });
});

describe('tinted solids (members coloured by utilisation on their real geometry)', () => {
  it('keeps one shared empty map when cleared and returns the colour per entity', async () => {
    const { useTintStore } = await import('@ui/store/tintStore');
    act(() => useTintStore.getState().setTints(new Map([['member-1', '#ff4d4f']])));
    expect(useTintStore.getState().tints.get('member-1')).toBe('#ff4d4f');
    const { result } = renderHook(() =>
      useMaterialProps({ color: useTintStore.getState().tints.get('member-1') ?? '#888', selected: false }),
    );
    expect(result.current.color).toBe('#ff4d4f');
    act(() => useTintStore.getState().setTints(new Map()));
    expect(useTintStore.getState().tints.size).toBe(0);
  });
});
