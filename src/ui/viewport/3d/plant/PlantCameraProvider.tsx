// Publishes the r3f camera to the entity tree: a new `version` when the camera (or canvas size) changes, throttled (leading + trailing,
// `moving: true`) while it moves, and once more `SETTLE_MS` after it stops (`moving: false`). Outside a Canvas the context is null and
// the plant renderer stays off.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

const SETTLE_MS = 150;
const THROTTLE_MS = 250;

export interface PlantCameraView {
  readonly camera: THREE.Camera;
  readonly width: number;
  readonly height: number;
  readonly version: number;
  readonly moving: boolean;
}

export const PlantCameraContext = createContext<PlantCameraView | null>(null);

export const usePlantCameraView = (): PlantCameraView | null => useContext(PlantCameraContext);

export function PlantCameraProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { camera, size, invalidate } = useThree();
  const [state, setState] = useState({ version: 0, moving: false });
  const seen = useRef({ matrix: new THREE.Matrix4(), fov: 0, zoom: 0, width: 0, height: 0 });
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastEmit = useRef(0);

  const emit = (moving: boolean): void => {
    lastEmit.current = performance.now();
    setState((previous) => ({ version: previous.version + 1, moving }));
    invalidate();
  };

  useFrame(() => {
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

  const view = useMemo(() => ({ camera, width: size.width, height: size.height, ...state }), [camera, size.width, size.height, state]);
  return <PlantCameraContext.Provider value={view}>{children}</PlantCameraContext.Provider>;
}
