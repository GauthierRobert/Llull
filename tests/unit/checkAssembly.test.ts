/** PHY-21 slice A: check_assembly on the Manifold kernel (VC-FPR-01…08), the review commands, purity and determinism. */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CheckItem, CheckResult } from '@core/model/checkResult';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExecutionContext } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

type Data = CheckResult & { parts: Array<{ id: string; volumeMm3: number }>; skipped2D: number; pairsChecked: number };

const ctxOf = (k: GeometryKernel | null = kernel): ExecutionContext => ({ ...defaultContext(), kernel: k });

/** Doc builder: each call runs one command and remembers the new document. */
function scene(): {
  doc: () => CadDocument;
  run: (name: string, params: Record<string, unknown>) => string;
  check: (params?: Record<string, unknown>) => Data;
} {
  let doc = createEmptyDocument();
  const run = (name: string, params: Record<string, unknown>): string => {
    const result = execute(doc, name, params, ctxOf());
    expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
    doc = result.document;
    return result.affected[0] ?? '';
  };
  const check = (params: Record<string, unknown> = {}): Data => {
    const result = execute(doc, 'check_assembly', params, ctxOf());
    expect(result.data, result.summary).toBeDefined();
    return result.data as Data;
  };
  return { doc: () => doc, run, check };
}

const cube = (position: [number, number, number], side = 20): Record<string, unknown> => ({ size: [side, side, side], position });
const codes = (data: Data): string[] => data.items.map((item) => item.code);
const itemOf = (data: Data, code: string): CheckItem => {
  const found = data.items.find((item) => item.code === code);
  expect(found, `item ${code} in ${codes(data).join(', ')}`).toBeDefined();
  return found as CheckItem;
};

describe('check_assembly pairs (VC-FPR-01…04)', () => {
  it('VC-01: two 20 mm cubes offset 10 mm overlap by 4000 mm3', () => {
    const s = scene();
    const a = s.run('add_box', cube([0, 0, 0]));
    const b = s.run('add_box', cube([10, 0, 0]));
    const data = s.check();
    const hard = itemOf(data, 'FPR_PAIR_HARD');
    expect(hard.status).toBe('fail');
    expect(hard.ids).toEqual([a, b].sort());
    expect(hard.values['overlapVolumeMm3']).toBeCloseTo(4000, 0);
    expect(hard.values['penetrationEstimateMm']).toBeCloseTo(10, 3);
    expect(data.status).toBe('fail');
    expect(data.reviewRequired).toBe(true);
  });

  it('VC-02: cubes sharing a face touch, never hard', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    s.run('add_box', cube([20, 0, 0]));
    const data = s.check();
    const touch = itemOf(data, 'FPR_PAIR_TOUCH');
    expect(touch.status).toBe('info');
    expect(touch.values['overlapVolumeMm3']).toBe(0);
    expect(touch.values['minDistanceMm']).toBeLessThan(1e-6);
    expect(codes(data)).not.toContain('FPR_PAIR_HARD');
  });

  it('VC-03: cubes 0.5 mm apart with clearanceMm 1 give a clearance warning of 0.5 mm', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    s.run('add_box', cube([20.5, 0, 0]));
    const warned = itemOf(s.check({ clearanceMm: 1 }), 'FPR_PAIR_CLEARANCE');
    expect(warned.status).toBe('warn');
    expect(warned.values['minDistanceMm']).toBeCloseTo(0.5, 6);
    expect(codes(s.check())).not.toContain('FPR_PAIR_CLEARANCE');
  });

  it('ring with a 20 mm radial gap to a pin whose bounds overlap is no touch (minGap saturation)', () => {
    const s = scene();
    s.run('revolve_profile', {
      profile: [
        [30, 0],
        [40, 0],
        [40, 50],
        [30, 50],
      ],
    });
    s.run('add_cylinder', { radius: 10, height: 50, position: [0, 0, 25] });
    const data = s.check();
    expect(codes(data)).not.toContain('FPR_PAIR_TOUCH');
    const warned = itemOf(s.check({ clearanceMm: 25 }), 'FPR_PAIR_CLEARANCE');
    expect(warned.values['minDistanceMm']).toBeCloseTo(20, 0);
  });

  it('a gap of 6.5 mm between bounds-overlapping parts is not a touch and a 0.0005 mm gap still is', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0], 20));
    s.run('add_box', cube([26.5, 0, 0], 20));
    expect(codes(s.check())).not.toContain('FPR_PAIR_TOUCH');
    expect(itemOf(s.check({ clearanceMm: 10 }), 'FPR_PAIR_CLEARANCE').values['minDistanceMm']).toBeCloseTo(6.5, 6);
    const t = scene();
    t.run('add_box', cube([0, 0, 0], 20));
    t.run('add_box', cube([20.0005, 0, 0], 20));
    expect(codes(t.check())).toContain('FPR_PAIR_TOUCH');
  });

  it('VC-04: a 10 mm cube centred in a 30 mm cube is containment, 1000 mm3', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0], 30));
    s.run('add_box', cube([0, 0, 0], 10));
    const contained = itemOf(s.check(), 'FPR_PAIR_CONTAINED');
    expect(contained.status).toBe('fail');
    expect(contained.values['overlapVolumeMm3']).toBeCloseTo(1000, 1);
  });

  it('a declared intent turns the overlap into FPR_PAIR_ALLOWED with the reason, and a weld connects the parts', () => {
    const s = scene();
    const a = s.run('add_box', cube([0, 0, 0]));
    const b = s.run('add_box', cube([10, 0, 0]));
    s.run('set_part_grounded', { ids: [a], grounded: true });
    const before = s.check();
    expect(codes(before)).toContain('FPR_PAIR_HARD');
    const intent = s.run('allow_interference', { a: b, b: a, kind: 'weld', reason: 'welded seam' });
    expect(intent).toMatch(/^fit-/);
    const after = s.check();
    const allowed = itemOf(after, 'FPR_PAIR_ALLOWED');
    expect(allowed.status).toBe('pass');
    expect(allowed.intent).toMatchObject({ id: intent, kind: 'weld', reason: 'welded seam', declaredBy: 'agent' });
    expect(codes(after)).not.toContain('FPR_PAIR_HARD');
    expect(after.status).toBe('pass');
  });
});

describe('check_assembly validity and connectivity (VC-FPR-05, 06)', () => {
  it('VC-05: a part made of two disjoint boxes has 2 lumps', () => {
    const s = scene();
    const a = s.run('add_box', cube([0, 0, 0], 10));
    const b = s.run('add_box', cube([30, 0, 0], 10));
    const merged = execute(s.doc(), 'boolean', { op: 'union', a, b }, ctxOf());
    expect(merged.affected).toHaveLength(1);
    const data = execute(merged.document, 'check_assembly', {}, ctxOf()).data as Data;
    const lumps = itemOf(data, 'FPR_PART_DISCONNECTED');
    expect(lumps.values['lumps']).toBe(2);
    expect(lumps.values['lumpVolumeMm3_0']).toBeCloseTo(1000, 2);
    expect(lumps.ids).toEqual([merged.affected[0]]);
  });

  it('VC-06: only the box that is neither fixed, jointed nor touching floats', () => {
    const s = scene();
    const frame = s.run('add_box', cube([0, 0, 0], 20));
    const rotor = s.run('add_cylinder', { radius: 5, height: 10, position: [0, 0, 30] });
    const loose = s.run('add_box', cube([50, 50, 0], 10));
    s.run('add_rigid_body', { entityIds: [frame], fixed: true, id: 'frame' });
    s.run('add_rigid_body', { entityIds: [rotor], id: 'rotor' });
    s.run('add_body_joint', { id: 'shaft', kind: 'revolute', child: 'rotor', anchor: [0, 0, 30], axis: [0, 0, 1] });
    const floating = s.check({ includeJoints: false }).items.filter((item) => item.code === 'FPR_PART_FLOATING');
    expect(floating).toHaveLength(1);
    expect(floating[0]?.ids).toEqual([loose]);
    expect(floating[0]?.status).toBe('fail');
  });

  it('parts held only by touch are resting-only (warn), parts attached by a joint are not', () => {
    const s = scene();
    const base = s.run('add_box', cube([0, 0, 0]));
    const top = s.run('add_box', cube([0, 0, 20]));
    s.run('set_part_grounded', { ids: [base], grounded: true });
    const data = s.check();
    expect(itemOf(data, 'FPR_PART_RESTING_ONLY').ids).toEqual([top]);
    expect(codes(data)).not.toContain('FPR_PART_FLOATING');
  });

  it('a kernel refusal of a part is reported as FPR_PART_INVALID', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    const refusing: GeometryKernel = { ...kernel, evaluate: () => null };
    const result = execute(s.doc(), 'check_assembly', {}, ctxOf(refusing));
    expect((result.data as Data).items.map((item) => item.code)).toContain('FPR_PART_INVALID');
  });
});

describe('check_assembly wall thickness (VC-FPR-07, 08)', () => {
  it('VC-07: a 2 mm plate passes cnc_metal with a sourced, defaulted threshold', () => {
    const s = scene();
    s.run('add_box', { size: [100, 100, 2], position: [0, 0, 0] });
    const wall = itemOf(s.check({ process: 'cnc_metal' }), 'FPR_WALL_THIN');
    expect(wall.status).toBe('pass');
    expect(wall.values['thicknessMm']).toBeCloseTo(2, 1);
    expect(wall.threshold).toMatchObject({ value: 0.794, unit: 'mm', grade: 'B', defaulted: true });
    expect(wall.threshold?.source).toContain('Xometry');
  });

  it('VC-08: a 0.5 mm plate fails FPR_WALL_THIN at 0.50 mm', () => {
    const s = scene();
    s.run('add_box', { size: [100, 100, 0.5], position: [0, 0, 0] });
    const data = s.check({ process: 'cnc_metal' });
    const wall = itemOf(data, 'FPR_WALL_THIN');
    expect(wall.status).toBe('fail');
    expect(wall.values['thicknessMm']).toBeCloseTo(0.5, 2);
    expect(wall.witness?.pointsMm.length).toBeGreaterThan(0);
  });

  it('an explicit minWallMm wins over the process and is not defaulted; no threshold gives an info measurement', () => {
    const s = scene();
    s.run('add_box', { size: [40, 40, 3], position: [0, 0, 0] });
    const explicit = itemOf(s.check({ process: 'sand_cast_steel', minWallMm: 1 }), 'FPR_WALL_THIN');
    expect(explicit.status).toBe('pass');
    expect(explicit.threshold).toMatchObject({ value: 1, defaulted: false });
    const strict = itemOf(s.check({ process: 'sand_cast_steel' }), 'FPR_WALL_THIN');
    expect(strict.status).toBe('fail');
    const measured = itemOf(s.check({ thickness: 'ray' }), 'FPR_WALL_MEASURED');
    expect(measured.status).toBe('info');
    expect(measured.values['thicknessMm']).toBeCloseTo(3, 1);
  });
});

describe('check_assembly envelope, kernels and refusals', () => {
  it('is pure, deterministic, hashed and bounded', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    s.run('add_box', cube([10, 0, 0]));
    const before = JSON.stringify(s.doc());
    const first = execute(s.doc(), 'check_assembly', {}, ctxOf());
    const second = execute(s.doc(), 'check_assembly', {}, ctxOf());
    expect(first.document).toBe(s.doc());
    expect(JSON.stringify(s.doc())).toBe(before);
    expect(first.affected).toEqual([]);
    expect(JSON.stringify(first.data)).toBe(JSON.stringify(second.data));
    const data = first.data as Data;
    expect(data.inputsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(data.provenance.kernel).toBe('manifold');
    expect(data.provenance.tolerances['epsTouchMm']).toBeCloseTo(0.001, 12);
    const moved = execute(s.doc(), 'check_assembly', { clearanceMm: 2 }, ctxOf()).data as Data;
    expect(moved.inputsHash).not.toBe(data.inputsHash);
    expect(first.summary).toContain('not approved');
  });

  it('a kernel without analyze / distance gives not_run FPR_KERNEL_UNSUPPORTED, never a pass', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    s.run('add_box', cube([10, 0, 0]));
    const bare: GeometryKernel = {
      supports: (op) => kernel.supports(op),
      evaluate: (recipe) => kernel.evaluate(recipe),
      tessellate: (shape) => kernel.tessellate(shape),
      topology: (shape) => kernel.topology(shape),
      exportStep: (shapes) => kernel.exportStep(shapes),
    };
    const data = execute(s.doc(), 'check_assembly', {}, ctxOf(bare)).data as Data;
    const unsupported = data.items.filter((item) => item.code === 'FPR_KERNEL_UNSUPPORTED');
    expect(unsupported.length).toBeGreaterThan(0);
    expect(unsupported.every((item) => item.status === 'not_run' && item.unverified === true)).toBe(true);
    expect(data.status).not.toBe('pass');
    expect(data.unverified).toBe(true);
  });

  it('revolute joints on a mesh kernel are fitted to the tessellation: a bare rotor has no bore, so the approximate fit warns', () => {
    const s = scene();
    const frame = s.run('add_box', cube([0, 0, 0]));
    const rotor = s.run('add_cylinder', { radius: 5, height: 10, position: [0, 0, 30] });
    s.run('add_rigid_body', { entityIds: [frame], fixed: true, id: 'frame' });
    s.run('add_rigid_body', { entityIds: [rotor], id: 'rotor' });
    s.run('add_body_joint', { id: 'shaft', kind: 'revolute', child: 'rotor', anchor: [0, 0, 30], axis: [0, 0, 1] });
    const joint = s.check().items.find((item) => item.ids.includes('shaft'));
    expect(joint?.code).toBe('FPR_JOINT_NOT_REALISED');
    expect(joint?.status).toBe('warn');
    expect(joint?.note).toMatch(/approximate/);
  });

  it('without a kernel the registry rejects the call', () => {
    const result = execute(createEmptyDocument(), 'check_assembly', {}, ctxOf(null));
    expect(result.rejected).toBe(true);
  });

  it('skips and counts 2D entities; scope ids, body and component narrow the parts', () => {
    const s = scene();
    const a = s.run('add_box', cube([0, 0, 0]));
    s.run('add_box', cube([100, 0, 0]));
    s.run('draw_rectangle', { width: 5, height: 5 });
    const all = s.check();
    expect(all.skipped2D).toBe(1);
    expect(all.parts).toHaveLength(2);
    expect(s.check({ ids: [a] }).parts.map((part) => part.id)).toEqual([a]);
    expect(all.parts[0]?.volumeMm3).toBeCloseTo(8000, 2);
  });

  it('scope errors are no-ops with a reason', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    for (const params of [{ ids: ['nope'] }, { ids: ['a'], body: 'b' }, { body: 'missing' }]) {
      const result = execute(s.doc(), 'check_assembly', params, ctxOf());
      expect(result.data).toBeUndefined();
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(s.doc());
      expect(result.summary).toMatch(/check_assembly/);
    }
  });

  it('refuses over the ray budget with FPR_BUDGET_EXCEEDED', () => {
    const s = scene();
    for (let k = 0; k < 11; k++) s.run('add_box', cube([k * 100, 0, 0], 10));
    const result = execute(s.doc(), 'check_assembly', { minWallMm: 1, raysPerPart: 20000 }, ctxOf());
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FPR_BUDGET_EXCEEDED');
  });

  it('expands component instances as one part each', () => {
    const s = scene();
    const base = s.run('add_box', cube([0, 0, 0], 10));
    const first = s.run('create_component', { name: 'Block', entityIds: [base], componentId: 'blk' });
    const second = s.run('insert_instance', { componentId: 'blk', position: [5, 0, 0] });
    const data = s.check();
    expect(data.parts.map((part) => part.id)).toEqual([first, second]);
    expect(itemOf(data, 'FPR_PAIR_HARD').ids).toEqual([first, second].sort());
    expect(s.check({ component: 'blk' }).parts).toHaveLength(2);
  });
});

describe('check_assembly connection graph from the document', () => {
  it('kinematic joints, dynamic joints between bodies and weld intents attach parts to the anchors', () => {
    const s = scene();
    const make = (x: number): string => {
      const box = s.run('add_box', cube([x, 0, 0], 10));
      s.run('create_component', { name: `C${x}`, entityIds: [box], componentId: `c${x}` });
      return s.doc().order[s.doc().order.length - 1] ?? '';
    };
    const fixedInstance = make(0);
    const armInstance = make(100);
    s.run('add_joint', { kind: 'revolute', a: { instanceId: fixedInstance }, b: { instanceId: armInstance }, axis: 'z' });
    const connected = s.check();
    expect(codes(connected)).not.toContain('FPR_PART_FLOATING');

    const base = s.run('add_box', cube([200, 0, 0], 10));
    const link = s.run('add_box', cube([300, 0, 0], 10));
    const stud = s.run('add_box', cube([400, 0, 0], 10));
    s.run('add_rigid_body', { entityIds: [base], fixed: true, id: 'base' });
    s.run('add_rigid_body', { entityIds: [link], id: 'link' });
    s.run('add_body_joint', { id: 'elbow', kind: 'revolute', parent: 'base', child: 'link', anchor: [250, 0, 0], axis: [0, 0, 1] });
    expect(
      s
        .check({ includeJoints: false })
        .items.filter((item) => item.code === 'FPR_PART_FLOATING')
        .map((item) => item.ids),
    ).toEqual([[stud]]);
    s.run('allow_interference', { a: stud, b: link, kind: 'thread', reason: 'stud screwed into the link' });
    expect(codes(s.check({ includeJoints: false }))).not.toContain('FPR_PART_FLOATING');
    s.run('allow_interference', { a: base, b: link, kind: 'overlap_by_design', reason: 'cosmetic overlap' });
  });
});

describe('check_assembly with a kernel that reports defects', () => {
  const withAnalysis = (analysis: object | null): GeometryKernel => ({
    supports: (op) => kernel.supports(op),
    evaluate: (recipe) => kernel.evaluate(recipe),
    tessellate: (shape) => kernel.tessellate(shape),
    topology: (shape) => kernel.topology(shape),
    exportStep: (shapes) => kernel.exportStep(shapes),
    analyze: () => analysis as never,
    distance: () => null,
  });
  const base = {
    valid: true,
    status: 'NoError',
    closed: true,
    volume: 8000,
    area: 2400,
    lumps: [{ volume: 8000, area: 2400, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
    freeFaces: 0,
  };
  const codesWith = (analysis: object | null): string[] => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    return (execute(s.doc(), 'check_assembly', { includeJoints: false }, ctxOf(withAnalysis(analysis))).data as Data).items.map(
      (item) => item.code,
    );
  };

  it('maps kernel verdicts to FPR_PART_* codes', () => {
    expect(codesWith({ ...base, valid: false, status: 'NotManifold' })).toContain('FPR_PART_INVALID');
    expect(codesWith({ ...base, volume: 0 })).toContain('FPR_PART_EMPTY');
    expect(codesWith({ ...base, freeFaces: 2 })).toContain('FPR_PART_SHEET');
    expect(codesWith({ ...base, volume: 1, area: 2400 })).toContain('FPR_PART_SHEET');
    expect(codesWith(base)).toEqual(['FPR_PART_FLOATING']);
    expect(codesWith(null)).toContain('FPR_KERNEL_UNSUPPORTED');
  });

  it('a pair whose distance the kernel cannot give is not_run, not a pass', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    s.run('add_box', cube([10, 0, 0]));
    const data = execute(s.doc(), 'check_assembly', { includeJoints: false }, ctxOf(withAnalysis(base))).data as Data;
    expect(data.items.some((item) => item.code === 'FPR_KERNEL_UNSUPPORTED' && item.status === 'not_run')).toBe(true);
  });
});
