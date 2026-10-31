// Pointer input of cage edit mode: click selects elements, drag moves them in the view plane (Alt-drag a face extrudes), a click while
// the Ctrl-R tool is armed cuts a loop, and the modal inset follows the pointer. Capture-phase listeners on the canvas container run
// before OrbitControls / r3f; a press that hits no element is left alone so the camera still orbits. Every outcome is a store update
// or ONE dispatched command (commitGesture) -- never a document edit.

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { SubdivisionEntity } from '@core/model/types';
import { localRay, pickCage } from '@core/geometry/subd/pick';
import { VIEWPORT_FOV_DEGREES } from '@core/model/viewport';
import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { isAdditiveSelect } from '../../selectClick';
import {
  EMPTY_CAGE_SELECTION,
  type CageElement,
  elementOfPick,
  faceNormalWorld,
  hasElement,
  selectElement,
  selectElements,
  selectionCentroidWorld,
} from './cageSelection';
import {
  type AxisLock,
  type DragStart,
  type WorldRay,
  crossedThreshold,
  dragGesture,
  insetThickness,
  nextAxisLock,
  unitsPerPixel,
} from './dragMath';
import { cancelGesture, commitGesture, updateGesture } from './gestureActions';
import { capturePointer, releasePointer } from '../pointerCapture';
import { type LoopCutEdge, cancelsOnCaptureLoss, loopCutEdge, loopCutFactor } from './loopCutDrag';
import { loopEdgeIds, withoutOccluded } from './cagePickFilter';
import { createFrameScheduler } from './frameScheduler';

const PICK_PX = 9;
/** Smallest inset (in pixels) the modal tool shows; the core refuses a collapsing one and names the largest valid width. */
const MIN_INSET_PX = 2;

type Press =
  | { kind: 'drag'; start: DragStart; pointer: { x: number; y: number }; active: boolean }
  | { kind: 'loopcut'; edgeId: string; edge: LoopCutEdge; pointer: { x: number; y: number }; active: boolean }
  | { kind: 'background'; pointer: { x: number; y: number }; additive: boolean };

interface Modal {
  readonly startX: number;
  readonly startThickness: number;
  readonly perPixel: number;
}

export function useCagePointer(entity: SubdivisionEntity | undefined): void {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const entityRef = useRef(entity);
  entityRef.current = entity;

  useEffect(() => {
    const host = gl.domElement.parentElement;
    if (host === null) return undefined;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const forward = new THREE.Vector3();
    const lastPointer = { x: 0, y: 0 };
    let axisLock: AxisLock = null;
    let press: Press | null = null;
    // The pointer captured for the drag in flight: move / up keep arriving outside the canvas, and a lost capture cancels the drag.
    let captured: { target: EventTarget | null; id: number } | null = null;
    const holdPointer = (event: PointerEvent): void => {
      captured = { target: event.target, id: event.pointerId };
      capturePointer(event.target, event.pointerId);
    };
    const dropPointer = (): void => {
      if (captured !== null) releasePointer(captured.target, captured.id);
      captured = null;
    };
    let modal: Modal | null = null;
    const hoverFrame = createFrameScheduler(
      (cb) => window.requestAnimationFrame(cb),
      (handle) => window.cancelAnimationFrame(handle),
    );

    const worldRay = (clientX: number, clientY: number): WorldRay => {
      const rect = gl.domElement.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const origin = useStore.getState().renderOrigin;
      const { origin: o, direction: d } = raycaster.ray;
      return { origin: [o.x + origin[0], o.y + origin[1], o.z + origin[2]], direction: [d.x, d.y, d.z] };
    };

    const perPixel = (cage: SubdivisionEntity, ray: WorldRay): number => {
      const [cx, cy, cz] = cage.position;
      const distance = Math.hypot(cx - ray.origin[0], cy - ray.origin[1], cz - ray.origin[2]);
      return unitsPerPixel(distance, VIEWPORT_FOV_DEGREES, gl.domElement.clientHeight);
    };

    const pickAt = (cage: SubdivisionEntity, ray: WorldRay): ReturnType<typeof pickCage> => {
      const tolerance = PICK_PX * perPixel(cage, ray);
      return withoutOccluded(pickCage(cage, localRay(cage, ray), tolerance), tolerance * 2);
    };

    const onPointerDown = (event: PointerEvent): void => {
      const cage = entityRef.current;
      const edit = useDirectEditStore.getState();
      if (cage === undefined || edit.entityId !== cage.id || event.button !== 0) return;
      const ray = worldRay(event.clientX, event.clientY);
      const pointer = { x: event.clientX, y: event.clientY };
      const consume = (): void => {
        event.stopPropagation();
        event.preventDefault();
      };
      if (modal !== null) {
        modal = null;
        commitGesture();
        consume();
        return;
      }
      const pick = pickAt(cage, ray);
      if (edit.tool === 'loop_cut') {
        if (pick.edge === null) return;
        updateGesture({ kind: 'loop_cut', edge: pick.edge.id, cuts: edit.cuts, ...(edit.cuts === 1 ? { factor: 0.5 } : {}) });
        const edgeEnds = loopCutEdge(cage, pick.edge.id);
        if (edit.cuts === 1 && edgeEnds !== null) {
          // one loop: hold the press, the pointer slides it along the edge, the release commits
          press = { kind: 'loopcut', edgeId: pick.edge.id, edge: edgeEnds, pointer, active: false };
          holdPointer(event);
        } else commitGesture();
        consume();
        return;
      }
      if (event.altKey && pick.face !== null) {
        const face: CageElement = { kind: 'face', id: pick.face.id };
        edit.setSelection(hasElement(edit.selection, face) ? edit.selection : selectElement(EMPTY_CAGE_SELECTION, face, false));
        const origin = selectionCentroidWorld(cage, { ...EMPTY_CAGE_SELECTION, faces: [face.id] });
        const axis = faceNormalWorld(cage, face.id);
        if (origin !== null && axis !== null) {
          press = { kind: 'drag', start: { kind: 'extrude', ray, origin, axis }, pointer, active: false };
          holdPointer(event);
        }
        consume();
        return;
      }
      const additive = isAdditiveSelect(event);
      const element = elementOfPick(pick, edit.elementMode);
      if (element === null) {
        press = { kind: 'background', pointer, additive };
        return;
      }
      const selection =
        hasElement(edit.selection, element) && !additive ? edit.selection : selectElement(edit.selection, element, additive);
      edit.setSelection(selection);
      const origin = selectionCentroidWorld(cage, selection);
      camera.getWorldDirection(forward);
      if (origin !== null) {
        const start: DragStart = { kind: 'translate', ray, origin, axis: [forward.x, forward.y, forward.z] };
        press = { kind: 'drag', start, pointer, active: false };
        holdPointer(event);
      }
      consume();
    };

    const onPointerMove = (event: PointerEvent): void => {
      lastPointer.x = event.clientX;
      lastPointer.y = event.clientY;
      const cage = entityRef.current;
      const edit = useDirectEditStore.getState();
      if (cage === undefined || edit.entityId !== cage.id) return;
      if (modal !== null) {
        const minimum = modal.perPixel * MIN_INSET_PX;
        updateGesture({
          kind: 'inset',
          thickness: insetThickness(modal.startThickness, event.clientX - modal.startX, modal.perPixel, minimum),
        });
        return;
      }
      if (press?.kind === 'loopcut') {
        if (!press.active && !crossedThreshold(press.pointer, lastPointer)) return;
        press.active = true;
        const factor = loopCutFactor(press.edge, worldRay(event.clientX, event.clientY));
        if (factor !== null) updateGesture({ kind: 'loop_cut', edge: press.edgeId, cuts: 1, factor });
        return;
      }
      if (press?.kind === 'drag') {
        if (!press.active && !crossedThreshold(press.pointer, lastPointer)) return;
        press.active = true;
        const gesture = dragGesture(press.start, worldRay(event.clientX, event.clientY), axisLock);
        if (gesture !== null) updateGesture(gesture);
        return;
      }
      if (press !== null) return;
      const { clientX, clientY } = event;
      hoverFrame.schedule(() => {
        const current = entityRef.current;
        if (current === undefined) return;
        const pick = pickAt(current, worldRay(clientX, clientY));
        const state = useDirectEditStore.getState();
        const hover: CageElement | null =
          state.tool === 'loop_cut'
            ? pick.edge === null
              ? null
              : { kind: 'edge', id: pick.edge.id }
            : elementOfPick(pick, state.elementMode);
        state.setHover(hover);
      });
    };

    const onPointerUp = (event: PointerEvent): void => {
      const held = press;
      press = null;
      axisLock = null;
      dropPointer();
      if (held === null || event.button !== 0) return;
      if (held.kind === 'loopcut') {
        commitGesture();
        return;
      }
      if (held.kind === 'background') {
        if (!held.additive && !crossedThreshold(held.pointer, { x: event.clientX, y: event.clientY }))
          useDirectEditStore.getState().setSelection(EMPTY_CAGE_SELECTION);
        return;
      }
      if (held.active) commitGesture();
    };

    // r3f's pointer-missed click would clear the entity selection (and so leave edit mode); clicks belong to the cage tools here.
    const onClick = (event: MouseEvent): void => {
      const edit = useDirectEditStore.getState();
      if (edit.entityId !== null && entityRef.current?.id === edit.entityId) event.stopPropagation();
    };

    // Double-click an edge: its loop; Alt + double-click: its quad ring.
    const onDoubleClick = (event: MouseEvent): void => {
      const cage = entityRef.current;
      const edit = useDirectEditStore.getState();
      if (cage === undefined || edit.entityId !== cage.id || edit.tool !== 'select') return;
      const edge = pickAt(cage, worldRay(event.clientX, event.clientY)).edge;
      if (edge === null) return;
      const ids = loopEdgeIds(cage, edge.id, event.altKey);
      if (ids.length === 0) return;
      if (edit.elementMode !== 'edge') edit.setElementMode('edge');
      edit.setSelection(selectElements(EMPTY_CAGE_SELECTION, 'edge', ids, false));
      event.stopPropagation();
    };

    // The system took the pointer away (or the capture was lost mid-drag): the gesture ends with no command.
    const onCaptureLost = (): void => {
      const held = press;
      if (captured === null || held === null || held.kind === 'background') return;
      press = null;
      captured = null;
      // a loop-cut press sets its gesture (factor 0.5, ghost) on pointerdown, so it is dropped even before the pointer moved
      if (cancelsOnCaptureLoss(held)) cancelGesture();
    };

    const onKey = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      if ((key !== 'x' && key !== 'y' && key !== 'z') || press?.kind !== 'drag' || !press.active) return;
      axisLock = nextAxisLock(axisLock, key);
      // the preview follows the lock at once, not on the next pointer move
      const gesture = dragGesture(press.start, worldRay(lastPointer.x, lastPointer.y), axisLock);
      if (gesture !== null) updateGesture(gesture);
    };

    const unsubscribe = useDirectEditStore.subscribe((state, previous) => {
      if (state.gesture === null) {
        if (previous.gesture !== null) {
          press = null;
          modal = null;
          dropPointer();
        }
        return;
      }
      const cage = entityRef.current;
      if (state.gesture.kind === 'inset' && previous.gesture?.kind !== 'inset' && cage !== undefined) {
        const factor = perPixel(cage, worldRay(lastPointer.x, lastPointer.y));
        modal = { startX: lastPointer.x, startThickness: state.gesture.thickness, perPixel: factor > 0 ? factor : 0.01 };
      }
    });

    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('click', onClick, true);
    host.addEventListener('dblclick', onDoubleClick, true);
    host.addEventListener('lostpointercapture', onCaptureLost, true);
    window.addEventListener('pointercancel', onCaptureLost);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey);
    return () => {
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('click', onClick, true);
      host.removeEventListener('dblclick', onDoubleClick, true);
      host.removeEventListener('lostpointercapture', onCaptureLost, true);
      window.removeEventListener('pointercancel', onCaptureLost);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKey);
      unsubscribe();
      hoverFrame.cancel();
    };
  }, [gl, camera]);
}
