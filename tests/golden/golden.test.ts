import { describe, it, expect } from 'vitest';
import { plans } from './plans';
import { feaPlans } from './feaPlans';
import { compositePlans } from './compositePlans';
import { describePlans } from './describePlans';
import { plmPlans } from './plmPlans';
import { deformPlans } from './deformPlans';
import { implicitPlans } from './implicitPlans';
import { pipingPlans } from './pipingPlans';
import { pipingPlansV1 } from './pipingPlansV1';
import { setSignaturePort } from '@core/commands/signaturePort';
import { afterAll, beforeAll } from 'vitest';
import { execute } from '@core/commands/registry';
import { runPlan } from './runPlan';
import type { CadDocument } from '@core/model/types';
import type { GoldenAction } from './plans';

// The golden plm plan checks the lifecycle and replay with a scripted port that accepts any confirmation naming its signer (the gate is attacked in tests/unit/plm/humanGate.test.ts).
beforeAll(() =>
  setSignaturePort({
    verify: (c) =>
      typeof c === 'object' && c !== null && 'as' in c ? { signer: String((c as { as: unknown }).as), signatureId: 'golden' } : null,
  }),
);
afterAll(() => setSignaturePort(null));

describe('golden replay corpus', () =>
  describePlans({
    ...plans,
    ...feaPlans,
    ...compositePlans,
    ...plmPlans,
    ...deformPlans,
    ...implicitPlans,
    ...pipingPlans,
    ...pipingPlansV1,
  }));

describe('loops_polar_pattern parametric regeneration', () => {
  const cylinderCount = (doc: CadDocument): number => Object.values(doc.entities).filter((e) => e.kind === 'cylinder').length;
  it('set_parameter n=9 regenerates nine radial cylinders (and n=4 four)', () => {
    const built = runPlan(plans['loops_polar_pattern'] as GoldenAction[]).document;
    expect(cylinderCount(built)).toBe(7);
    const nine = execute(built, 'set_parameter', { name: 'n', expression: '9' }).document;
    expect(cylinderCount(nine)).toBe(9);
    expect(nine.order).toHaveLength(9);
    const four = execute(nine, 'set_parameter', { name: 'n', expression: '4' }).document;
    expect(cylinderCount(four)).toBe(4);
  });
});
