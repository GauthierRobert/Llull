// 04 DIR M1: the axis-lock keys of a face "move feature" drag (useFacePointer). X / Y / Z lock the displacement to that world axis AT ONCE (recomputed at the last
// pointer position, no further move needed) and pressing the same key again releases the lock. Other operations ignore the keys.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { createEmptyDocument } from '@core/model/types';
import type { Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import { useFacePointer } from '@ui/viewport/3d/faceEdit/useFacePointer';

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
const key = (name: string): void => void window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

function screenOf(p: readonly [number, number, number]): Point {
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
  return { x: ((v.x + 1) / 2) * 800, y: ((1 - v.y) / 2) * 600 };
}

const vector = (): readonly number[] => useFaceEditStore.getState().vector ?? [];

describe('useFacePointer axis lock (move feature)', () => {
  let entity: Entity;
  let start: Point;
  beforeEach(() => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4], anchor: 'center' });
    entity = made.document.entities[made.affected[0] as string] as Entity;
    start = screenOf([0.5, 0.5, 2]);
    renderHook(() => useFacePointer(entity));
    useFaceEditStore.getState().start();
    useFaceEditStore.getState().setOp('move_feature');
    // the first press picks the top face, the second grabs it
    fire(canvas, 'pointerdown', start);
    expect(useFaceEditStore.getState().pick).not.toBeNull();
  });
  afterEach(() => {
    cleanup();
    useFaceEditStore.getState().stop();
  });

  it('X locks the displacement to x without another pointer move; Y switches; Y again releases', () => {
    fire(canvas, 'pointerdown', start);
    fire(window, 'pointermove', { x: start.x + 20, y: start.y - 10 });
    const to = { x: start.x + 60, y: start.y - 40 };
    fire(window, 'pointermove', to);
    const free = vector();
    expect(Math.abs(free[0] as number)).toBeGreaterThan(0);
    expect(Math.abs(free[1] as number)).toBeGreaterThan(0);

    key('x');
    const locked = vector();
    expect(locked[0]).toBeCloseTo(free[0] as number, 6);
    expect(locked[1]).toBeCloseTo(0, 9);
    expect(locked[2]).toBeCloseTo(0, 9);

    key('y');
    expect(vector()[0]).toBeCloseTo(0, 9);
    expect(vector()[1]).toBeCloseTo(free[1] as number, 6);

    key('y');
    expect(vector()).toEqual(free);
    fire(window, 'pointerup', to);
  });

  it('a draft or push-pull drag ignores the keys', () => {
    useFaceEditStore.getState().setOp('push_pull');
    fire(canvas, 'pointerdown', start);
    fire(window, 'pointermove', { x: start.x + 40, y: start.y - 30 });
    const before = useFaceEditStore.getState().value;
    key('x');
    expect(useFaceEditStore.getState().value).toBe(before);
    expect(useFaceEditStore.getState().vector).toBeNull();
    fire(window, 'pointerup', start);
  });
});
