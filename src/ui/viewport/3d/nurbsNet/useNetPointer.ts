// Pointer input of the control-net overlay: a press on a pole grabs it, dragging moves it in the view plane (X / Y / Z lock an axis, Esc
// cancels) and the release commits ONE move_poles command. The pointer is captured for the drag; a press that hits no pole is left to the
// camera. Previews are local dry runs scheduled once per frame; nothing here edits the document.

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { VIEWPORT_FOV_DEGREES } from '@core/model/viewport';
import type { Vec3 } from '@core/model/types';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { type AxisLock, crossedThreshold, translateDelta, unitsPerPixel } from '../cage/dragMath';
import { createFrameScheduler } from '../cage/frameScheduler';
import { capturePointer, releasePointer } from '../pointerCapture';
import { createWorldRay, type WorldRay } from '../worldRay';
import { type NurbsNetEntity, type PoleId, pickPole } from './controlNet';
import { cancelPoleDrag, commitPoleDrag, updatePoleDrag } from './netActions';

const PICK_PX = 11;

interface Press {
  readonly pole: PoleId;
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly ray: WorldRay;
  readonly pointerId: number;
  readonly target: EventTarget | null;
  readonly x: number;
  readonly y: number;
  active: boolean;
}

export function useNetPointer(entity: NurbsNetEntity | undefined): void {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const entityRef = useRef(entity);
  entityRef.current = entity;

  useEffect(() => {
    const host = gl.domElement.parentElement;
    if (host === null) return undefined;
    const rayAt = createWorldRay(gl, camera);
    const forward = new THREE.Vector3();
    let press: Press | null = null;
    let lock: AxisLock = null;
    let last = { x: 0, y: 0 };
    const frames = createFrameScheduler(
      (cb) => window.requestAnimationFrame(cb),
      (handle) => window.cancelAnimationFrame(handle),
    );
    const unitsAt = (distance: number): number => unitsPerPixel(distance, VIEWPORT_FOV_DEGREES, gl.domElement.clientHeight);

    const onPointerDown = (event: PointerEvent): void => {
      const target = entityRef.current;
      if (target === undefined || !useNurbsNetStore.getState().visible || event.button !== 0) return;
      const ray = rayAt(event.clientX, event.clientY);
      const hit = pickPole(target, ray, PICK_PX, unitsAt);
      if (hit === null) return;
      camera.getWorldDirection(forward);
      press = {
        pole: hit.pole.id,
        origin: hit.world,
        axis: [forward.x, forward.y, forward.z],
        ray,
        pointerId: event.pointerId,
        target: event.target,
        x: event.clientX,
        y: event.clientY,
        active: false,
      };
      capturePointer(event.target, event.pointerId);
      event.stopPropagation();
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent): void => {
      const target = entityRef.current;
      if (target === undefined || !useNurbsNetStore.getState().visible) return;
      last = { x: event.clientX, y: event.clientY };
      if (press !== null) {
        if (!press.active && !crossedThreshold({ x: press.x, y: press.y }, last)) return;
        press.active = true;
        const held = press;
        frames.schedule(() => {
          if (press !== held) return;
          const delta = translateDelta(held, rayAt(last.x, last.y), lock);
          if (delta !== null) updatePoleDrag(target.id, held.pole, delta);
        });
        return;
      }
      frames.schedule(() => {
        const ray = rayAt(last.x, last.y);
        useNurbsNetStore.getState().setHover(pickPole(target, ray, PICK_PX, unitsAt)?.pole.id ?? null);
      });
    };

    const end = (commit: boolean): void => {
      const held = press;
      press = null;
      if (held === null) return;
      frames.cancel();
      releasePointer(held.target, held.pointerId);
      const finalLock = lock;
      lock = null;
      if (!held.active) return;
      if (commit) {
        // the last frame may not have run: apply the final pointer position before committing
        const delta = translateDelta(held, rayAt(last.x, last.y), finalLock);
        const target = entityRef.current;
        if (delta !== null && target !== undefined) updatePoleDrag(target.id, held.pole, delta);
        commitPoleDrag();
      } else cancelPoleDrag();
    };
    const onPointerUp = (event: PointerEvent): void => end(event.button === 0);
    const onPointerCancel = (): void => end(false);
    const onLostCapture = (): void => {
      if (press?.active === true) end(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (press?.active !== true) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        event.preventDefault();
        event.stopPropagation();
        end(false);
      } else if (key === 'x' || key === 'y' || key === 'z') lock = key;
    };
    const onClick = (event: MouseEvent): void => {
      if (useNurbsNetStore.getState().hover !== null) event.stopPropagation();
    };

    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('click', onClick, true);
    host.addEventListener('lostpointercapture', onLostCapture, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKey, true);
    return () => {
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('click', onClick, true);
      host.removeEventListener('lostpointercapture', onLostCapture, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKey, true);
      frames.cancel();
      if (press?.active === true) cancelPoleDrag();
    };
  }, [gl, camera]);
}
