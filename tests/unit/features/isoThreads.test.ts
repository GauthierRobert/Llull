import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import {
  externalThreadForm,
  externalThreadRemovedVolume,
  internalThreadForm,
  internalThreadRemovedVolume,
  isoBasicDiameters,
  parseIsoMetric,
} from '@lib/threadForm';
import { externalThreadGroove } from '@core/geometry/threadTool';
import { signedMeshVolume } from '@core/geometry/meshVolume';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { idOf, manifoldSuite, plate, volumeOf } from '../../helpers/featureSupport';

manifoldSuite();

const COARSE: Array<[number, number]> = [
  [3, 0.5],
  [4, 0.7],
  [5, 0.8],
  [6, 1],
  [8, 1.25],
  [10, 1.5],
  [12, 1.75],
  [14, 2],
  [16, 2],
  [18, 2.5],
  [20, 2.5],
];

describe('ISO metric designations M3-M20 (ISO 261 / 262, ISO 68-1)', () => {
  it.each(COARSE)('M%i resolves to the coarse pitch %f', (diameter, pitch) => {
    expect(parseIsoMetric(`M${diameter}`)).toMatchObject({ majorDiameterMm: diameter, pitchMm: pitch, coarse: true });
  });

  it('keeps an explicit (fine) pitch and ignores the tolerance suffix', () => {
    expect(parseIsoMetric('M10x1.25')).toEqual({ designation: 'M10x1.25', majorDiameterMm: 10, pitchMm: 1.25, coarse: false });
    expect(parseIsoMetric('M8x1-6g')).toMatchObject({ majorDiameterMm: 8, pitchMm: 1 });
  });

  it('refuses sizes outside M3-M20, sizes without a coarse pitch, garbage and impossible pitches', () => {
    for (const bad of ['M2', 'M2.5', 'M24', 'M30x2', 'M7', 'M9', 'M1.6x0.35', 'nonsense', '1/4-20 UNC', 'M8x0', 'M8x5'])
      expect(typeof parseIsoMetric(bad)).toBe('string');
    expect(parseIsoMetric('M24')).toContain('outside the supported range M3-M20');
    expect(parseIsoMetric('M7')).toContain('no ISO 261 coarse pitch');
  });

  it('basic profile diameters: d2 = d - 0.649519 P, d1 = d - 1.082532 P, H = 0.866025 P', () => {
    const { height, pitchDiameter, minorDiameter } = isoBasicDiameters(10, 1.5);
    expect(height).toBeCloseTo(1.2990381, 6);
    expect(pitchDiameter).toBeCloseTo(10 - 0.649519 * 1.5, 5);
    expect(minorDiameter).toBeCloseTo(10 - 1.082532 * 1.5, 5);
  });

  it.each(COARSE)('M%i external groove volume per length matches a numeric integral of the cross-section', (diameter, pitch) => {
    const form = externalThreadForm(pitch, diameter);
    const steps = 20000;
    let area = 0;
    let moment = 0;
    for (let i = 0; i < steps; i++) {
      const r = form.minorRadius + ((i + 0.5) / steps) * (form.majorRadius - form.minorRadius);
      const slice = form.widthAt(r) * ((form.majorRadius - form.minorRadius) / steps);
      area += slice;
      moment += slice * r;
    }
    expect(area).toBeCloseTo(form.grooveArea, 9);
    expect(externalThreadRemovedVolume(form, 7)).toBeCloseTo((2 * Math.PI * moment * 7) / pitch, 6);
    expect(form.widthAt(form.majorRadius)).toBeCloseTo((7 * pitch) / 8, 12);
    expect(form.widthAt(form.minorRadius)).toBeCloseTo(pitch / 4, 12);
    expect(2 * form.minorRadius).toBeCloseTo(isoBasicDiameters(diameter, pitch).minorDiameter, 9);
  });
});

describe('add_tapped_hole', () => {
  const tap = (params: Record<string, unknown>, stock = plate()): ReturnType<typeof execute> =>
    execute(stock.doc, 'add_tapped_hole', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      pointsFrame: 'world_xy',
      points: [[50, 30]],
      extent: { kind: 'through_all' },
      size: 'M6',
      ...params,
    });

  it('M6 through: minor-diameter bore + modelled thread, volume within 2% of the analytic tapped hole', () => {
    const stock = plate();
    const result = tap({}, stock);
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    expect(result.summary).toContain('M6x1 (coarse)');
    expect(result.data).toMatchObject({ designation: 'M6x1', pitch: 1, majorDiameter: 6 });
    const data = result.data as { minorDiameter: number; pitchDiameter: number };
    expect(data.minorDiameter).toBeCloseTo(6 - 1.082532, 5);
    expect(data.pitchDiameter).toBeCloseTo(6 - 0.649519, 5);
    const analytic = internalThreadRemovedVolume(internalThreadForm(1, 6), 10);
    const removed = 60000 - volumeOf(result.document, idOf(result));
    expect(Math.abs(removed - analytic) / analytic).toBeLessThan(0.02);
    expectPure(stock.doc, () => tap({}, stock));
  });

  it('takes a fine pitch, a left hand, a shorter blind thread and sketch points', () => {
    const fine = tap({ size: 'M8x1' });
    expect((fine.data as { pitch: number }).pitch).toBe(1);
    expect(fine.summary).not.toContain('(coarse)');
    const stock = plate();
    const drawn = execute(stock.doc, 'draw_point', { position: [30, 30, 10] });
    const blind = execute(drawn.document, 'add_tapped_hole', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      points: { sketchEntityIds: [idOf(drawn)] },
      size: 'M5',
      extent: { kind: 'blind', depth: 6, drillPointAngle: 0 },
      threadDepth: 4,
      handedness: 'left',
    });
    expect(blind.rejected).toBeUndefined();
    expect(blind.affected).toHaveLength(1);
    expect(blind.summary).toContain('M5x0.8 (coarse)');
  });

  it('refuses out-of-range and unknown sizes, and surfaces add_hole refusals', () => {
    const stock = plate();
    for (const size of ['M2', 'M24', 'M7', 'bolt']) {
      const result = tap({ size }, stock);
      expectNoOp(result, stock.doc);
      expect(result.error?.code).toBe('FTR_THREAD_DESIGNATION_INVALID');
    }
    const outside = tap({ points: [[500, 30]] }, stock);
    expectNoOp(outside, stock.doc, 'FTR_HOLE_POINT_OUTSIDE_FACE');
    expect(outside.summary).toContain('add_tapped_hole');
  });
});

describe('add_external_thread', () => {
  const cylinder = (radius: number, height: number, extra: Record<string, unknown> = {}): { doc: CadDocument; id: string } => {
    const made = execute(createEmptyDocument(), 'add_cylinder', { radius, height, ...extra });
    return { doc: made.document, id: idOf(made) };
  };
  const thread = (stock: { doc: CadDocument; id: string }, params: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(stock.doc, 'add_external_thread', { target: stock.id, ...params });
  /** Volume of the cylinder as the mesh kernel tessellates it. */
  const polygonVolume = (stock: { doc: CadDocument; id: string }): number => {
    const kernel = getGeometryKernel();
    const entity = stock.doc.entities[stock.id];
    if (kernel === null || entity === undefined) throw new Error('kernel and entity expected');
    const shape = kernel.evaluate(recipeOf(entity));
    const mesh = shape === null ? null : kernel.tessellate(shape);
    if (mesh === null) throw new Error('cylinder did not tessellate');
    return signedMeshVolume(mesh.positions, mesh.indices);
  };

  it('M10 on a 20 mm cylinder: removed volume within 8% of the analytic groove (the n-gon cylinder clips the groove outer edge), one mesh with a boolean recipe', () => {
    const stock = cylinder(5, 20);
    const result = thread(stock, { size: 'M10' });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    expect(result.document.entities[stock.id]).toBeUndefined();
    const data = result.data as { analyticRemovedVolume: number; minorDiameter: number; threadLength: number };
    expect(data.minorDiameter).toBeCloseTo(10 - 1.082532 * 1.5, 5);
    expect(data.threadLength).toBe(20);
    const analytic = externalThreadRemovedVolume(externalThreadForm(1.5, 10), 20);
    expect(data.analyticRemovedVolume).toBeCloseTo(analytic, 9);
    const removed = polygonVolume(stock) - volumeOf(result.document, idOf(result));
    expect(Math.abs(removed - analytic) / analytic).toBeLessThan(0.08);
    expect(result.summary).toContain('M10x1.5 (coarse) right-hand thread');
    expectPure(stock.doc, () => thread(stock, { size: 'M10' }));
  });

  it('threads only `length` from the bottom end, left-handed, on a rotated cylinder (same removal per length)', () => {
    const upright = cylinder(4, 30);
    const tilted = cylinder(4, 30, { rotation: [Math.PI / 2, 0, 0], position: [5, 6, 7] });
    const analytic = externalThreadRemovedVolume(externalThreadForm(1.25, 8), 12);
    for (const stock of [upright, tilted]) {
      const result = thread(stock, { size: 'M8', length: 12, end: 'bottom', handedness: 'left' });
      expect(result.rejected).toBeUndefined();
      const removed = polygonVolume(stock) - volumeOf(result.document, idOf(result));
      expect(Math.abs(removed - analytic) / analytic).toBeLessThan(0.1);
    }
  });

  it('the tool mesh runs out through the end face: right and left hand differ', () => {
    const form = externalThreadForm(1, 6);
    const right = externalThreadGroove(form, 5, 10, 1, false);
    const left = externalThreadGroove(form, 5, 10, 1, true);
    expect(right).not.toBeNull();
    expect(left?.positions.length).toBe(right?.positions.length);
    expect(left?.positions).not.toEqual(right?.positions);
    const zs = (right?.positions ?? []).filter((_, index) => index % 3 === 2);
    expect(Math.max(...zs)).toBeGreaterThan(10);
    expect(Math.min(...zs)).toBeCloseTo(5, 6);
  });

  it('refuses unknown or non-cylinder targets, bad sizes, diameter mismatch and bad lengths', () => {
    const stock = cylinder(5, 20);
    const box = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const cases: Array<[CadDocument, Record<string, unknown>, string, string]> = [
      [stock.doc, { target: 'missing', size: 'M10' }, 'FTR_PART_NOT_FOUND', 'not found'],
      [box.document, { target: idOf(box), size: 'M10' }, 'FTR_PART_NOT_FOUND', 'not a cylinder'],
      [stock.doc, { target: stock.id, size: 'M24' }, 'FTR_THREAD_DESIGNATION_INVALID', 'outside the supported range'],
      [stock.doc, { target: stock.id, size: 'M7' }, 'FTR_THREAD_DESIGNATION_INVALID', 'coarse pitch'],
      [stock.doc, { target: stock.id, size: 'M8' }, 'FTR_HOLE_DIAMETERS_INCONSISTENT', 'does not match'],
      [stock.doc, { target: stock.id, size: 'M10', length: 1 }, 'FTR_FEATURE_BUILD_FAILED', 'shorter than one pitch'],
      [stock.doc, { target: stock.id, size: 'M10', length: 25 }, 'FTR_FEATURE_BUILD_FAILED', 'exceeds the cylinder height'],
    ];
    for (const [doc, params, code, text] of cases) {
      const result = execute(doc, 'add_external_thread', params);
      expectNoOp(result, doc, text);
      expect(result.error?.code).toBe(code);
    }
  });

  it('is refused without a geometry kernel', () => {
    const stock = cylinder(5, 20);
    const kernel = getGeometryKernel();
    setGeometryKernel(null);
    try {
      expectNoOp(thread(stock, { size: 'M10' }), stock.doc);
    } finally {
      setGeometryKernel(kernel);
    }
  });
});
