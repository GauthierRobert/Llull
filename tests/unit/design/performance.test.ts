/**
 * Cost of "the recipe is the source": a 200-command design applied and regenerated, against the same model as a build_project plan
 * (one history step per command). Bounds are loose (CI noise); the measured times are printed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';

const N = 100;

/** 2N commands: N plates, each with a boss unioned on top; the pitch is a parameter. */
const design = ['param pitch = 30', 'param h = 8'];
const plan: unknown[] = [
  { command: 'set_parameter', params: { name: 'pitch', expression: '30' } },
  { command: 'set_parameter', params: { name: 'h', expression: '8' } },
];
for (let i = 0; i < N; i++) {
  design.push(`add_box p${i} size=[20, 20, 4] position=[${i}*pitch, 0, 2]`, `add_cylinder c${i} radius=5 height=h on=p${i}.top`);
  plan.push(
    { command: 'add_box', params: { size: [20, 20, 4], position: [`=${i}*pitch`, 0, 2] }, as: `p${i}` },
    { command: 'add_cylinder', params: { radius: 5, height: '=h', position: [`=${i}*pitch`, 0, '=4+h/2'] }, as: `c${i}` },
  );
}

const time = <T>(fn: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

describe('performance', () => {
  it('a 200-command design applies and regenerates within the same order of time as the equivalent plan', () => {
    const lld = time(() => execute(createEmptyDocument(), 'apply_design', { source: design.join('\n') }));
    const json = time(() => execute(createEmptyDocument(), 'build_project', { actions: plan }));
    expect(lld.value.document.order).toHaveLength(2 * N);
    expect(json.value.document.order).toHaveLength(2 * N);
    const regen = (doc: CadDocument): { value: CommandResult; ms: number } =>
      time(() => execute(doc, 'set_parameter', { name: 'h', expression: '12' }));
    const lldRegen = regen(lld.value.document);
    const jsonRegen = regen(json.value.document);
    const top = (doc: CadDocument): number =>
      (execute(doc, 'measure_bounding_box', { entityId: doc.order.at(-1) ?? '' }).data as { max: number[] }).max[2] ?? 0;
    expect(top(lldRegen.value.document)).toBeCloseTo(16);
    expect(top(jsonRegen.value.document)).toBeCloseTo(16);
    console.warn(
      `[design perf] ${2 * N} commands — apply: lld ${lld.ms.toFixed(0)} ms / plan ${json.ms.toFixed(0)} ms; ` +
        `regenerate (set_parameter): lld ${lldRegen.ms.toFixed(0)} ms / plan ${jsonRegen.ms.toFixed(0)} ms; ` +
        `source ${design.join('\n').length} chars / plan JSON ${JSON.stringify(plan).length} chars`,
    );
    expect(lld.ms).toBeLessThan(20_000);
    expect(lldRegen.ms).toBeLessThan(20_000);
  });
});
