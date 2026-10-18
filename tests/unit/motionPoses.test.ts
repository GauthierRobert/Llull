/** Pose interpolation, motion detection and relative transforms of the motion-clearance check. */
import { describe, expect, it } from 'vitest';
import { posesAtSample } from '@core/dynamics/bodyPose';
import { STATIC_POSE, isMoving, poseAt, relativeTransform, travelBound, type PoseTrack } from '@core/dynamics/motionPoses';
import type { Quaternion } from '@core/dynamics/physicsEngine';

const IDENTITY: Quaternion = [1, 0, 0, 0];
const QUARTER_Z: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const track = (positions: Array<[number, number, number]>, orientations: Quaternion[]): PoseTrack => ({
  position: positions,
  orientation: orientations,
});

describe('poseAt', () => {
  const moving = track(
    [
      [0, 0, 0],
      [10, 0, 0],
    ],
    [IDENTITY, QUARTER_Z],
  );

  it('returns the sample itself at fraction 0 and at the last index', () => {
    expect(poseAt(moving, 0, 0).position).toEqual([0, 0, 0]);
    expect(poseAt(moving, 1, 0.5).position).toEqual([10, 0, 0]);
    expect(poseAt(moving, 1, 0.5).orientation).toEqual(QUARTER_Z);
  });

  it('lerps the centre of mass and slerps the orientation between samples', () => {
    const mid = poseAt(moving, 0, 0.5);
    expect(mid.position).toEqual([5, 0, 0]);
    expect(mid.orientation[0]).toBeCloseTo(Math.cos(Math.PI / 8), 9);
    expect(mid.orientation[3]).toBeCloseTo(Math.sin(Math.PI / 8), 9);
  });

  it('takes the short way round for antipodal quaternions', () => {
    const flipped = track(
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
      [IDENTITY, [-1, 0, 0, 0]],
    );
    expect(Math.abs(poseAt(flipped, 0, 0.5).orientation[0])).toBeCloseTo(1, 9);
  });

  it('survives identical quaternions (no division by a zero sine)', () => {
    const same = track(
      [
        [0, 0, 0],
        [1, 1, 1],
      ],
      [QUARTER_Z, QUARTER_Z],
    );
    expect(poseAt(same, 0, 0.3).orientation[3]).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('falls back to the start for an empty track', () => {
    expect(poseAt({ position: [], orientation: [] }, 3, 0.5)).toEqual({ start: [0, 0, 0], position: [0, 0, 0], orientation: IDENTITY });
  });
});

describe('isMoving and travelBound', () => {
  it('detects translation, rotation-only motion and rest', () => {
    expect(isMoving({ position: [], orientation: [] })).toBe(false);
    expect(
      isMoving(
        track(
          [
            [0, 0, 0],
            [0, 0, 0],
          ],
          [IDENTITY, IDENTITY],
        ),
      ),
    ).toBe(false);
    expect(
      isMoving(
        track(
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          [IDENTITY, IDENTITY],
        ),
      ),
    ).toBe(true);
    expect(
      isMoving(
        track(
          [
            [0, 0, 0],
            [0, 0, 0],
          ],
          [IDENTITY, QUARTER_Z],
        ),
      ),
    ).toBe(true);
  });

  it('bounds the travel by centre-of-mass distance plus angle times radius, and is 0 out of range', () => {
    const t = track(
      [
        [0, 0, 0],
        [3, 4, 0],
      ],
      [IDENTITY, QUARTER_Z],
    );
    expect(travelBound(t, 0, 2)).toBeCloseTo(5 + (Math.PI / 2) * 2, 9);
    expect(travelBound(t, 1, 2)).toBe(0);
    expect(travelBound(t, 7, 2)).toBe(0);
  });
});

describe('relativeTransform', () => {
  it('is the identity for two static parts and a translation for a translated one', () => {
    expect(relativeTransform(STATIC_POSE, STATIC_POSE)).toEqual({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] });
    const moved = { start: [0, 0, 0] as [number, number, number], position: [2, 0, 0] as [number, number, number], orientation: IDENTITY };
    expect(relativeTransform(STATIC_POSE, moved).translation).toEqual([2, 0, 0]);
  });
});

describe('posesAtSample', () => {
  it('leaves out bodies that lack the sample', () => {
    const poses = {
      bodies: {
        full: {
          position: [
            [0, 0, 0],
            [1, 0, 0],
          ] as Array<[number, number, number]>,
          orientation: [IDENTITY, IDENTITY],
        },
        short: { position: [[0, 0, 0]] as Array<[number, number, number]>, orientation: [IDENTITY] },
      },
    };
    expect(Object.keys(posesAtSample(poses, 1))).toEqual(['full']);
    expect(Object.keys(posesAtSample(poses, 0)).sort()).toEqual(['full', 'short']);
  });
});
