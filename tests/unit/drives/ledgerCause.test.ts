/** The servo-jump attribution of check_motion_truth: a closure error of the size of the jump energy is only called consistent with a servo jump start when the servo really jumped. */
import { describe, expect, it } from 'vitest';
import type { DynamicsModel } from '@core/model/dynamics';
import type { RunData } from '@dynamics/sim/runData';
import { ledgerItems } from '@dynamics/sim/truth/ledgerItems';

const dynamics = {
  gravity: [0, 0, 0],
  bodies: {},
  joints: {
    j: {
      id: 'j',
      kind: 'prismatic',
      parent: 'ground',
      child: 'b',
      anchor: [0, 0, 0],
      axis: [1, 0, 0],
      damping: 0,
      friction: 0,
      initialVelocity: 0,
    },
  },
  motors: { m: { id: 'm', kind: 'linear_speed', joint: 'j', speedMps: 0.1, maxForceN: 100 } },
  propellers: {},
} as unknown as DynamicsModel;

/** A run whose ledger fails by 0.025 J (relative 0.16) and whose joint speed series is `velocity`; the 5 kg joint makes the jump energy 1/2 5 0.1^2 = 0.025 J. */
const run = (velocity: number[]): RunData =>
  ({
    ledger: {
      entries: [],
      inputJ: 0.155,
      dissipatedJ: 0.076,
      storedChangeJ: 0.054,
      closureErrorJ: 0.025,
      closureRelative: 0.16,
      closure: 'fail',
    },
    series: { times: velocity.map((_, k) => k * 1e-3), jointVelocity: { j: velocity } },
  }) as unknown as RunData;

describe('DRV_LEDGER_SERVO_JUMP attribution', () => {
  it('a servo that reached its target by the first sample: the failing closure is named as consistent with a servo jump start', () => {
    const items = ledgerItems(run([0, 0.1, 0.1, 0.1]), dynamics, () => 5);
    expect(items.map((item) => item.code)).toEqual(['DRV_LEDGER_CLOSURE', 'DRV_LEDGER_SERVO_JUMP']);
    expect(items[0]?.status).toBe('fail');
    expect(items[1]?.note).toMatch(/consistent with a servo jump start/);
  });

  it('a stop-closure defect of the same size with a servo that ramps (saturated, 10 % of the target at the first sample) is NOT labelled a servo jump', () => {
    const items = ledgerItems(run([0, 0.01, 0.02, 0.03]), dynamics, () => 5);
    expect(items.map((item) => item.code)).toEqual(['DRV_LEDGER_CLOSURE']);
    expect(items[0]?.status).toBe('fail');
  });

  it('without a joint series the jump cannot be verified and is not claimed', () => {
    const bare = { ...run([0, 0.1]), series: undefined } as unknown as RunData;
    expect(ledgerItems(bare, dynamics, () => 5).map((item) => item.code)).toEqual(['DRV_LEDGER_CLOSURE']);
  });
});
