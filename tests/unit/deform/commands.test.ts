import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import {
  type KernelKind,
  type RunData,
  WORLD_Z,
  addBox,
  addCylinder,
  dataOf,
  installKernel,
  meshEntity,
  relative,
  volumeOf,
} from './harness';

const KERNELS: KernelKind[] = ['none', 'manifold', 'exact'];

afterEach(() => setGeometryKernel(null));

describe.each(KERNELS)('deformation commands, kernel: %s', (kind) => {
  const twist = { angleDeg: 90, frame: WORLD_Z, region: { start: 0, end: 100, falloff: 'linear' }, output: { tolerance: 0.01 } };

  it('twist_body replaces the bar by a mesh entity whose recipe is the deform node, volume kept', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const result = execute(doc, 'twist_body', { id, ...twist });
    expect(result.affected).toHaveLength(1);
    const next = result.affected[0] as string;
    expect(result.document.entities[id]).toBeUndefined();
    expect(result.document.order).toEqual([next]);
    const entity = meshEntity(result.document, next);
    expect(entity.brep).toMatchObject({ op: 'deform', law: { kind: 'twist' }, output: { mode: 'auto', tolerance: 0.01 } });
    expect(relative(volumeOf(result.document, next), 10000)).toBeLessThan(5e-3);
    const data = dataOf<RunData>(result);
    expect(data.path).toBe('mesh');
    expect(data.region).toMatchObject({ start: 0, end: 100, falloff: 'linear' });
    expect(data.jacobian).toEqual({ min: 1, max: 1 });
    expect(data.chordError === null || data.chordError <= 0.01).toBe(true);
    expect(result.summary).toContain(`twisted '${id}'`);
    expect(result.summary).toContain('mesh path');
    expect(result.summary).toContain('analyze_deformation');
  });

  it('twist_body is pure and deterministic', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    expectPure(doc, () => execute(doc, 'twist_body', { id, ...twist }));
    const [first, second] = [execute(doc, 'twist_body', { id, ...twist }), execute(doc, 'twist_body', { id, ...twist })];
    expect(first.document).toEqual(second.document);
    expect(first.affected).toEqual(second.affected);
  });

  it('twist_body refuses bad input without touching the document', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const refused = (params: Record<string, unknown>, code: string): void => {
      const result = execute(doc, 'twist_body', params);
      expectNoOp(result, doc, code);
      expect(result.error?.code).toBe(code);
    };
    refused({ id: 'nope', angleDeg: 30 }, 'DEF_ENTITY_NOT_FOUND');
    refused({ id, angleDeg: 0 }, 'DEF_NO_EFFECT');
    refused({ id, angleDeg: 30, frame: { axis: [0, 0, 0] } }, 'DEF_FRAME_DEGENERATE');
    refused({ id, angleDeg: 30, frame: { axis: [0, 0, 1], reference: [0, 0, 2] } }, 'DEF_FRAME_DEGENERATE');
    refused({ id, angleDeg: 30, region: { start: 50, end: 10 } }, 'DEF_REGION_INVALID');
    refused({ id, angleDeg: 30, frame: WORLD_Z, region: { start: 200, end: 300 } }, 'DEF_REGION_MISSES_BODY');
    refused({ id, angleDeg: 30, output: { tolerance: -1 } }, 'DEF_TOLERANCE_INVALID');
    refused({ id, angleDeg: 30, output: { preserveAnalytic: true } }, 'DEF_EXACT_UNAVAILABLE');
    refused({ id, angleDeg: 30, output: { mode: 'exact' } }, 'DEF_EXACT_UNAVAILABLE');
    refused({ id, angleDeg: 3000, output: { tolerance: 1e-7 } }, 'DEF_BUDGET_EXCEEDED');
  });

  it('refuses targets that are not solids', async () => {
    await installKernel(kind);
    const rectangle = execute(createEmptyDocument(), 'draw_rectangle', { width: 4, height: 3 });
    const flat = rectangle.affected[0] as string;
    const result = execute(rectangle.document, 'twist_body', { id: flat, angleDeg: 20 });
    expectNoOp(result, rectangle.document, 'DEF_TARGET_UNSUPPORTED');
    expect(result.error).toMatchObject({ code: 'DEF_TARGET_UNSUPPORTED', ids: [flat] });
  });

  it('taper_body tapers the bar (smooth default ramp) and refuses a degenerate scale', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const result = execute(doc, 'taper_body', { id, scaleEnd: 0.5, frame: WORLD_Z, output: { tolerance: 0.01 } });
    expect(result.affected).toHaveLength(1);
    expect(relative(volumeOf(result.document, result.affected[0] as string), 5928.571428)).toBeLessThan(5e-3);
    expect(dataOf<RunData>(result).region?.falloff).toBe('smooth');
    expectPure(doc, () => execute(doc, 'taper_body', { id, scaleEnd: 0.5 }));
    expectNoOp(execute(doc, 'taper_body', { id, scaleEnd: 0 }), doc, 'DEF_TAPER_DEGENERATE');
    expectNoOp(execute(doc, 'taper_body', { id, scaleEnd: -2 }), doc, 'DEF_TAPER_DEGENERATE');
    expectNoOp(execute(doc, 'taper_body', { id, scaleEnd: 1 }), doc, 'DEF_NO_EFFECT');
    const flat = execute(doc, 'taper_body', { id, scaleEnd: 0.5, flat: true, frame: WORLD_Z, region: { falloff: 'linear' } });
    expect(relative(volumeOf(flat.document, flat.affected[0] as string), 7500)).toBeLessThan(5e-3);
  });

  it('taper_body and stretch_body refuse a degenerate frame and a bad region with their codes', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    for (const command of ['taper_body', 'stretch_body']) {
      const base = command === 'taper_body' ? { id, scaleEnd: 0.5 } : { id, factor: 2 };
      expect(execute(doc, command, { ...base, frame: { axis: [0, 0, 0] } }).error?.code).toBe('DEF_FRAME_DEGENERATE');
      expect(execute(doc, command, { ...base, region: { start: 9, end: 3 } }).error?.code).toBe('DEF_REGION_INVALID');
    }
  });

  it('stretch_body stretches a region, or the whole body at constant volume', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const region = execute(doc, 'stretch_body', { id, factor: 1.5, frame: WORLD_Z, region: { start: 20, end: 60 } });
    expect(relative(volumeOf(region.document, region.affected[0] as string), 12000)).toBeLessThan(1e-6);
    expect(meshEntity(region.document, region.affected[0] as string).brep).toMatchObject({
      law: { kind: 'stretch' },
      region: { falloff: 'none' },
    });
    const whole = execute(doc, 'stretch_body', { id, factor: 2, preserveVolume: true, frame: WORLD_Z });
    expect(relative(volumeOf(whole.document, whole.affected[0] as string), 10000)).toBeLessThan(1e-6);
    expect(meshEntity(whole.document, whole.affected[0] as string).brep).toMatchObject({ law: { kind: 'affine' } });
    expectPure(doc, () => execute(doc, 'stretch_body', { id, factor: 2 }));
    expectNoOp(execute(doc, 'stretch_body', { id, factor: 0 }), doc, 'DEF_STRETCH_FACTOR');
    expectNoOp(execute(doc, 'stretch_body', { id, factor: -1 }), doc, 'DEF_STRETCH_FACTOR');
    expectNoOp(execute(doc, 'stretch_body', { id, factor: 1 }), doc, 'DEF_NO_EFFECT');
    expectNoOp(
      execute(doc, 'stretch_body', { id, factor: 2, preserveVolume: true, region: { start: 0, end: 10 } }),
      doc,
      'DEF_PRESERVE_VOLUME_REGION',
    );
  });

  it('bend_body bends a bar onto a circle: Pappus volume, radius / angle / length in any pair', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([10, 10, (Math.PI / 2) * 50]);
    const frame = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] };
    const byAngle = execute(doc, 'bend_body', { id, radius: 50, angleDeg: 90, frame, output: { tolerance: 0.01 } });
    expect(relative(volumeOf(byAngle.document, byAngle.affected[0] as string), 7853.98163397)).toBeLessThan(5e-3);
    expect(meshEntity(byAngle.document, byAngle.affected[0] as string).brep).toMatchObject({ law: { kind: 'bend', radius: 50 } });
    const byLength = execute(doc, 'bend_body', { id, radius: 50, length: (Math.PI / 2) * 50, frame, output: { tolerance: 0.01 } });
    expect(relative(volumeOf(byLength.document, byLength.affected[0] as string), 7853.98163397)).toBeLessThan(5e-3);
    const byRegion = execute(doc, 'bend_body', {
      id,
      angleDeg: 90,
      region: { start: 0, end: (Math.PI / 2) * 50 },
      frame,
      output: { tolerance: 0.01 },
    });
    expect(dataOf<RunData>(byRegion).region).toMatchObject({ start: 0 });
    const symmetric = execute(doc, 'bend_body', { id, radius: 50, angleDeg: 90, symmetric: true, frame, output: { tolerance: 0.01 } });
    expect(relative(volumeOf(symmetric.document, symmetric.affected[0] as string), 7853.98163397)).toBeLessThan(5e-3);
    expectPure(doc, () => execute(doc, 'bend_body', { id, radius: 50, angleDeg: 90 }));
  });

  it('bend_body refuses wrong parameter sets and folds with stable codes', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const frame = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] };
    const refused = (params: Record<string, unknown>, code: string): void => {
      const result = execute(doc, 'bend_body', { id, frame, ...params });
      expectNoOp(result, doc, code);
      expect(result.error?.code).toBe(code);
    };
    refused({ radius: 50 }, 'DEF_BEND_UNDERDETERMINED');
    refused({}, 'DEF_BEND_UNDERDETERMINED');
    refused({ radius: 50, angleDeg: 90, length: 80 }, 'DEF_BEND_OVERDETERMINED');
    refused({ radius: 50, region: { start: 0, end: 40 }, length: 40 }, 'DEF_BEND_OVERDETERMINED');
    refused({ radius: 50, angleDeg: 0 }, 'DEF_NO_EFFECT');
    refused({ radius: 50, length: -3 }, 'DEF_REGION_INVALID');
    refused({ radius: -4, angleDeg: 45 }, 'DEF_BEND_RADIUS_TOO_SMALL');
    refused({ radius: 4, angleDeg: 90 }, 'DEF_BEND_RADIUS_TOO_SMALL');
    refused({ radius: 5, angleDeg: 90 }, 'DEF_BEND_RADIUS_TOO_SMALL');
    refused({ radius: 50, angleDeg: 400 }, 'DEF_SELF_INTERSECTION');
    refused({ radius: 50, angleDeg: 360 }, 'DEF_SELF_INTERSECTION');
    refused({ radius: 50, angleDeg: 359.9999999999 }, 'DEF_SELF_INTERSECTION');
    refused({ radius: 50, region: { start: 1000, end: 1100 } }, 'DEF_REGION_MISSES_BODY');
    expect(execute(doc, 'bend_body', { id, frame, radius: 4, angleDeg: 90 }).summary).toContain('min det J -0.25');
  });

  it('bend_body accepts just under a full turn and refuses a straight tail that runs into the bent part', async () => {
    await installKernel(kind);
    const ring = addBox([10, 10, 2 * Math.PI * 50 * 0.99]);
    const accepted = execute(ring.doc, 'bend_body', {
      id: ring.id,
      radius: 50,
      angleDeg: 356.4,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] },
      output: { tolerance: 0.5 },
    });
    expect(accepted.affected).toHaveLength(1);
    const tail = addBox([10, 10, 300]);
    const refused = execute(tail.doc, 'bend_body', {
      id: tail.id,
      radius: 20,
      angleDeg: 315,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] },
      output: { tolerance: 0.5 },
    });
    expectNoOp(refused, tail.doc, 'DEF_SELF_INTERSECTION');
    expect(refused.summary).toContain('cross itself');
  });

  it('scale_nonuniform scales per axis, mirrors for a negative factor and refuses singular maps', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([10, 20, 30], 'center');
    const scaled = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 0.5] });
    expect(relative(volumeOf(scaled.document, scaled.affected[0] as string), 6000)).toBeLessThan(1e-9);
    const mirrored = execute(doc, 'scale_nonuniform', { id, factors: [-1, 1, 1] });
    expect(relative(volumeOf(mirrored.document, mirrored.affected[0] as string), 6000)).toBeLessThan(1e-9);
    expect(meshEntity(mirrored.document, mirrored.affected[0] as string).brep).toMatchObject({ law: { kind: 'affine' } });
    const about = execute(doc, 'scale_nonuniform', { id, factors: [2, 2, 2], center: [5, 0, 0] });
    expect(relative(volumeOf(about.document, about.affected[0] as string), 48000)).toBeLessThan(1e-9);
    const tilted = execute(doc, 'scale_nonuniform', { id, factors: [1, 1, 3], frame: { axis: [1, 0, 0], reference: [0, 1, 0] } });
    expect(relative(volumeOf(tilted.document, tilted.affected[0] as string), 18000)).toBeLessThan(1e-9);
    const alongX = execute(doc, 'scale_nonuniform', { id, factors: [1, 1, 3], frame: { axis: [1, 0, 0] } });
    expect(meshEntity(alongX.document, alongX.affected[0] as string).brep).toMatchObject({
      frame: { axis: [1, 0, 0], reference: [0, 1, 0] },
    });
    expect(relative(volumeOf(alongX.document, alongX.affected[0] as string), 18000)).toBeLessThan(1e-9);
    expectPure(doc, () => execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1] }));
    expectNoOp(execute(doc, 'scale_nonuniform', { id, factors: [1, 0, 1] }), doc, 'DEF_SCALE_SINGULAR');
    expectNoOp(execute(doc, 'scale_nonuniform', { id, factors: [1, 1, 1] }), doc, 'DEF_NO_EFFECT');
    expectNoOp(execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1], frame: { axis: [0, 0, 0] } }), doc, 'DEF_FRAME_DEGENERATE');
    const singular = execute(doc, 'scale_nonuniform', { id, factors: [1, 0, 1] });
    expect(singular.error).toMatchObject({ code: 'DEF_SCALE_SINGULAR', paths: ['params.factors.1'] });
  });

  it('a deformed body can be deformed again: the recipes chain', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const first = execute(doc, 'stretch_body', { id, factor: 2, preserveVolume: true, frame: WORLD_Z });
    const second = execute(first.document, 'twist_body', { id: first.affected[0] as string, angleDeg: 45, output: { tolerance: 0.05 } });
    expect(second.affected).toHaveLength(1);
    const outer = meshEntity(second.document, second.affected[0] as string).brep;
    expect(outer).toMatchObject({ op: 'deform', law: { kind: 'twist' }, source: { op: 'deform' } });
    expect(relative(volumeOf(second.document, second.affected[0] as string), 10000)).toBeLessThan(5e-3);
    expect(recipeOf(meshEntity(second.document, second.affected[0] as string)).op).toBe('deform');
  });
});

describe('kernel paths', () => {
  it('without a kernel the summary says the result is faceted; mode "exact" refuses', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    const auto = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1] });
    expect(auto.summary).toContain('No geometry kernel is installed');
    expect(dataOf<RunData>(auto)).toMatchObject({ path: 'mesh', kernel: null });
    const exact = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1], output: { mode: 'exact' } });
    expectNoOp(exact, doc, 'no geometry kernel');
    expect(exact.error?.code).toBe('DEF_EXACT_UNAVAILABLE');
  });

  it('Manifold is a mesh kernel: the deform op builds every law, "exact" refuses', async () => {
    await installKernel('manifold');
    const { doc, id } = addBox();
    const result = execute(doc, 'twist_body', { id, angleDeg: 90, frame: WORLD_Z, output: { tolerance: 0.01 } });
    expect(dataOf<RunData>(result)).toMatchObject({ path: 'mesh', kernel: 'manifold' });
    expect(result.summary).toContain('mesh kernel');
    expect(execute(doc, 'twist_body', { id, angleDeg: 90, output: { mode: 'exact' } }).error?.code).toBe('DEF_EXACT_UNAVAILABLE');
    const forced = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1], output: { mode: 'mesh' } });
    expect(dataOf<RunData>(forced).path).toBe('mesh');
  });

  it('an exact kernel builds affine maps exactly and refuses the other laws in "exact" mode; "auto" takes the mesh path and says so', async () => {
    await installKernel('exact');
    const { doc, id } = addBox();
    const scaled = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1], output: { mode: 'exact' } });
    expect(dataOf<RunData>(scaled)).toMatchObject({ path: 'exact', kernel: 'occt', volume: { method: 'exact' } });
    expect(scaled.summary).toContain('exact path');
    const twisted = execute(doc, 'twist_body', { id, angleDeg: 90, frame: WORLD_Z, output: { tolerance: 0.05 } });
    expect(dataOf<RunData>(twisted)).toMatchObject({ path: 'mesh', kernel: 'occt' });
    expect(twisted.summary).toContain('does not build this law exactly');
    const refused = execute(doc, 'twist_body', { id, angleDeg: 90, output: { mode: 'exact' } });
    expectNoOp(refused, doc, 'does not build this deformation exactly');
    expect(refused.error?.code).toBe('DEF_EXACT_UNAVAILABLE');
    const forced = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1], output: { mode: 'mesh' } });
    expect(dataOf<RunData>(forced).path).toBe('mesh');
  });

  it('a kernel that refuses a buildable deformation is reported as DEF_KERNEL_REFUSED', () => {
    const refusing = kernelFromOps<number>({
      solid: () => 1,
      boolean: () => null,
      fillet: () => null,
      blend: () => null,
      chamfer: () => null,
      shell: () => null,
      place: (shape) => shape,
      scale: (shape) => shape,
      deform: () => null,
      tessellate: () => null,
      topology: () => null,
      exportStep: () => null,
      release: () => undefined,
    });
    setGeometryKernel(refusing);
    const { doc, id } = addBox();
    const result = execute(doc, 'twist_body', { id, angleDeg: 30, output: { mode: 'exact', tolerance: 0.1 } });
    expectNoOp(result, doc, 'DEF_KERNEL_REFUSED');
    const fallen = execute(doc, 'twist_body', { id, angleDeg: 30, output: { tolerance: 0.1 } });
    expect(fallen.error, fallen.summary).toBeUndefined();
    expect(fallen.summary).toContain('The exact warp refused (DEF_KERNEL_REFUSED)');
  });

  it('the registry lists the seven deformation tools, schema derived from zod', () => {
    for (const name of [
      'scale_nonuniform',
      'twist_body',
      'taper_body',
      'stretch_body',
      'bend_body',
      'analyze_deformation',
      'check_deformation',
    ]) {
      const command = getCommand(name);
      expect(command, name).toBeDefined();
      expect(command?.annotations?.requiresKernel).toBeUndefined();
    }
    expect(getCommand('analyze_deformation')?.annotations?.readOnly).toBe(true);
    expect(getCommand('check_deformation')?.annotations?.readOnly).toBe(true);
  });

  it('a cylinder is bent into a torus segment whose volume follows Pappus within the source tessellation', async () => {
    await installKernel('manifold');
    const length = (Math.PI / 2) * 50;
    const { doc, id } = addCylinder(5, length);
    const result = execute(doc, 'bend_body', {
      id,
      radius: 50,
      angleDeg: 90,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] },
      output: { tolerance: 0.01 },
    });
    const analysis = dataOf<{ volume: { driftRel: number } }>(
      execute(result.document, 'analyze_deformation', { id: result.affected[0] as string }),
    );
    expect(analysis.volume.driftRel).toBeLessThan(2e-3);
  });
});

describe('bend pre-check looks at the bent region only', () => {
  /** Triangle soup of an axis-aligned box. */
  const boxSoup = (x: number, y: number, z0: number, z1: number): number[] => {
    const c = (i: number, j: number, k: number): number[] => [i ? x : -x, j ? y : -y, k ? z1 : z0];
    const quad = (a: number[], b: number[], d: number[], e: number[]): number[] => [...a, ...b, ...d, ...a, ...d, ...e];
    return [
      ...quad(c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)),
      ...quad(c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)),
      ...quad(c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)),
      ...quad(c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)),
      ...quad(c(1, 1, 0), c(0, 1, 0), c(0, 1, 1), c(1, 1, 1)),
      ...quad(c(0, 1, 0), c(0, 0, 0), c(0, 0, 1), c(0, 1, 1)),
    ];
  };

  it('a wide part outside the bent region does not trigger DEF_BEND_RADIUS_TOO_SMALL', async () => {
    await installKernel('none');
    const body = { positions: [...boxSoup(5, 5, 0, 40), ...boxSoup(20, 20, 60, 100)] };
    const imported = execute(createEmptyDocument(), 'import_mesh', { bodies: [body] });
    const id = imported.affected[0] as string;
    const frame = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] };
    const bent = execute(imported.document, 'bend_body', {
      id,
      radius: 10,
      angleDeg: 60,
      region: { start: 0 },
      frame,
      output: { tolerance: 0.5 },
    });
    expect(bent.error).toBeUndefined();
    expect(bent.affected).toHaveLength(1);
    const whole = execute(imported.document, 'bend_body', {
      id,
      radius: 15,
      region: { start: 60, end: 100 },
      frame,
      output: { tolerance: 0.5 },
    });
    expect(whole.error?.code).toBe('DEF_BEND_RADIUS_TOO_SMALL');
  });
});
