// 05 IMP 14.x GPU preview: the mesh of a body the GPU draws is not rendered while the switch is on (no z-fighting of two surfaces); a fallback body keeps its mesh.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { useImplicitPreviewStore } from '@ui/store/implicitPreviewStore';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';

const mounted = vi.hoisted(() => ({ ids: new Set<string>() }));

vi.mock('@ui/viewport/3d/entities/solidMeshes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/viewport/3d/entities/solidMeshes')>();
  const Mesh = ({ entity }: { entity: { id: string } }): null => {
    useEffect(() => {
      mounted.ids.add(entity.id);
      return () => void mounted.ids.delete(entity.id);
    }, [entity.id]);
    return null;
  };
  return { SOLID_MESHES: { ...actual.SOLID_MESHES, cone: Mesh } };
});
vi.mock('@ui/viewport/3d/InstancedRenderer', () => ({ InstancedRenderer: (): null => null }));
vi.mock('@ui/viewport/3d/GridAnnotations3D', () => ({ GridAnnotations3D: (): null => null }));
vi.mock('@ui/viewport/3d/preview/PreviewLayer', () => ({ PreviewLayer: (): null => null }));
vi.mock('@ui/viewport/liveFx/LiveFxLayer', () => ({ LiveFxLayer: (): null => null }));
vi.mock('@ui/viewport/liveFx/LiveTransitionGroup', () => ({
  LiveTransitionGroup: ({ children }: { children: React.ReactNode }): React.ReactNode => children,
}));

import { Entities } from '@ui/viewport/3d/Entities';

describe('Entities with the GPU preview', () => {
  beforeEach(() => {
    mounted.ids.clear();
    resetStore();
    useImplicitPreviewStore.setState({ enabled: false, fallbacks: {}, drawn: {} });
  });

  it('does not render the mesh of a body the GPU draws, renders it again when the GPU stops, and never hides another body', () => {
    const box = localDispatch('add_cone', { radius: 1, height: 2 }).affected[0] as string;
    const other = localDispatch('add_cone', { radius: 2, height: 3 }).affected[0] as string;
    const body = box;
    render(<Entities />);
    expect(mounted.ids.has(body) && mounted.ids.has(other)).toBe(true);
    act(() => useImplicitPreviewStore.setState({ enabled: true, drawn: { [body]: true } }));
    expect(mounted.ids.has(body)).toBe(false);
    expect(mounted.ids.has(other)).toBe(true);
    act(() => useImplicitPreviewStore.getState().setDrawn(body, false));
    expect(mounted.ids.has(body)).toBe(true);
    act(() => useImplicitPreviewStore.setState({ enabled: false, drawn: { [body]: true } }));
    expect(mounted.ids.has(body)).toBe(true);
  });
});
