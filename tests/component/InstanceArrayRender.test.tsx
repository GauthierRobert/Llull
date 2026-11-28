import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import * as THREE from 'three';
import { createRoot, extend } from '@react-three/fiber';
import { execute } from '@core/commands/registry';
import { decodedTransforms } from '@core/geometry/instanceArrays';
import { instanceMemberId } from '@core/model/instanceArray';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { ensureBvhSetup } from '@ui/viewport/3d/bvhSetup';
import { Entities } from '@ui/viewport/3d/Entities';
import { resetViewportStores } from '../helpers/componentEntities';

extend(THREE as unknown as Parameters<typeof extend>[0]);
ensureBvhSetup();

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

/** A bolt component (a box) placed on a `counts` grid as ONE instance array: no Entity per member. */
function arrayDocument(counts: [number, number, number], extra: Record<string, unknown> = {}): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] }).document;
  doc = execute(doc, 'create_component', { name: 'Bolt', entityIds: doc.order, componentId: 'bolt' }).document;
  doc = execute(doc, 'add_instance_array', { componentId: 'bolt', counts, step: [10, 10, 10], color: '#3366cc', ...extra }).document;
  return doc;
}

async function mount(element: React.ReactElement): Promise<{ scene: THREE.Group; unmount: () => Promise<void> }> {
  let scene = new THREE.Group();
  const root = createRoot(document.createElement('canvas'));
  await act(async () => {
    await root.configure({ gl: headlessRenderer(), frameloop: 'never' });
    root.render(<group ref={(g) => void (g && (scene = g))}>{element}</group>);
  });
  return { scene, unmount: () => act(async () => root.unmount()) };
}

function drawn(scene: THREE.Object3D): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  scene.traverse((o) => {
    if (o instanceof THREE.InstancedMesh && o.count > 0) found.push(o);
  });
  return found;
}

describe('instance arrays in the viewport', () => {
  beforeEach(() => {
    resetViewportStores();
  });

  it('draws every member of an array as one InstancedMesh with the array colour, and no per-entity meshes', async () => {
    const document = arrayDocument([10, 10, 10]);
    useStore.setState({ document });
    const { scene, unmount } = await mount(<Entities />);
    const meshes = drawn(scene);
    expect(meshes).toHaveLength(1);
    expect(meshes[0]?.count).toBe(1000);
    expect((meshes[0]?.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x3366cc);
    const table = decodedTransforms(Object.values(document.instanceArrays ?? {})[0]!)!;
    const matrix = new THREE.Matrix4();
    meshes[0]?.getMatrixAt(37, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([table[37 * 6], table[37 * 6 + 1], table[37 * 6 + 2]]);
    await unmount();
  });

  it('hides the members with their layer (document and viewport filter)', async () => {
    const document = arrayDocument([3, 3, 3]);
    const layerId = Object.values(document.instanceArrays ?? {})[0]!.layerId;
    useStore.setState({
      document: { ...document, layers: { ...document.layers, [layerId]: { ...document.layers[layerId]!, visible: false } } },
    });
    const hidden = await mount(<Entities />);
    expect(drawn(hidden.scene)).toHaveLength(0);
    await hidden.unmount();

    useStore.setState({ document });
    useViewportStore.setState({ hiddenLayerIds: new Set([layerId]) });
    const filtered = await mount(<Entities />);
    expect(drawn(filtered.scene)).toHaveLength(0);
    await filtered.unmount();
  });

  it('a click on a member stops propagation and clears the selection (members are not selectable entities)', async () => {
    const base = arrayDocument([4, 1, 1]);
    const arrayId = Object.keys(base.instanceArrays ?? {})[0]!;
    const withBox = execute(base, 'add_box', { size: [1, 1, 1], position: [50, 50, 0] });
    const document = execute(withBox.document, 'set_selection', { ids: withBox.affected }).document;
    useStore.setState({ document });
    expect(useStore.getState().document.selection).toHaveLength(1);
    const { scene, unmount } = await mount(<Entities />);
    const mesh = drawn(scene).find((candidate) => candidate.userData['arrayId'] === arrayId);
    expect(mesh).toBeDefined();
    const onClick = (mesh as unknown as { __r3f: { props: { onClick: (e: unknown) => void } } }).__r3f.props.onClick;
    const stopPropagation = vi.fn();
    onClick({ instanceId: 2, point: new THREE.Vector3(), stopPropagation, nativeEvent: {} });
    expect(stopPropagation).toHaveBeenCalled();
    expect(useStore.getState().document.selection).toEqual([]);
    expect(mesh?.userData['arrayId']).toBe(arrayId);
    expect(instanceMemberId(arrayId, 2)).toBe(`${arrayId}#2`);
    await unmount();
  });
});
