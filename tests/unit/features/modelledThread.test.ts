import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { internalThreadForm, internalThreadRemovedVolume, parseThreadDimensions } from '@lib/threadForm';
import { threadGroove } from '@core/geometry/threadTool';
import { featureError } from '@core/geometry/featureRecipe';
import { expectPure } from '../../helpers/expectNoOp';
import { ctxWith, idOf, manifoldSuite, meshOf, plate, volumeOf } from '../../helpers/featureSupport';

const kernelOf = manifoldSuite();

describe('thread designation -> pitch and diameters (07 FR-FTR-20)', () => {
  it('reads M / MJ metric designations', () => {
    expect(parseThreadDimensions('M6x1-6H')).toEqual({ majorDiameterMm: 6, pitchMm: 1 });
    expect(parseThreadDimensions('MJ6x1-4H5H')).toEqual({ majorDiameterMm: 6, pitchMm: 1 });
    expect(parseThreadDimensions('M10x1.25')).toEqual({ majorDiameterMm: 10, pitchMm: 1.25 });
  });

  it('reads UN / UNJ inch designations (decimal, fraction, numbered sizes)', () => {
    const decimal = parseThreadDimensions('.1900-32 UNJF-3B');
    expect(decimal?.majorDiameterMm).toBeCloseTo(4.826, 9);
    expect(decimal?.pitchMm).toBeCloseTo(25.4 / 32, 12);
    expect(parseThreadDimensions('1/4-20 UNC-2B')?.majorDiameterMm).toBeCloseTo(6.35, 9);
    expect(parseThreadDimensions('#10-32 UNF-2B')?.majorDiameterMm).toBeCloseTo(0.19 * 25.4, 9);
  });

  it('refuses a coarse M designation without a pitch and garbage', () => {
    expect(parseThreadDimensions('M6-6H')).toBeNull();
    expect(parseThreadDimensions('M6')).toBeNull();
    expect(parseThreadDimensions('nonsense')).toBeNull();
    expect(parseThreadDimensions('M1x2')).toBeNull();
  });

  it('basic internal profile of M6x1: D1 = 4.917 mm, groove area 0.2368 mm2', () => {
    const form = internalThreadForm(1, 6);
    expect(2 * form.minorRadius).toBeCloseTo(6 - 1.0825318, 6);
    expect(form.widthAt(form.minorRadius)).toBeCloseTo(0.75, 12);
    expect(form.widthAt(form.majorRadius)).toBeCloseTo(0.125, 12);
    expect(form.grooveArea).toBeCloseTo(0.4375 * 0.625 * Math.sqrt(3) * 0.5, 9);
    expect(internalThreadRemovedVolume(form, 10)).toBeGreaterThan(Math.PI * form.minorRadius ** 2 * 10);
  });
});

describe('modelled thread in a hole (Manifold smoke)', () => {
  const thread = { designation: 'M6x1-6H', modelled: true };
  const hole = (diameter: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'simple',
    diameter,
    thread: { ...thread, ...extra },
  });
  const drill = (params: Record<string, unknown>): ReturnType<typeof execute> => {
    const stock = plate();
    return execute(
      stock.doc,
      'add_hole',
      {
        target: stock.id,
        face: { near: [50, 30, 10] },
        pointsFrame: 'world_xy',
        points: [[50, 30]],
        extent: { kind: 'through_all' },
        ...params,
      },
      ctxWith(kernelOf()),
    );
  };

  it('removes the groove on top of the same bore: volume within 1.5% of the analytic groove (Manifold facets)', () => {
    const result = drill({ hole: hole(6 - 1.0825318) });
    expect(result.error).toBeUndefined();
    const plain = drill({ hole: { kind: 'simple', diameter: 6 - 1.0825318 } });
    const form = internalThreadForm(1, 6);
    const groove = internalThreadRemovedVolume(form, 10) - Math.PI * form.minorRadius ** 2 * 10;
    const measured = volumeOf(plain.document, idOf(plain)) - volumeOf(result.document, idOf(result));
    expect(Math.abs(measured - groove) / groove).toBeLessThan(0.015);
    expect(result.summary).toContain('modelled helical groove');
  });

  it('a left-handed thread and a blind thread build too; cosmetic stays recipe-key neutral', () => {
    const left = drill({ hole: hole(6 - 1.0825318, { handedness: 'left' }) });
    expect(left.error).toBeUndefined();
    const blind = drill({ hole: hole(6 - 1.0825318, { depth: 6 }), extent: { kind: 'blind', depth: 8, drillPointAngle: 0 } });
    expect(blind.error).toBeUndefined();
    const plain = drill({ hole: { kind: 'simple', diameter: 4.9 } });
    const cosmetic = drill({ hole: { kind: 'simple', diameter: 4.9, thread: { designation: 'M6x1-6H' } } });
    expect(recipeKey(meshOf(cosmetic.document, idOf(cosmetic)).brep!)).toBe(recipeKey(meshOf(plain.document, idOf(plain)).brep!));
    const modelledKey = recipeKey(meshOf(left.document, idOf(left)).brep!);
    expect(modelledKey).not.toBe(
      recipeKey(meshOf(drill({ hole: hole(6 - 1.0825318) }).document, idOf(drill({ hole: hole(6 - 1.0825318) }))).brep!),
    );
  });

  it('refuses a designation without pitch, an unrelated bore and a family other', () => {
    const noPitch = drill({ hole: { kind: 'simple', diameter: 4.9, thread: { designation: 'M6-6H', modelled: true } } });
    expect(noPitch.error?.code).toBe('FTR_THREAD_DESIGNATION_INVALID');
    const wide = drill({ hole: hole(7) });
    expect(wide.error?.code).toBe('FTR_HOLE_DIAMETERS_INCONSISTENT');
    const free = drill({ hole: { kind: 'simple', diameter: 4.9, thread: { designation: 'custom form', modelled: true } } });
    expect(free.error?.code).toBe('FTR_THREAD_DESIGNATION_INVALID');
  });
});

describe('set_thread with modelled', () => {
  const drilled = (): { doc: ReturnType<typeof plate>['doc']; id: string } => {
    const stock = plate();
    const result = execute(
      stock.doc,
      'add_hole',
      {
        target: stock.id,
        face: { near: [50, 30, 10] },
        pointsFrame: 'world_xy',
        points: [[50, 30]],
        hole: { kind: 'simple', diameter: 6 - 1.0825318 },
        extent: { kind: 'through_all' },
      },
      ctxWith(kernelOf()),
    );
    return { doc: result.document, id: idOf(result) };
  };

  it('rebuilds the mesh with the groove, and removing it restores the plain bore', () => {
    const { doc, id } = drilled();
    const before = volumeOf(doc, id);
    const threaded = execute(
      doc,
      'set_thread',
      { id, featureIndex: 0, thread: { designation: 'M6x1', modelled: true } },
      ctxWith(kernelOf()),
    );
    expect(threaded.affected).toEqual([id]);
    expect(volumeOf(threaded.document, id)).toBeLessThan(before - 30);
    const removed = execute(threaded.document, 'set_thread', { id, featureIndex: 0, thread: null }, ctxWith(kernelOf()));
    expect(volumeOf(removed.document, id)).toBeCloseTo(before, 3);
    expectPure(doc, () =>
      execute(doc, 'set_thread', { id, featureIndex: 0, thread: { designation: 'M6x1', modelled: true } }, ctxWith(kernelOf())),
    );
  });

  it('is a no-op without a kernel, with a bad pitch or with a bore that does not fit', () => {
    const { doc, id } = drilled();
    const noKernel = execute(doc, 'set_thread', { id, featureIndex: 0, thread: { designation: 'M6x1', modelled: true } }, ctxWith(null));
    expect(noKernel.error?.code).toBe('FTR_NEEDS_EXACT_KERNEL');
    expect(noKernel.document).toBe(doc);
    expect(noKernel.affected).toEqual([]);
    const noPitch = execute(doc, 'set_thread', { id, featureIndex: 0, thread: { designation: 'M6', modelled: true } }, ctxWith(kernelOf()));
    expect(noPitch.error?.code).toBe('FTR_THREAD_DESIGNATION_INVALID');
    expect(noPitch.document).toBe(doc);
    expect(noPitch.affected).toEqual([]);
    const wrongSize = execute(
      doc,
      'set_thread',
      { id, featureIndex: 0, thread: { designation: 'M12x1.75', modelled: true } },
      ctxWith(kernelOf()),
    );
    expect(wrongSize.error?.code).toBe('FTR_HOLE_DIAMETERS_INCONSISTENT');
    expect(wrongSize.document).toBe(doc);
    expect(wrongSize.affected).toEqual([]);
  });
});

describe('threadGroove and the recipe check', () => {
  const spec = (diameter: number, extra: Record<string, unknown> = {}): Parameters<typeof threadGroove>[0] => ({
    kind: 'simple',
    diameter,
    thread: { designation: 'M6x1', family: 'M', modelled: true, pitch: 1, majorDiameter: 6, ...extra },
  });

  it('builds a closed outward mesh for a right and a mirrored left thread, with a smaller blind span', () => {
    const right = threadGroove(spec(4.9), { kind: 'through_all' }, 10);
    const left = threadGroove(spec(4.9, { handedness: 'left' }), { kind: 'through_all' }, 10);
    const blind = threadGroove(spec(4.9, { depth: 4 }), { kind: 'blind', depth: 8 }, 0);
    expect(right?.mesh.indices.length).toBe(left?.mesh.indices.length);
    expect(blind?.mesh.indices.length).toBeLessThan(right?.mesh.indices.length ?? 0);
    expect(right?.startDepth).toBeCloseTo(10.8, 0);
    expect(left?.mesh.positions[1]).toBeCloseTo(-(right?.mesh.positions[1] ?? 0), 12);
  });

  it('is null for a cosmetic thread, a bore at the major diameter, an over-wide groove and too short a span', () => {
    expect(threadGroove({ kind: 'simple', diameter: 4.9 }, { kind: 'through_all' }, 10)).toBeNull();
    expect(threadGroove(spec(6), { kind: 'through_all' }, 10)).toBeNull();
    expect(threadGroove(spec(3.4), { kind: 'through_all' }, 10)).toBeNull();
    expect(threadGroove(spec(4.9, { depth: 0.01 }), { kind: 'blind', depth: 0.01 }, 0)).toBeNull();
  });

  it('rejects a modelled thread node without pitch and major diameter', () => {
    const node = (thread: Record<string, unknown>): Record<string, unknown> => ({
      frame: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
      feature: 'hole',
      points: [[0, 0]],
      hole: { kind: 'simple', diameter: 4.9, thread },
      extent: { kind: 'through_all' },
    });
    expect(featureError(node({ designation: 'M6x1', family: 'M', modelled: true }))).toContain('pitch');
    expect(featureError(node({ designation: 'M6x1', family: 'M', modelled: true, pitch: 1, majorDiameter: 6 }))).toBeNull();
    expect(featureError(node({ designation: 'M6x1', family: 'M' }))).toBeNull();
  });
});
