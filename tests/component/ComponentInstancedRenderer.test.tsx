import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import * as THREE from 'three';
import { createRoot, extend } from '@react-three/fiber';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { useStore } from '@ui/store';
import { ComponentInstancedRenderer } from '@ui/viewport/3d/ComponentInstancedRenderer';
import { MIN_INSTANCES_PER_COMPONENT, planComponentBatches } from '@ui/viewport/3d/componentInstancePlan';
import { Entities } from '@ui/viewport/3d/Entities';
import { resetStore } from '../helpers/componentEntities';

extend(THREE as unknown as Parameters<typeof extend>[0]);

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

/** A polar pattern of `count` members of one box, as `instances` (core M2). */
function polarPattern(count: number): CadDocument {
  const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [10, 0, 0] });
  const pattern = execute(box.document, 'array_polar', { id: box.affected[0], count, center: [0, 0, 0], as: 'instances' });
  return pattern.document;
}

function meshes(scene: THREE.Object3D): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  scene.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) found.push(o);
  });
  return found;
}

interface Mounted {
  scene: THREE.Group;
  unmount: () => Promise<void>;
}

async function mount(element: React.ReactElement): Promise<Mounted> {
  let scene = new THREE.Group();
  const root = createRoot(document.createElement('canvas'));
  await act(async () => {
    await root.configure({ gl: headlessRenderer(), frameloop: 'never' });
    root.render(<group ref={(g) => void (g && (scene = g))}>{element}</group>);
  });
  return { scene, unmount: () => act(async () => root.unmount()) };
}

function colourOf(mesh: THREE.InstancedMesh, slot: number): number {
  const colour = new THREE.Color();
  mesh.getColorAt(slot, colour);
  return colour.getHex();
}

function moveOver(mesh: THREE.InstancedMesh, instanceId: number | undefined): void {
  const props = (mesh as unknown as { __r3f: { props: { onPointerMove: (e: unknown) => void } } }).__r3f.props;
  props.onPointerMove({ instanceId, point: new THREE.Vector3(), nativeEvent: {} });
}

function clickInstance(mesh: THREE.InstancedMesh, instanceId: number): void {
  const handlers = (mesh as unknown as { __r3f: { props: { onClick: (e: unknown) => void } } }).__r3f.props;
  handlers.onClick({ instanceId, point: new THREE.Vector3(), stopPropagation: vi.fn(), nativeEvent: {} });
}

describe('ComponentInstancedRenderer', () => {
  beforeEach(() => {
    resetStore();
  });

  it('draws a 1,000-member pattern as one InstancedMesh (one draw call) and no per-entity meshes', async () => {
    const document = polarPattern(1000);
    useStore.setState({ document });
    const { scene, unmount } = await mount(<Entities />);
    // The far-LOD tier meshes exist but hold no instance until the camera puts some there: one draw call.
    const drawn = meshes(scene).filter((mesh) => mesh.count > 0);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.count).toBe(1000);
    const plain: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) plain.push(o);
    });
    expect(plain).toHaveLength(0);
    await unmount();
  });

  it('places member k at its instance position and picks it by instanceId', async () => {
    const document = polarPattern(12);
    const plan = planComponentBatches(Object.values(document.entities), document.components, () => true);
    expect(plan.covered.size).toBe(12);
    const selected: string[] = [];
    const { scene, unmount } = await mount(
      <ComponentInstancedRenderer
        plan={plan}
        entities={document.entities}
        materials={document.materials}
        selectionSet={new Set()}
        onSelect={(id) => void selected.push(id)}
      />,
    );
    const [mesh] = meshes(scene);
    expect(mesh).toBeDefined();
    const ids = plan.batches[0]?.ids ?? [];
    ids.forEach((id, index) => {
      const matrix = new THREE.Matrix4();
      mesh?.getMatrixAt(index, matrix);
      const placed = new THREE.Vector3().setFromMatrixPosition(matrix);
      expect(placed.toArray()).toEqual(document.entities[id]?.position);
    });
    clickInstance(mesh as THREE.InstancedMesh, 5);
    expect(selected).toEqual([ids[5]]);
    await unmount();
  });

  it('tints only the selected instance', async () => {
    const document = polarPattern(10);
    const plan = planComponentBatches(Object.values(document.entities), document.components, () => true);
    const ids = plan.batches[0]?.ids ?? [];
    const { scene, unmount } = await mount(
      <ComponentInstancedRenderer
        plan={plan}
        entities={document.entities}
        materials={document.materials}
        selectionSet={new Set([ids[3] as string])}
        onSelect={() => {}}
      />,
    );
    const [mesh] = meshes(scene);
    const colours = ids.map((_, i) => {
      const c = new THREE.Color();
      mesh?.getColorAt(i, c);
      return c.getHex();
    });
    expect(colours.filter((c) => c !== colours[0])).toHaveLength(1);
    expect(colours[3]).not.toBe(colours[0]);
    await unmount();
  });
});

describe('ComponentInstancedRenderer hover', () => {
  beforeEach(() => {
    resetStore();
  });

  it('highlights only the instance under the pointer, without rebuilding the mesh, and restores it on leave', async () => {
    const document = polarPattern(12);
    const plan = planComponentBatches(Object.values(document.entities), document.components, () => true);
    const { scene, unmount } = await mount(
      <ComponentInstancedRenderer
        plan={plan}
        entities={document.entities}
        materials={document.materials}
        selectionSet={new Set()}
        onSelect={() => {}}
      />,
    );
    const [mesh] = meshes(scene);
    const rest = Array.from({ length: 12 }, (_, i) => colourOf(mesh as THREE.InstancedMesh, i));
    moveOver(mesh as THREE.InstancedMesh, 4);
    const hovered = Array.from({ length: 12 }, (_, i) => colourOf(mesh as THREE.InstancedMesh, i));
    expect(hovered.filter((c, i) => c !== rest[i])).toHaveLength(1);
    expect(hovered[4]).not.toBe(rest[4]);
    expect(meshes(scene)[0]).toBe(mesh);
    const props = (mesh as unknown as { __r3f: { props: { onPointerOut: () => void } } }).__r3f.props;
    props.onPointerOut();
    expect(Array.from({ length: 12 }, (_, i) => colourOf(mesh as THREE.InstancedMesh, i))).toEqual(rest);
    await unmount();
  });

  it('does not touch the document or the selection', async () => {
    const document = polarPattern(12);
    useStore.setState({ document });
    const before = useStore.getState().document;
    const plan = planComponentBatches(Object.values(document.entities), document.components, () => true);
    const { scene, unmount } = await mount(
      <ComponentInstancedRenderer
        plan={plan}
        entities={document.entities}
        materials={document.materials}
        selectionSet={new Set()}
        onSelect={() => {}}
      />,
    );
    moveOver(meshes(scene)[0] as THREE.InstancedMesh, 2);
    expect(useStore.getState().document).toBe(before);
    await unmount();
  });
});

describe('planComponentBatches', () => {
  it('keeps a small pattern on the per-entity path', () => {
    const document = polarPattern(MIN_INSTANCES_PER_COMPONENT - 1);
    expect(planComponentBatches(Object.values(document.entities), document.components, () => true).batches).toHaveLength(0);
  });
  it('leaves ineligible instances to the per-entity path', () => {
    const document = polarPattern(10);
    const first = Object.keys(document.entities).sort()[0];
    const plan = planComponentBatches(Object.values(document.entities), document.components, (i) => i.id !== first);
    expect(plan.covered.size).toBe(9);
    expect(plan.covered.has(first as string)).toBe(false);
  });
});
