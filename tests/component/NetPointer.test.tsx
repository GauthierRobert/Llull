// 04 DIR M-UI: pole selection by pointer (useNetPointer) with captured listeners on a jsdom host: click, Shift-click toggle, collapse of a multi-selection by a
// plain click, Ctrl-drag box selection (the marquee is shown while dragging and cleared), and Shift-drag on empty space staying with the camera.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import type { NurbsCurveEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { useNetPointer } from '@ui/viewport/3d/nurbsNet/useNetPointer';

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

const made = execute(createEmptyDocument(), 'create_nurbs_curve', {
  degree: 2,
  poles: [
    [-4, 0, 0],
    [0, 3, 0],
    [4, 0, 0],
  ],
});
const curve = made.document.entities[made.affected[0] as string] as NurbsCurveEntity;

/** Client pixel of the pole `index` as the camera sees it. */
function screenOf(index: number): { x: number; y: number } {
  const [px, py, pz] = curve.curve.poles[index] as [number, number, number];
  const v = new THREE.Vector3(px, py, pz).project(camera);
  return { x: ((v.x + 1) / 2) * 800, y: ((1 - v.y) / 2) * 600 };
}

function fire(target: EventTarget, type: string, at: { x: number; y: number }, init: MouseEventInit = {}): void {
  const event = new MouseEvent(type, { clientX: at.x, clientY: at.y, button: 0, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}
const press = (at: { x: number; y: number }, init: MouseEventInit = {}): void => fire(canvas, 'pointerdown', at, init);
const move = (at: { x: number; y: number }, init: MouseEventInit = {}): void => fire(window, 'pointermove', at, init);
const release = (at: { x: number; y: number }, init: MouseEventInit = {}): void => fire(window, 'pointerup', at, init);
const selected = (): unknown[] => [...useNurbsNetStore.getState().selected];

describe('useNetPointer selection', () => {
  beforeEach(() => {
    useNurbsNetStore.setState({ visible: true, selected: [], marquee: null, drag: null, hover: null });
    renderHook(() => useNetPointer(curve));
  });
  afterEach(cleanup);

  it('a click selects a pole; Shift-click adds and removes; a plain click on a pole of a larger selection keeps just that pole', () => {
    const [a, b] = [screenOf(0), screenOf(2)];
    press(a);
    release(a);
    expect(selected()).toEqual([0]);
    press(b, { shiftKey: true });
    release(b, { shiftKey: true });
    expect(selected()).toEqual([0, 2]);
    press(b, { shiftKey: true });
    release(b, { shiftKey: true });
    expect(selected()).toEqual([0]);
    useNurbsNetStore.getState().setSelected([0, 1, 2]);
    press(b);
    release(b);
    expect(selected()).toEqual([2]);
  });

  it('Ctrl-drag on empty space shows the marquee and selects the poles inside it, added to the selection; the marquee is gone afterwards', () => {
    const [p0, p1] = [screenOf(0), screenOf(1)];
    useNurbsNetStore.getState().setSelected([2]);
    const from = { x: p0.x - 30, y: p1.y - 30 };
    const to = { x: p1.x + 30, y: p0.y + 30 };
    press(from, { ctrlKey: true });
    move({ x: from.x + 40, y: from.y + 40 }, { ctrlKey: true });
    expect(useNurbsNetStore.getState().marquee).not.toBeNull();
    move(to, { ctrlKey: true });
    release(to, { ctrlKey: true });
    expect(useNurbsNetStore.getState().marquee).toBeNull();
    expect(selected().sort()).toEqual([0, 1, 2]);
  });

  it('Shift-drag on empty space is left to the camera: no marquee, no selection change', () => {
    const empty = { x: 400, y: 560 };
    useNurbsNetStore.getState().setSelected([1]);
    press(empty, { shiftKey: true });
    move({ x: 460, y: 500 }, { shiftKey: true });
    expect(useNurbsNetStore.getState().marquee).toBeNull();
    release({ x: 460, y: 500 }, { shiftKey: true });
    expect(selected()).toEqual([1]);
  });
});
