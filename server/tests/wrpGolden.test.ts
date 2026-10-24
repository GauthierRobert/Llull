/**
 * The WRP golden plan on the native OCCT kernel (03 WRP, DES-3b): docs/design/03-wrap-emboss/validation/plans/golden_wrp_native.json builds a bottle (revolved polygon), embosses a Fira Sans
 * label, engraves a single-line serial, debosses a dimple pattern, splits the body along a ring, cuts a knurl on the neck and audits it. The step summaries (numbers rounded to 7 significant
 * digits) are the golden snapshot; replay_history must give the same entities and the same volume. Skipped when the llull-kernel binary (with the `emboss` capability) is not built.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setFontProvider } from '@core/commands/fontPort';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createFontProvider } from '../src/fontProvider';

const plan = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../docs/design/03-wrap-emboss/validation/plans/golden_wrp_native.json'), 'utf8'),
) as Array<Record<string, unknown>>;

interface StepReport {
  readonly index: number;
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
}

/** Decimal numbers rounded to 7 significant digits, so the snapshot does not depend on the last bits of the kernel. */
const rounded = (text: string): string =>
  text.replace(/-?\d+\.\d+(?:e[+-]?\d+)?/g, (number) => String(Number(Number(number).toPrecision(7))));

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP golden native' })('the WRP golden plan on the native kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
    setFontProvider(createFontProvider());
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    setFontProvider(null);
    kernel.dispose();
  });

  it('runs every step, matches the golden snapshot, and replays to the same solid', async () => {
    const built = execute(createEmptyDocument(), 'build_project', { actions: plan });
    const steps = (built.data as { ok: boolean; steps: StepReport[] }).steps;
    expect(steps.filter((step) => !step.ok).map((step) => `#${step.index} ${step.command}: ${step.summary}`)).toEqual([]);
    expect(steps).toHaveLength(plan.length);
    const snapshot = steps.map((step) => ({ step: step.index, command: step.command, summary: rounded(step.summary) }));
    await expect(`${JSON.stringify(snapshot, null, 1)}\n`).toMatchFileSnapshot('./__snapshots__/wrpGolden.json');
    const volume = (doc: typeof built.document, id: string): number =>
      (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
    const finalId = built.document.order[built.document.order.length - 1] as string;
    const before = volume(built.document, finalId);
    const replayed = execute(built.document, 'replay_history', {});
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(replayed.document.order).toEqual(built.document.order);
    expect(Math.abs(volume(replayed.document, finalId) / before - 1)).toBeLessThan(1e-9);
    expect(before).toBeGreaterThan(70_000);
    const audit = execute(built.document, 'check_wrap', {});
    expect(['pass', 'warn']).toContain((audit.data as { status: string }).status);
  }, 300_000);
});
