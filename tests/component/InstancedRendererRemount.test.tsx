import { resetStore } from '../helpers/componentEntities';
import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import * as THREE from 'three';
import { createRoot, extend } from '@react-three/fiber';
import { InstancedRenderer } from '@ui/viewport/3d/InstancedRenderer';
import { groupEntitiesForInstancing } from '@ui/viewport/3d/grouping';
import { type Entity } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { localDispatch } from '../helpers/storeTestHelpers';

extend(THREE as unknown as Parameters<typeof extend>[0]);

/** Enough of a WebGLRenderer for r3f to mount a scene graph without WebGL. */
function headlessRenderer(): THREE.WebGLRenderer {
  const stub = {
    domElement: document.createElement('canvas'),
    xr: { addEventListener: (): void => {}, removeEventListener: (): void => {}, setAnimationLoop: (): void => {}, enabled: false },
    shadowMap: {},
    setPixelRatio: (): void => {},
    setSize: (): void => {},
    render: (): void => {},
    dispose: (): void => {},
    getPixelRatio: (): number => 1,
  };
  return stub as unknown as THREE.WebGLRenderer;
}

function instancedMesh(scene: THREE.Group): THREE.InstancedMesh {
  let found: THREE.InstancedMesh | undefined;
  scene.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) found = o;
  });
  if (!found) throw new Error('no InstancedMesh mounted');
  return found;
}

function instancePosition(mesh: THREE.InstancedMesh, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

describe('InstancedRenderer — display-mode switch', () => {
  beforeEach(() => {
    resetStore();
    useViewportStore.setState({ displayMode: 'shaded' });
  });
  it('keeps instance placement and color when the material (and so the InstancedMesh) is rebuilt', async () => {
    localDispatch('add_box', { size: [2, 2, 2], position: [10, 20, 30], color: '#ff0000' });
    const { entities, order } = useStore.getState().document;
    const batches = groupEntitiesForInstancing(order.map((id) => entities[id]).filter((e): e is Entity => e !== undefined));

    let scene = new THREE.Group();
    const root = createRoot(document.createElement('canvas'));
    await act(async () => {
      await root.configure({ gl: headlessRenderer(), frameloop: 'never' });
      root.render(
        <group ref={(g) => void (g && (scene = g))}>
          <InstancedRenderer batches={batches} selectionSet={new Set()} onSelect={() => {}} />
        </group>,
      );
    });
    expect(instancePosition(instancedMesh(scene), 0).toArray()).toEqual([10, 20, 30]);

    for (const mode of ['wireframe', 'shaded'] as const) {
      await act(async () => useViewportStore.setState({ displayMode: mode }));
      const mesh = instancedMesh(scene);
      expect(instancePosition(mesh, 0).toArray()).toEqual([10, 20, 30]);
      const color = new THREE.Color();
      mesh.getColorAt(0, color);
      expect(color.getHexString()).toBe('ff0000');
    }
    await act(async () => root.unmount());
  });
});
