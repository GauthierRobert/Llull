/**
 * Live OpenCascade: a modelled M6x1 thread in a through hole of a 10 mm plate (VC-FTR-36). The solid must be valid and its volume must equal the
 * analytic removed volume of the basic ISO 68-1 internal profile: minor-diameter cylinder + groove area x helix length (Pappus).
 */

import { expect, it, afterAll } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { setGeometryKernel } from '@core/geometry/kernel';
import { internalThreadForm, internalThreadRemovedVolume } from '@lib/threadForm';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { liveKernels, describeNative } from './kernelTestSupport';

const kernels = liveKernels();
afterAll(() => setGeometryKernel(null));

const ctxOf = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });
/** Stated tolerance on the groove volume: facet ring step (geometry/threadTool.ts); measured +2.85e-3 on 2026-10-17. */
const TOLERANCE = 5e-3;
const MINOR_DIAMETER = 6 - 1.0825318;

function plateWithThread(
  thread: Record<string, unknown>,
  extent: Record<string, unknown> = { kind: 'through_all' },
): ReturnType<typeof execute> {
  const stock = execute(createEmptyDocument(), 'add_box', { size: [100, 60, 10], position: [0, 0, 0], anchor: 'min' });
  return execute(
    stock.document,
    'add_hole',
    {
      target: stock.affected[0],
      face: { near: [50, 30, 10] },
      pointsFrame: 'world_xy',
      points: [[50, 30]],
      hole: { kind: 'simple', diameter: MINOR_DIAMETER, thread },
      extent,
    },
    ctxOf(),
  );
}

function measure(doc: CadDocument, id: string): { volume: number; topologyVolume: number; valid: boolean | undefined } {
  const kernel = kernels.occt;
  const shape = kernel.evaluate(recipeOf(doc.entities[id] as Entity));
  expect(shape).not.toBeNull();
  return {
    volume: kernel.massProperties?.(shape!)?.volume ?? Number.NaN,
    topologyVolume: kernel.topology(shape!)?.volume ?? Number.NaN,
    valid: kernel.analyze?.(shape!)?.valid,
  };
}

describeNative('modelled thread on the live OCC kernel (VC-FTR-36)', () => {
  it('M6x1 through a 10 mm plate: valid solid, groove volume = analytic groove area x helix length', () => {
    const result = plateWithThread({ designation: 'M6x1-6H', modelled: true });
    expect(result.error).toBeUndefined();
    const { volume, topologyVolume, valid } = measure(result.document, result.affected[0] as string);
    const form = internalThreadForm(1, 6);
    const bore = Math.PI * form.minorRadius ** 2 * 10;
    const grooveAnalytic = internalThreadRemovedVolume(form, 10) - bore;
    const grooveMeasured = 60000 - volume - bore;
    const relative = Math.abs(grooveMeasured - grooveAnalytic) / grooveAnalytic;
    expect(valid).toBe(true);
    expect(Math.abs(topologyVolume - volume) / volume).toBeLessThan(1e-6);
    expect(relative).toBeLessThan(TOLERANCE);
  }, 300_000);

  it('a left-handed thread has the same volume as the right-handed one', () => {
    const right = plateWithThread({ designation: 'M6x1-6H', modelled: true });
    const left = plateWithThread({ designation: 'M6x1-6H', modelled: true, handedness: 'left' });
    const volumeRight = measure(right.document, right.affected[0] as string).volume;
    const volumeLeft = measure(left.document, left.affected[0] as string).volume;
    expect(Math.abs(volumeLeft - volumeRight) / 60000).toBeLessThan(1e-4);
  }, 300_000);

  it('a blind full-depth thread with the default 118 deg drill point is a valid solid (groove ends above the bore bottom)', () => {
    const result = plateWithThread({ designation: 'M6x1-6H', modelled: true }, { kind: 'blind', depth: 8 });
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain('drill point');
    const { volume, valid } = measure(result.document, result.affected[0] as string);
    expect(valid).toBe(true);
    const bore = Math.PI * (MINOR_DIAMETER / 2) ** 2 * 8;
    expect(60000 - volume).toBeGreaterThan(bore);
  }, 300_000);

  it('a cosmetic thread stays geometry-free: volume is the plain minor-diameter bore', () => {
    const result = plateWithThread({ designation: 'M6x1-6H' });
    const { volume } = measure(result.document, result.affected[0] as string);
    expect(Math.abs(volume - (60000 - Math.PI * (MINOR_DIAMETER / 2) ** 2 * 10)) / 60000).toBeLessThan(1e-6);
  }, 120_000);
});
