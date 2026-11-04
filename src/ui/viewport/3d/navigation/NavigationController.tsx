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
  type WalkBody,
  type WalkOptions,
  type WalkWorld,
  type LookAngles,
  NAVIGATION_KEY_CODES,
  anglesOfDirection,
  applyMouseLook,
  inputFromKeys,
  lookDirection,
  dropOntoFloor,
  navigationSpeed,
  stepNavigation,
  stepWalk,
} from './navigationMath';
import { createSceneWalkWorld } from './sceneWalkWorld';

/** Walking pace of an empty document, in millimetres per second. */
const FALLBACK_SPEED_MM = 1400;
/** The orbit target is parked this many seconds of travel ahead of the eye. */
const TARGET_LEAD_SECONDS = 2;
/** A frame after an idle spell must not teleport the eye. */
const MAX_FRAME_SECONDS = 0.1;
/** The ground plane the walker falls to when the scene has nothing below the feet. */
const FLOOR_Z = 0;
const RADIUS_MM = 250;
/** Highest riser walked onto (stairs); taller is a wall. */
const STEP_HEIGHT_MM = 400;
const GRAVITY_MM = 9810;
const TERMINAL_SPEED_MM = 50000;
/** Name of the group the walker probes (Viewport3D wraps the entities in it). */
export const WALKABLE_GROUP_NAME = 'walkable-scene';

const OPEN_WORLD: WalkWorld = { floorBelow: () => null, wallAhead: () => null };

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
  const { camera, controls, gl, invalidate, scene } = useThree();
  const angles = useRef<LookAngles>({ yaw: 0, pitch: 0 });
  const held = useRef(new Set<string>());
  const speed = useRef(1);
  const walkOptions = useRef<WalkOptions | null>(null);
  const walkWorld = useRef<WalkWorld>(OPEN_WORLD);
  const body = useRef<WalkBody | null>(null);

  useEffect(() => {
    if (mode === 'orbit') return;
    const dom = gl.domElement;
    const direction = camera.getWorldDirection(camera.position.clone());
    angles.current = anglesOfDirection([direction.x, direction.y, direction.z]);
    speed.current = modelSpeed();
    const doc = useStore.getState().document;
    walkOptions.current = {
      speed: speed.current,
      eyeHeight: fromMm(doc, EYE_HEIGHT_MM),
      radius: fromMm(doc, RADIUS_MM),
      stepHeight: fromMm(doc, STEP_HEIGHT_MM),
      gravity: fromMm(doc, GRAVITY_MM),
      terminalSpeed: fromMm(doc, TERMINAL_SPEED_MM),
      baseFloor: FLOOR_Z,
    };
    const walkable = scene.getObjectByName(WALKABLE_GROUP_NAME);
    walkWorld.current = walkable ? createSceneWalkWorld(walkable, () => useStore.getState().renderOrigin) : OPEN_WORLD;
    const origin = useStore.getState().renderOrigin;
    body.current =
      mode === 'walk'
        ? dropOntoFloor(
            [camera.position.x + origin[0], camera.position.y + origin[1], camera.position.z + origin[2]],
            walkWorld.current,
            FLOOR_Z,
          )
        : null;
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
  }, [mode, camera, controls, gl, invalidate, setMode, scene]);

  useFrame((state, delta) => {
    if (mode === 'orbit') return;
    const orbit = controls as OrbitControlsImpl | null;
    const origin = useStore.getState().renderOrigin;
    const input = inputFromKeys(held.current);
    const dt = Math.min(delta, MAX_FRAME_SECONDS);
    const options = walkOptions.current;
    let eye: [number, number, number];
    if (mode === 'walk') {
      if (options === null || body.current === null) return;
      body.current = stepWalk(body.current, angles.current, input, dt, { ...options, speed: speed.current }, walkWorld.current);
      const [x, y, z] = body.current.feet;
      eye = [x, y, z + options.eyeHeight];
    } else {
      eye = stepNavigation(
        [camera.position.x + origin[0], camera.position.y + origin[1], camera.position.z + origin[2]],
        angles.current,
        input,
        dt,
        speed.current,
      );
    }
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
