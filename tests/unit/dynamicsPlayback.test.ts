import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyFrameAt, carryEntity, createBodyFrame, sampleAt, type DynamicsPoses } from '@ui/viewport/3d/dynamicsPose';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import type { SimulationData } from '@core/dynamics/simulationReport';

/** A body spinning about +Z through [10, 0, 0] by 90° per sample (quaternion [w, x, y, z]). */
const spin: DynamicsPoses = {
  times: [0, 1, 2],
  bodies: {
    rotor: {
      position: [
        [10, 0, 0],
        [10, 0, 0],
        [10, 0, 2],
      ],
      orientation: [
        [1, 0, 0, 0],
        [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        [0, 0, 0, 1],
      ],
    },
  },
};

describe('dynamicsPose', () => {
  it('sampleAt finds the bracketing sample and the blend, clamped at both ends', () => {
    expect(sampleAt([0, 1, 2], -1)).toEqual({ index: 0, blend: 0 });
    expect(sampleAt([0, 1, 2], 1.25)).toEqual({ index: 1, blend: 0.25 });
    expect(sampleAt([0, 1, 2], 5)).toEqual({ index: 1, blend: 1 });
    expect(sampleAt([0], 3)).toEqual({ index: 0, blend: 0 });
  });

  it('carries a member entity rigidly about the body centre (half a sample = 45°)', () => {
    const frame = createBodyFrame();
    expect(bodyFrameAt(spin, 'rotor', 0.5, frame)).toBe(true);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    // an entity 5 units out along +X from the body centre
    carryEntity(frame, [15, 0, 0], [0, 0, 0], position, quaternion);
    expect(position.x).toBeCloseTo(10 + 5 * Math.SQRT1_2, 9);
    expect(position.y).toBeCloseTo(5 * Math.SQRT1_2, 9);
    expect(new THREE.Euler().setFromQuaternion(quaternion).z).toBeCloseTo(Math.PI / 4, 9);
  });

  it('follows the centre of mass and composes with the entity rotation', () => {
    const frame = createBodyFrame();
    bodyFrameAt(spin, 'rotor', 2, frame);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    carryEntity(frame, [10, 0, 0], [Math.PI / 2, 0, 0], position, quaternion);
    expect(position.toArray()).toEqual([10, 0, 2]);
    const expected = new THREE.Quaternion(0, 0, 1, 0).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
    expect(quaternion.angleTo(expected)).toBeLessThan(1e-9);
    expect(bodyFrameAt(spin, 'missing', 0, frame)).toBe(false);
  });
});

describe('dynamicsPlaybackStore', () => {
  const result = { duration: 2 } as SimulationData;
  beforeEach(() => useDynamicsPlaybackStore.setState({ result: null, time: 0, playing: false, speed: 1, loop: true }));

  it('remembers the document state a result came from, and forgets it with the result', () => {
    const source = { dynamics: {}, entities: {} };
    useDynamicsPlaybackStore.getState().setResult(result, source);
    expect(useDynamicsPlaybackStore.getState().source).toBe(source);
    useDynamicsPlaybackStore.getState().setResult(null, source);
    expect(useDynamicsPlaybackStore.getState().source).toBeNull();
  });

  it('starts playing a new result from 0 and clamps seeks to the run', () => {
    useDynamicsPlaybackStore.getState().setResult(result);
    expect(useDynamicsPlaybackStore.getState()).toMatchObject({ time: 0, playing: true });
    useDynamicsPlaybackStore.getState().setTime(9);
    expect(useDynamicsPlaybackStore.getState().time).toBe(2);
  });

  it('advances at the playback speed, loops, or stops at the end', () => {
    const store = useDynamicsPlaybackStore.getState();
    store.setResult(result);
    store.setSpeed(0.5);
    useDynamicsPlaybackStore.getState().advance(1);
    expect(useDynamicsPlaybackStore.getState().time).toBeCloseTo(0.5, 12);
    useDynamicsPlaybackStore.getState().advance(4);
    expect(useDynamicsPlaybackStore.getState().time).toBeCloseTo(0.5, 12);
    useDynamicsPlaybackStore.getState().setLoop(false);
    useDynamicsPlaybackStore.getState().advance(10);
    expect(useDynamicsPlaybackStore.getState()).toMatchObject({ time: 2, playing: false });
    useDynamicsPlaybackStore.getState().advance(1);
    expect(useDynamicsPlaybackStore.getState().time).toBe(2);
  });
});
