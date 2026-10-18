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

  it('the ghost store keeps one shared empty set when cleared', () => {
    act(() => useGhostStore.getState().setGhosted(new Set(['box-1.1'])));
    expect(useGhostStore.getState().ghostedIds.has('box-1.1')).toBe(true);
    const before = useGhostStore.getState().ghostedIds;
    act(() => useGhostStore.getState().setGhosted(new Set()));
    expect(useGhostStore.getState().ghostedIds.size).toBe(0);
    expect(useGhostStore.getState().ghostedIds).not.toBe(before);
  });
});
