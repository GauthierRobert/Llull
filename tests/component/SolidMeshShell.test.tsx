/**
 * SolidMeshShell lifecycle: BVH build + geometry disposal for every solid kind.
 * jsdom has no WebGL, so the shell is rendered with react-dom (r3f intrinsics become
 * unknown DOM elements; their warnings are silenced) and the geometry is spied on.
 *
 * @layer tests/component
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { render, cleanup } from '@testing-library/react';
import { ensureBvhSetup } from '@ui/viewport/3d/bvhSetup';
import { SolidMeshShell } from '@ui/viewport/3d/entities/SolidMeshShell';

ensureBvhSetup();

vi.mock('@ui/viewport/3d/useMaterialProps', () => ({
  useMaterialProps: (): Record<string, unknown> => ({ color: '#fff' }),
}));

const entity = {
  id: 'box-1',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  color: '#ffffff',
} as const;

function spiedGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  vi.spyOn(geometry, 'computeBoundsTree').mockImplementation(() => undefined as never);
  vi.spyOn(geometry, 'disposeBoundsTree').mockImplementation(() => undefined as never);
  vi.spyOn(geometry, 'dispose');
  return geometry;
}

describe('SolidMeshShell', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('builds a BVH on mount and disposes geometry + BVH on unmount', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const geometry = spiedGeometry();
    const { unmount } = render(
      <SolidMeshShell
        entity={{ ...entity, position: [0, 0, 0], rotation: [0, 0, 0] }}
        geometry={geometry}
        selected={false}
        onSelect={() => undefined}
      />,
    );
    expect(geometry.computeBoundsTree).toHaveBeenCalledOnce();
    unmount();
    expect(geometry.disposeBoundsTree).toHaveBeenCalledOnce();
    expect(geometry.dispose).toHaveBeenCalledOnce();
  });

  it('skips the BVH when boundsTree is false but still disposes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const geometry = spiedGeometry();
    const { unmount } = render(
      <SolidMeshShell
        entity={{ ...entity, position: [0, 0, 0], rotation: [0, 0, 0] }}
        geometry={geometry}
        selected={false}
        onSelect={() => undefined}
        boundsTree={false}
      />,
    );
    expect(geometry.computeBoundsTree).not.toHaveBeenCalled();
    unmount();
    expect(geometry.disposeBoundsTree).not.toHaveBeenCalled();
    expect(geometry.dispose).toHaveBeenCalledOnce();
  });
});
