import { describe, expect, it } from 'vitest';
import {
  BOOST_FACTOR,
  MAX_PITCH,
  NO_INPUT,
  anglesOfDirection,
  applyMouseLook,
  clampPitch,
  inputFromKeys,
  lookDirection,
  navigationSpeed,
  cameraMovedExternally,
  dropOntoFloor,
  walkBaseFloor,
  stepNavigation,
  stepWalk,
  type WallHit,
  type WalkBody,
  type WalkOptions,
  type WalkWorld,
} from '@ui/viewport/3d/navigation/navigationMath';

const fly = 2;

describe('mouse look', () => {
  it('turns right and looks up with the pointer, and clamps the pitch short of the poles', () => {
    const turned = applyMouseLook({ yaw: 0, pitch: 0 }, 100, -50, 0.01);
    expect(turned.yaw).toBeCloseTo(1);
    expect(turned.pitch).toBeCloseTo(0.5);
    expect(applyMouseLook({ yaw: 0, pitch: 0 }, 0, -1e6).pitch).toBe(MAX_PITCH);
    expect(clampPitch(-10)).toBe(-MAX_PITCH);
  });
  it('wraps the yaw', () => {
    const { yaw } = applyMouseLook({ yaw: 3, pitch: 0 }, 100, 0, 0.01);
    expect(yaw).toBeLessThanOrEqual(Math.PI);
    expect(yaw).toBeCloseTo(4 - Math.PI * 2);
  });
  it('round-trips direction and angles', () => {
    const angles = { yaw: 0.7, pitch: -0.3 };
    const back = anglesOfDirection(lookDirection(angles));
    expect(back.yaw).toBeCloseTo(angles.yaw);
    expect(back.pitch).toBeCloseTo(angles.pitch);
    expect(anglesOfDirection([0, 0, 0])).toEqual({ yaw: 0, pitch: 0 });
    expect(lookDirection({ yaw: 0, pitch: 0 })).toEqual([0, 1, 0]);
  });
});

describe('speed scaling', () => {
  it('scales with the model diagonal, floors it, and falls back when there is no model', () => {
    expect(navigationSpeed(120, 1)).toBeCloseTo(10);
    expect(navigationSpeed(12000, 1)).toBeCloseTo(1000);
    expect(navigationSpeed(0.001, 1)).toBe(0.05);
    expect(navigationSpeed(null, 1.5)).toBe(1.5);
    expect(navigationSpeed(Number.NaN, 1.5)).toBe(1.5);
  });
});

describe('keys', () => {
  it('maps held keys to intent; opposing keys cancel', () => {
    expect(inputFromKeys(new Set(['KeyW', 'KeyD', 'ShiftLeft']))).toEqual({ forward: 1, strafe: 1, rise: 0, boost: true });
    expect(inputFromKeys(new Set(['KeyW', 'KeyS', 'KeyQ']))).toEqual({ forward: 0, strafe: 0, rise: -1, boost: false });
    expect(inputFromKeys(new Set())).toEqual(NO_INPUT);
  });
});

describe('step', () => {
  it('strafes to the right of the view', () => {
    const next = stepNavigation([0, 0, 0], { yaw: 0, pitch: 0 }, { ...NO_INPUT, strafe: 1 }, 1, fly);
    expect(next[0]).toBeCloseTo(2);
    expect(next[1]).toBeCloseTo(0);
  });
  it('flies along the view and rises along world Z', () => {
    const up = stepNavigation([0, 0, 0], { yaw: 0, pitch: Math.PI / 4 }, { ...NO_INPUT, forward: 1 }, 1, fly);
    expect(up[1]).toBeCloseTo(Math.SQRT2);
    expect(up[2]).toBeCloseTo(Math.SQRT2);
    expect(stepNavigation([0, 0, 0], { yaw: 0, pitch: 0 }, { ...NO_INPUT, rise: 1 }, 1, fly)[2]).toBeCloseTo(2);
  });
  it('does not speed up on diagonals, boosts with shift, and ignores a negative dt', () => {
    const diagonal = stepNavigation([0, 0, 0], { yaw: 0, pitch: 0 }, { ...NO_INPUT, forward: 1, strafe: 1 }, 1, fly);
    expect(Math.hypot(diagonal[0], diagonal[1])).toBeCloseTo(2);
    const boosted = stepNavigation([0, 0, 0], { yaw: 0, pitch: 0 }, { ...NO_INPUT, forward: 1, boost: true }, 1, fly);
    expect(boosted[1]).toBeCloseTo(2 * BOOST_FACTOR);
    expect(stepNavigation([1, 2, 3], { yaw: 0, pitch: 0 }, { ...NO_INPUT, forward: 1 }, -1, fly)).toEqual([1, 2, 3]);
  });
});

describe('walk: floor following, gravity, collision', () => {
  const options: WalkOptions = { speed: 2, eyeHeight: 1.6, radius: 0.3, stepHeight: 0.4, gravity: 10, terminalSpeed: 30, baseFloor: 0 };
  const forwardX = { yaw: Math.PI / 2, pitch: 0 };
  const ahead = { ...NO_INPUT, forward: 1 };
  const feetAt = (x: number, y: number, z: number, grounded = true): WalkBody => ({ feet: [x, y, z], velocityZ: 0, grounded });

  /** Analytic scene: `floor(x)` is the surface height (null = none) and `walls` are infinite planes x = X over [zMin, zMax]. */
  function world(
    floor: (x: number) => number | null,
    walls: readonly { x: number; zMin: number; zMax: number }[] = [],
    ceilings: readonly { fromX: number; z: number }[] = [],
  ): WalkWorld {
    return {
      ceilingAbove: (x, _y, fromZ, maxDistance) => {
        const hit = ceilings.filter((c) => x >= c.fromX && c.z >= fromZ && c.z - fromZ <= maxDistance).map((c) => c.z);
        return hit.length === 0 ? null : Math.min(...hit);
      },
      floorBelow: (x, _y, fromZ) => {
        const height = floor(x);
        return height !== null && height <= fromZ ? height : null;
      },
      wallAhead: (origin, dirX, _dirY, maxDistance) => {
        let best: WallHit | null = null;
        for (const wall of walls) {
          if (dirX === 0 || origin[2] < wall.zMin || origin[2] > wall.zMax) continue;
          const distance = (wall.x - origin[0]) / dirX;
          if (distance < 0 || distance > maxDistance || (best !== null && best.distance <= distance)) continue;
          best = { distance, normal: [dirX > 0 ? -1 : 1, 0] };
        }
        return best;
      },
    };
  }
  const run = (body: WalkBody, scene: WalkWorld, frames: number, dt = 1 / 60, input = ahead, opts = options): WalkBody => {
    let current = body;
    for (let frame = 0; frame < frames; frame += 1) current = stepWalk(current, forwardX, input, dt, opts, scene);
    return current;
  };

  it('stays on a flat floor and keeps the feet at its height', () => {
    const end = run(
      feetAt(0, 0, 2),
      world(() => 2),
      60,
    );
    expect(end.feet[0]).toBeCloseTo(2, 5);
    expect(end.feet[2]).toBe(2);
    expect(end.grounded).toBe(true);
  });

  it('steps up a riser lower than the step height and walks on at the new height', () => {
    const scene = world((x) => (x > 1 ? 0.3 : 0), [{ x: 1, zMin: 0, zMax: 0.3 }]);
    const end = run(feetAt(0, 0, 0), scene, 90);
    expect(end.feet[0]).toBeGreaterThan(1.5);
    expect(end.feet[2]).toBeCloseTo(0.3);
  });

  it('is stopped by a riser higher than the step height', () => {
    const scene = world((x) => (x > 1 ? 0.8 : 0), [{ x: 1, zMin: 0, zMax: 0.8 }]);
    const end = run(feetAt(0, 0, 0), scene, 120);
    expect(end.feet[0]).toBeLessThanOrEqual(1 - options.radius + 1e-6);
    expect(end.feet[2]).toBe(0);
  });

  it('falls under gravity off a ledge and lands on the lower floor', () => {
    const scene = world((x) => (x > 1 ? null : 2));
    const falling = run(feetAt(0, 0, 2), scene, 35);
    expect(falling.feet[0]).toBeGreaterThan(1);
    expect(falling.grounded).toBe(false);
    expect(falling.feet[2]).toBeLessThan(2);
    expect(falling.velocityZ).toBeLessThan(0);
    const landed = run(falling, scene, 300);
    expect(landed.grounded).toBe(true);
    expect(landed.feet[2]).toBe(0);
  });

  it('snaps down a stair but never exceeds the terminal speed in a long fall', () => {
    const down = run(
      feetAt(0, 0, 0.3),
      world(() => 0),
      1,
    );
    expect(down.grounded).toBe(true);
    expect(down.feet[2]).toBe(0);
    const longFall = stepWalk(
      { feet: [0, 0, 100], velocityZ: -1000, grounded: false },
      forwardX,
      NO_INPUT,
      1,
      options,
      world(() => null),
    );
    expect(longFall.velocityZ).toBe(-options.terminalSpeed);
    expect(longFall.velocityZ).toBeGreaterThanOrEqual(-options.terminalSpeed);
  });

  it('slides along a wall hit at an angle instead of stopping', () => {
    const scene = world(() => 0, [{ x: 1, zMin: 0, zMax: 3 }]);
    const diagonal = { yaw: Math.PI / 4, pitch: 0 };
    let body = feetAt(0, 0, 0);
    for (let frame = 0; frame < 120; frame += 1) body = stepWalk(body, diagonal, ahead, 1 / 60, options, scene);
    expect(body.feet[0]).toBeLessThanOrEqual(1 - options.radius + 1e-6);
    expect(body.feet[1]).toBeGreaterThan(2.5);
  });

  it('does not tunnel through a thin wall at boost speed with a long frame', () => {
    const scene = world(() => 0, [{ x: 3, zMin: 0, zMax: 3 }]);
    const fast = { ...options, speed: 60 };
    const end = run(feetAt(0, 0, 0), scene, 5, 0.1, { ...ahead, boost: true }, fast);
    expect(end.feet[0]).toBeLessThanOrEqual(3 - options.radius + 1e-6);
    expect(end.feet[0]).toBeGreaterThan(2);
  });

  it('drops a walker onto the floor below the eye, or the base floor when there is none', () => {
    expect(
      dropOntoFloor(
        [0, 0, 9],
        world(() => 4),
        0,
      ).feet[2],
    ).toBe(4);
    expect(
      dropOntoFloor(
        [0, 0, 9],
        world(() => null),
        -1,
      ).feet[2],
    ).toBe(-1);
  });

  it('does not teleport up to z = 0 when the whole scene is below it (floor at -5, stepping off its edge)', () => {
    const scene = world((x) => (x > 1 ? null : -5));
    const end = run(feetAt(0, 0, -5), scene, 120);
    expect(end.feet[0]).toBeGreaterThan(1.5);
    expect(end.feet[2]).toBeLessThanOrEqual(-5);
    expect(
      dropOntoFloor(
        [0, 0, -3],
        world(() => null),
        0,
      ).feet[2],
    ).toBe(-3);
  });

  it('takes the scene lowest point below z = 0 as the base floor', () => {
    expect(walkBaseFloor(-5)).toBe(-5);
    expect(walkBaseFloor(3)).toBe(0);
    expect(walkBaseFloor(null)).toBe(0);
    expect(walkBaseFloor(Number.NaN)).toBe(0);
  });

  it('refuses to walk (or step up) where less than the walker height of headroom is left', () => {
    const lowBeam = world(() => 0, [], [{ fromX: 1, z: 1.2 }]);
    const end = run(feetAt(0, 0, 0), lowBeam, 120);
    expect(end.feet[0]).toBeLessThan(1 + 1e-6);
    const stepUnderBeam = world((x) => (x > 1 ? 0.3 : 0), [{ x: 1, zMin: 0, zMax: 0.3 }], [{ fromX: 1, z: 1.7 }]);
    expect(run(feetAt(0, 0, 0), stepUnderBeam, 120).feet[0]).toBeLessThan(1 + 1e-6);
    const tallEnough = world(() => 0, [], [{ fromX: 1, z: 2.5 }]);
    expect(run(feetAt(0, 0, 0), tallEnough, 120).feet[0]).toBeGreaterThan(2);
  });

  it('is blocked by a 0.42 m riser (no blind band just above the step height)', () => {
    const scene = world((x) => (x > 1 ? 0.42 : 0), [{ x: 1, zMin: 0, zMax: 0.42 }]);
    const end = run(feetAt(0, 0, 0), scene, 120);
    expect(end.feet[0]).toBeLessThanOrEqual(1 - options.radius + 1e-6);
    expect(end.feet[2]).toBe(0);
  });

  it('moves nothing and stays finite on a NaN or infinite frame time or speed', () => {
    const scene = world(() => 0);
    for (const dt of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const end = stepWalk(feetAt(1, 2, 0), forwardX, ahead, dt, options, scene);
      expect(end.feet).toEqual([1, 2, 0]);
    }
    const airborne = stepWalk(feetAt(1, 2, 5, false), forwardX, ahead, Number.NaN, options, scene);
    expect(Number.isFinite(airborne.feet[2])).toBe(true);
    expect(Number.isFinite(airborne.velocityZ)).toBe(true);
    const noSpeed = stepWalk(feetAt(1, 2, 0), forwardX, ahead, 0.1, { ...options, speed: Number.NaN }, scene);
    expect(noSpeed.feet).toEqual([1, 2, 0]);
  });

  it('notices a camera moved by something else (goto, view preset), not the pose the walk wrote', () => {
    expect(cameraMovedExternally(null, [0, 0, 0], 1)).toBe(true);
    expect(cameraMovedExternally([1, 2, 3], [1, 2, 3.0005], 0.01)).toBe(false);
    expect(cameraMovedExternally([1, 2, 3], [9, 2, 3], 0.01)).toBe(true);
  });
});
