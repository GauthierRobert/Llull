// In-Canvas walk / fly camera (UI-only: the document is never touched). The eye is kept in WORLD space (camera position + renderOrigin), so
// the floating origin may rebase under it; the orbit target is parked ahead of the eye each frame, which keeps RenderOriginSyncer,
// AdaptiveClipping and the hand-back to orbit working. Orbit never writes the camera into the document, and neither does this.

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { fromMm } from '@core/model/units';
import { useStore } from '@ui/store';
import { useNavigationStore } from '@ui/store/navigationStore';
import { mergedEntityBounds } from '../fitBounds';
import {
  EYE_HEIGHT_MM,
  type LookAngles,
  NAVIGATION_KEY_CODES,
  anglesOfDirection,
  applyMouseLook,
  inputFromKeys,
  lookDirection,
  navigationSpeed,
  stepNavigation,
} from './navigationMath';

/** Walking pace of an empty document, in millimetres per second. */
const FALLBACK_SPEED_MM = 1400;
/** The orbit target is parked this many seconds of travel ahead of the eye. */
const TARGET_LEAD_SECONDS = 2;
/** A frame after an idle spell must not teleport the eye. */
const MAX_FRAME_SECONDS = 0.1;
const FLOOR_Z = 0;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function modelSpeed(): number {
  const document = useStore.getState().document;
  const bounds = mergedEntityBounds(document, document.order);
  const diagonal =
    bounds === null ? null : Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  return navigationSpeed(diagonal, fromMm(document, FALLBACK_SPEED_MM));
}

export function NavigationController(): null {
  const mode = useNavigationStore((s) => s.mode);
  const setMode = useNavigationStore((s) => s.setMode);
  const { camera, controls, gl, invalidate } = useThree();
  const angles = useRef<LookAngles>({ yaw: 0, pitch: 0 });
  const held = useRef(new Set<string>());
  const speed = useRef(1);
  const eyeHeight = useRef(1.6);

  useEffect(() => {
    if (mode === 'orbit') return;
    const dom = gl.domElement;
    const direction = camera.getWorldDirection(camera.position.clone());
    angles.current = anglesOfDirection([direction.x, direction.y, direction.z]);
    speed.current = modelSpeed();
    eyeHeight.current = fromMm(useStore.getState().document, EYE_HEIGHT_MM);
    held.current.clear();
    camera.up.set(0, 0, 1);
    let locked = false;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;
      if (event.code === 'Escape') {
        event.stopPropagation();
        setMode('orbit');
        return;
      }
      if (!NAVIGATION_KEY_CODES.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      held.current.add(event.code);
      invalidate();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      held.current.delete(event.code);
    };
    const onBlur = (): void => held.current.clear();
    const onMouseMove = (event: MouseEvent): void => {
      if (document.pointerLockElement !== dom && event.buttons !== 1) return;
      angles.current = applyMouseLook(angles.current, event.movementX, event.movementY);
      invalidate();
    };
    const onPointerDown = (): void => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock?.();
    };
    const onLockChange = (): void => {
      if (document.pointerLockElement === dom) locked = true;
      else if (locked) setMode('orbit');
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    dom.addEventListener('mousemove', onMouseMove);
    dom.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerlockchange', onLockChange);
    invalidate();
    const heldKeys = held.current;
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      dom.removeEventListener('mousemove', onMouseMove);
      dom.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerlockchange', onLockChange);
      heldKeys.clear();
      if (document.pointerLockElement === dom) document.exitPointerLock();
      (controls as OrbitControlsImpl | null)?.update();
      invalidate();
    };
  }, [mode, camera, controls, gl, invalidate, setMode]);

  useFrame((state, delta) => {
    if (mode === 'orbit') return;
    const orbit = controls as OrbitControlsImpl | null;
    const origin = useStore.getState().renderOrigin;
    const eye = stepNavigation(
      [camera.position.x + origin[0], camera.position.y + origin[1], camera.position.z + origin[2]],
      angles.current,
      inputFromKeys(held.current),
      Math.min(delta, MAX_FRAME_SECONDS),
      { mode, speed: speed.current, eyeZ: FLOOR_Z + eyeHeight.current },
    );
    const forward = lookDirection(angles.current);
    const lead = speed.current * TARGET_LEAD_SECONDS;
    camera.position.set(eye[0] - origin[0], eye[1] - origin[1], eye[2] - origin[2]);
    camera.up.set(0, 0, 1);
    camera.lookAt(camera.position.x + forward[0], camera.position.y + forward[1], camera.position.z + forward[2]);
    orbit?.target.set(camera.position.x + forward[0] * lead, camera.position.y + forward[1] * lead, camera.position.z + forward[2] * lead);
    state.invalidate();
  });

  return null;
}
