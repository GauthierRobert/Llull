// Pointer input of the control-net overlay: a press on a pole selects it (Shift adds / removes it) and grabs it, dragging moves the whole selection in
// the view plane (X / Y / Z lock an axis, Esc cancels) and the release commits ONE move_poles command (the falloff of the bar spreads it to the
// neighbours). Ctrl + drag on empty space (Shift + drag stays the camera's pan) draws a box and adds the poles inside it to the selection. The pointer is captured for a drag or a box; any
// other press is left to the camera. Previews are local dry runs scheduled once per frame; nothing here edits the document.

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { VIEWPORT_FOV_DEGREES } from '@core/model/viewport';
import type { Vec3 } from '@core/model/types';
import { useStore } from '@ui/store';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { type AxisLock, crossedThreshold, translateDelta, unitsPerPixel } from '../cage/dragMath';
import { createFrameScheduler } from '../cage/frameScheduler';
import { capturePointer, releasePointer } from '../pointerCapture';
import { createWorldRay, type WorldRay } from '../worldRay';
import { type NurbsNetEntity, type PoleId, pickPole, polesInRect, samePole, togglePole, unitePoles } from './controlNet';
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
  /** Shift was held: a click toggles the pole in the selection. */
  readonly toggle: boolean;
  active: boolean;
}

interface BoxPress {
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
    const scratch = new THREE.Vector3();
    let press: Press | null = null;
    let box: BoxPress | null = null;
    let lock: AxisLock = null;
    let swallowClick = false;
    let last = { x: 0, y: 0 };
    const frames = createFrameScheduler(
      (cb) => window.requestAnimationFrame(cb),
      (handle) => window.cancelAnimationFrame(handle),
    );
    const unitsAt = (distance: number): number => unitsPerPixel(distance, VIEWPORT_FOV_DEGREES, gl.domElement.clientHeight);
    /** A world point on the screen (client pixels), or null behind the camera. */
    const project = (world: Vec3): { x: number; y: number } | null => {
      const origin = useStore.getState().renderOrigin;
      scratch.set(world[0] - origin[0], world[1] - origin[1], world[2] - origin[2]).project(camera);
      if (scratch.z > 1) return null;
      const rect = gl.domElement.getBoundingClientRect();
      return { x: rect.left + ((scratch.x + 1) / 2) * rect.width, y: rect.top + ((1 - scratch.y) / 2) * rect.height };
    };

    const onPointerDown = (event: PointerEvent): void => {
      const target = entityRef.current;
      const net = useNurbsNetStore.getState();
      if (target === undefined || !net.visible || event.button !== 0) return;
      const ray = rayAt(event.clientX, event.clientY);
      const hit = pickPole(target, ray, PICK_PX, unitsAt);
      if (hit === null) {
        if (!(event.ctrlKey || event.metaKey)) return;
        box = { pointerId: event.pointerId, target: event.target, x: event.clientX, y: event.clientY, active: false };
        capturePointer(event.target, event.pointerId);
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      const inSelection = net.selected.some((pole) => samePole(pole, hit.pole.id));
      if (!event.shiftKey && !inSelection) net.setSelected([hit.pole.id]);
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
        toggle: event.shiftKey,
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
      if (box !== null) {
        if (!box.active && !crossedThreshold({ x: box.x, y: box.y }, last)) return;
        box.active = true;
        useNurbsNetStore.getState().setMarquee({ x0: box.x, y0: box.y, x1: last.x, y1: last.y });
        return;
      }
      if (press !== null) {
        if (!press.active && !crossedThreshold({ x: press.x, y: press.y }, last)) return;
        if (!press.active && press.toggle) {
          const net = useNurbsNetStore.getState();
          net.setSelected(unitePoles(net.selected, [press.pole]));
        }
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

    const endBox = (commit: boolean): void => {
      const held = box;
      box = null;
      if (held === null) return;
      releasePointer(held.target, held.pointerId);
      const net = useNurbsNetStore.getState();
      const target = entityRef.current;
      net.setMarquee(null);
      swallowClick = held.active;
      if (!commit || !held.active || target === undefined) return;
      net.setSelected(unitePoles(net.selected, polesInRect(target, project, { x0: held.x, y0: held.y, x1: last.x, y1: last.y })));
    };

    const end = (commit: boolean): void => {
      const held = press;
      press = null;
      if (held === null) return;
      frames.cancel();
      releasePointer(held.target, held.pointerId);
      const finalLock = lock;
      lock = null;
      if (!held.active) {
        // a click: Shift toggles the pole, a plain click on a pole of a larger selection keeps just that pole
        const net = useNurbsNetStore.getState();
        if (commit && held.toggle) net.setSelected(togglePole(net.selected, held.pole));
        else if (commit && net.selected.length > 1) net.setSelected([held.pole]);
        return;
      }
      if (commit) {
        // the last frame may not have run: apply the final pointer position before committing
        const delta = translateDelta(held, rayAt(last.x, last.y), finalLock);
        const target = entityRef.current;
        if (delta !== null && target !== undefined) updatePoleDrag(target.id, held.pole, delta);
        commitPoleDrag();
      } else cancelPoleDrag();
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (box !== null) endBox(event.button === 0);
      else end(event.button === 0);
    };
    const onPointerCancel = (): void => {
      endBox(false);
      end(false);
    };
    const onLostCapture = (): void => {
      if (box?.active === true) endBox(false);
      if (press?.active === true) end(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      if (key === 'escape' && box?.active === true) {
        event.preventDefault();
        event.stopPropagation();
        endBox(false);
        return;
      }
      if (press?.active !== true) return;
      if (key === 'escape') {
        event.preventDefault();
        event.stopPropagation();
        end(false);
      } else if (key === 'x' || key === 'y' || key === 'z') {
        event.preventDefault();
        event.stopPropagation();
        lock = key;
      }
    };
    const onClick = (event: MouseEvent): void => {
      if (swallowClick || useNurbsNetStore.getState().hover !== null) event.stopPropagation();
      swallowClick = false;
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
      useNurbsNetStore.getState().setMarquee(null);
      if (press?.active === true) cancelPoleDrag();
    };
  }, [gl, camera]);
}
