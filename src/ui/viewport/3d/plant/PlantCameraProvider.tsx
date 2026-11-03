// Publishes the r3f camera to the entity tree through a stable store: a new view when the camera (or canvas size) changes, throttled
// (leading + trailing, `moving: true`) while it moves, and once more `SETTLE_MS` after it stops (`moving: false`). The context value
// never changes, and with no subscriber (no plant scene) the per-frame work is one flag check. Outside a Canvas the context is null.

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PlantCameraStore, type PlantCameraView } from './plantCameraStore';

const SETTLE_MS = 150;
const THROTTLE_MS = 250;

export const PlantCameraContext = createContext<PlantCameraStore | null>(null);

const noopSubscribe = (): (() => void) => () => undefined;
const noSnapshot = (): null => null;

/** The current camera view; subscribes (re-renders on every bump) only while `active`. */
export function usePlantCameraView(active: boolean): PlantCameraView | null {
  const store = useContext(PlantCameraContext);
  return useSyncExternalStore(active && store !== null ? store.subscribe : noopSubscribe, store === null ? noSnapshot : store.getSnapshot);
}

export function PlantCameraProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { camera, size, invalidate } = useThree();
  const [store] = useState(() => new PlantCameraStore({ camera, width: size.width, height: size.height, version: 0, moving: false }));
  const latest = useRef({ camera, size });
  latest.current = { camera, size };
  const seen = useRef({ matrix: new THREE.Matrix4(), fov: 0, zoom: 0, width: 0, height: 0 });
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastEmit = useRef(0);

  const emit = (moving: boolean): void => {
    lastEmit.current = performance.now();
    store.publish(latest.current.camera, latest.current.size.width, latest.current.size.height, moving);
    invalidate();
  };

  // Keeps the view's camera and size current while nobody listens (the first subscriber reads them).
  useEffect(() => {
    store.publish(camera, size.width, size.height, false);
  }, [store, camera, size.width, size.height]);

  useFrame(() => {
    if (!store.active) return;
    const last = seen.current;
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 0;
    if (
      last.matrix.equals(camera.matrixWorld) &&
      last.fov === fov &&
      last.zoom === camera.zoom &&
      last.width === size.width &&
      last.height === size.height
    )
      return;
    last.matrix.copy(camera.matrixWorld);
    last.fov = fov;
    last.zoom = camera.zoom;
    last.width = size.width;
    last.height = size.height;
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      clearTimeout(throttleTimer.current);
      throttleTimer.current = undefined;
      emit(false);
    }, SETTLE_MS);
    const since = performance.now() - lastEmit.current;
    if (since >= THROTTLE_MS) emit(true);
    else if (throttleTimer.current === undefined)
      throttleTimer.current = setTimeout(() => {
        throttleTimer.current = undefined;
        emit(true);
      }, THROTTLE_MS - since);
  });

  useEffect(
    () => () => {
      clearTimeout(settleTimer.current);
      clearTimeout(throttleTimer.current);
    },
    [],
  );

  return <PlantCameraContext.Provider value={store}>{children}</PlantCameraContext.Provider>;
}
