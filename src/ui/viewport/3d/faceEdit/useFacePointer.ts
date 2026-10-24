// Pointer input of face edit mode: a press on a face picks it (and shows its handle), a press-drag on the handle or the picked face moves it
// along the normal. Capture-phase listeners on the canvas container run before OrbitControls; a press that hits nothing is left to the camera.
// The pointer is captured for the drag, so a release outside the canvas still ends it; losing the capture cancels it. Outcomes are store updates
// and ONE dispatched command (commitFaceDrag) -- never a document edit.

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import type { Entity, Vec3 } from '@core/model/types';
import { VIEWPORT_FOV_DEGREES } from '@core/model/viewport';
import { unitsPerPixel } from '../cage/dragMath';
import { createFrameScheduler } from '../cage/frameScheduler';
import { capturePointer, releasePointer } from '../pointerCapture';
import { createWorldRay, type WorldRay } from '../worldRay';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import { cancelFaceDrag, commitFaceDrag, updateFaceDrag } from './faceEditActions';
import { dragStep, grabsHandle, HANDLE_GRAB_PX, HANDLE_PX, travelAlongAxis } from './faceDragMath';
import { type DragRules, dragValue, pickFaceAt, snapPlanes } from './facePicking';
import { pickableTriangles } from './faceTriangles';
import { distance3 } from '@lib/vec3';

const DRAG_THRESHOLD_PX = 3;
/** Pixels within which a dragged length snaps to another face's plane. */
const PLANE_SNAP_PX = 12;

interface Press {
  readonly ray: WorldRay;
  readonly pointerId: number;
  readonly target: EventTarget | null;
  readonly x: number;
  readonly y: number;
  readonly rules: DragRules;
  active: boolean;
}

export function useFacePointer(entity: Entity | undefined): void {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const entityRef = useRef(entity);
  entityRef.current = entity;

  useEffect(() => {
    const host = gl.domElement.parentElement;
    if (host === null) return undefined;
    const rayAt = createWorldRay(gl, camera);
    let press: Press | null = null;
    const hoverFrame = createFrameScheduler(
      (cb) => window.requestAnimationFrame(cb),
      (handle) => window.cancelAnimationFrame(handle),
    );

    const perPixel = (at: Vec3, ray: WorldRay): number =>
      unitsPerPixel(distance3(at, ray.origin), VIEWPORT_FOV_DEGREES, gl.domElement.clientHeight);

    const onPointerDown = (event: PointerEvent): void => {
      const target = entityRef.current;
      const edit = useFaceEditStore.getState();
      if (target === undefined || !edit.active || event.button !== 0) return;
      const ray = rayAt(event.clientX, event.clientY);
      const source = pickableTriangles(target);
      const consume = (): void => {
        event.stopPropagation();
        event.preventDefault();
      };
      const picked = edit.pick;
      if (picked !== null && edit.entityId === target.id) {
        const unit = perPixel(picked.point, ray);
        const onHandle = grabsHandle(ray, picked.point, picked.normal, HANDLE_PX * unit, HANDLE_GRAB_PX * unit);
        const onFace = !onHandle && pickFaceAt(source, ray)?.region.some((index) => edit.region.includes(index)) === true;
        if (onHandle || onFace) {
          press = {
            ray,
            pointerId: event.pointerId,
            target: event.target,
            x: event.clientX,
            y: event.clientY,
            rules: { op: edit.op, pick: picked, step: 0, planes: snapPlanes(source, picked), planeTolerance: PLANE_SNAP_PX * unit },
            active: false,
          };
          capturePointer(event.target, event.pointerId);
          consume();
          return;
        }
      }
      const hit = pickFaceAt(source, ray);
      if (hit === null) return;
      edit.setPick(target.id, hit.pick, hit.region);
      consume();
    };

    const onPointerMove = (event: PointerEvent): void => {
      const target = entityRef.current;
      const edit = useFaceEditStore.getState();
      if (target === undefined || !edit.active) return;
      if (press !== null) {
        if (!press.active && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD_PX) return;
        press.active = true;
        const { pick } = press.rules;
        const travel = travelAlongAxis(pick.point, pick.normal, press.ray, rayAt(event.clientX, event.clientY));
        if (travel === null) return;
        const step = dragStep(pickableTriangles(target).size, event.altKey);
        updateFaceDrag(dragValue({ ...press.rules, step }, travel));
        return;
      }
      const { clientX, clientY } = event;
      hoverFrame.schedule(() => {
        const current = entityRef.current;
        if (current === undefined) return;
        const hit = pickFaceAt(pickableTriangles(current), rayAt(clientX, clientY));
        useFaceEditStore.getState().setHover(hit === null ? null : { region: hit.region });
      });
    };

    const finish = (event: PointerEvent, commit: boolean): void => {
      const held = press;
      press = null;
      if (held === null) return;
      releasePointer(held.target, held.pointerId);
      if (!held.active) return;
      if (commit && event.button === 0) commitFaceDrag();
      else cancelFaceDrag();
    };
    const onPointerUp = (event: PointerEvent): void => finish(event, true);
    const onPointerCancel = (event: PointerEvent): void => finish(event, false);
    const onLostCapture = (): void => {
      if (press?.active === true) cancelFaceDrag();
      press = null;
    };

    // r3f's pointer-missed click would clear the entity selection (and so leave the mode); clicks belong to the handles here.
    const onClick = (event: MouseEvent): void => {
      if (useFaceEditStore.getState().active && entityRef.current !== undefined) event.stopPropagation();
    };

    // Escape (or any other cancel) ends the drag in the store: the held press must not resume it.
    const unsubscribe = useFaceEditStore.subscribe((state, previous) => {
      if (previous.value !== null && state.value === null && press?.active === true) {
        releasePointer(press.target, press.pointerId);
        press = null;
      }
    });

    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('click', onClick, true);
    host.addEventListener('lostpointercapture', onLostCapture, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('click', onClick, true);
      host.removeEventListener('lostpointercapture', onLostCapture, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      hoverFrame.cancel();
      unsubscribe();
      if (press?.active === true) cancelFaceDrag();
    };
  }, [gl, camera]);
}
