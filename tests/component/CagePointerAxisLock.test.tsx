// 04 DIR: the axis-lock keys of a cage vertex drag (useCagePointer). X / Y / Z lock the drag to that world axis AT ONCE (the gesture is recomputed at the last
// pointer position, no further move needed), pressing the same key again releases the lock, and the release commits ONE command with the locked delta.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { type SubdivisionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { useCagePointer } from '@ui/viewport/3d/cage/useCagePointer';
import { resetOfflineStore } from '../helpers/storeTestHelpers';

const host = document.createElement('div');
const canvas = document.createElement('canvas');
host.appendChild(canvas);
document.body.appendChild(host);
Object.defineProperty(canvas, 'getBoundingClientRect', {
  value: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
});
Object.defineProperty(canvas, 'clientHeight', { value: 600 });
const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 1000);
camera.position.set(0, 0, 20);
camera.updateMatrixWorld();
camera.updateProjectionMatrix();

vi.mock('@react-three/fiber', () => ({
  useThree: (select: (state: unknown) => unknown) => select({ gl: { domElement: canvas }, camera }),
}));

type Point = { x: number; y: number };

function fire(target: EventTarget, type: string, at: Point): void {
  const event = new MouseEvent(type, { clientX: at.x, clientY: at.y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}
const key = (name: string): void => void window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));

/** Client pixel of a world point as the camera sees it. */
function screenOf(p: readonly [number, number, number]): Point {
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
  return { x: ((v.x + 1) / 2) * 800, y: ((1 - v.y) / 2) * 600 };
}

function setup(): { id: string; vertex: number; start: Point } {
  resetOfflineStore();
  const made = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2], segments: [1, 1, 1] }, levels: 1 });
  const id = made.affected[0] as string;
  useStore.getState().setDocument(made.document);
  useStore.setState({ liveStatus: 'disconnected' });
  const cage = made.document.entities[id] as SubdivisionEntity;
  // the corner (1, 1, 1) faces the camera on +Z
  const vertex = cage.vertices.findIndex((v) => v[0] === 1 && v[1] === 1 && v[2] === 1);
  expect(vertex).toBeGreaterThanOrEqual(0);
  useDirectEditStore.getState().enter(id);
  return { id, vertex, start: screenOf([1, 1, 1]) };
}

const cageOf = (id: string): SubdivisionEntity => useStore.getState().document.entities[id] as SubdivisionEntity;
const translation = (): readonly number[] => {
  const gesture = useDirectEditStore.getState().gesture;
  return gesture?.kind === 'translate' ? gesture.delta : [];
};

describe('useCagePointer axis lock', () => {
  let scene: { id: string; vertex: number; start: Point };
  beforeEach(() => {
    scene = setup();
    renderHook(() => useCagePointer(cageOf(scene.id)));
  });
  afterEach(cleanup);

  it('X locks the drag to the x axis without another pointer move; X again releases it; the release commits the locked delta', () => {
    const { id, vertex, start } = scene;
    const before = cageOf(id).vertices[vertex] as [number, number, number];
    fire(canvas, 'pointerdown', start);
    const to = { x: start.x + 60, y: start.y - 40 };
    fire(window, 'pointermove', { x: start.x + 20, y: start.y - 10 });
    fire(window, 'pointermove', to);
    const free = translation();
    expect(Math.abs(free[0] as number)).toBeGreaterThan(0);
    expect(Math.abs(free[1] as number)).toBeGreaterThan(0);

    key('x');
    const locked = translation();
    expect(locked[0]).toBeCloseTo(free[0] as number, 6);
    expect(locked[1]).toBe(0);
    expect(locked[2]).toBe(0);

    key('y');
    const other = translation();
    expect(other[0]).toBe(0);
    expect(other[1]).toBeCloseTo(free[1] as number, 6);

    key('y');
    expect(translation()).toEqual(free);

    key('x');
    fire(window, 'pointerup', to);
    const after = cageOf(id).vertices[vertex] as [number, number, number];
    expect(after[0]).toBeCloseTo(before[0] + (free[0] as number), 5);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(after[2]).toBeCloseTo(before[2], 9);
    expect(useDirectEditStore.getState().gesture).toBeNull();
  });

  it('a key pressed before the drag has moved, or with no drag, changes nothing', () => {
    const { id, start } = scene;
    const entity = cageOf(id);
    key('x');
    expect(useDirectEditStore.getState().gesture).toBeNull();
    fire(canvas, 'pointerdown', start);
    key('x');
    expect(useDirectEditStore.getState().gesture).toBeNull();
    fire(window, 'pointerup', start);
    expect(cageOf(id).vertices).toEqual(entity.vertices);
  });
});
