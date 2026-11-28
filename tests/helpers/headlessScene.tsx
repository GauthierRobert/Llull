/**
 * A react-three-fiber root with a stub renderer (no GL context): mounts scene content in jsdom and hands back the three.js scene to
 * inspect. USE IN TESTS ONLY.
 */

import * as THREE from 'three';
import { act } from '@testing-library/react';
import { createRoot, extend } from '@react-three/fiber';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { useStore } from '@ui/store';

extend(THREE as unknown as Parameters<typeof extend>[0]);

function headlessRenderer(): THREE.WebGLRenderer {
  return {
    domElement: document.createElement('canvas'),
    xr: { addEventListener: (): void => {}, removeEventListener: (): void => {}, setAnimationLoop: (): void => {}, enabled: false },
    shadowMap: {},
    setPixelRatio: (): void => {},
    setSize: (): void => {},
    render: (): void => {},
    dispose: (): void => {},
    getPixelRatio: (): number => 1,
  } as unknown as THREE.WebGLRenderer;
}

export interface HeadlessScene {
  readonly scene: THREE.Scene;
  /** Lets pending promises (texture loads) settle and React re-render. */
  settle(): Promise<void>;
  unmount(): Promise<void>;
}

export async function mountScene(content: React.ReactElement): Promise<HeadlessScene> {
  const root = createRoot(document.createElement('canvas'));
  let store!: ReturnType<typeof root.render>;
  await act(async () => {
    await root.configure({ gl: headlessRenderer(), frameloop: 'never' });
    store = root.render(content);
  });
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await settle();
  return {
    scene: store.getState().scene,
    settle,
    unmount: () =>
      act(async () => {
        root.unmount();
      }),
  };
}

/** `entities` (in order) on an otherwise empty document, put into the store. */
export function documentOf(entities: readonly Entity[], extra: Partial<CadDocument> = {}): CadDocument {
  const empty = createEmptyDocument();
  const document: CadDocument = {
    ...empty,
    ...extra,
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    order: entities.map((entity) => entity.id),
  };
  useStore.setState({ document });
  return document;
}
