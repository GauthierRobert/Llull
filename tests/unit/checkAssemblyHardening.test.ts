/** check_assembly review fixes: kernel failures are never hidden, scope handling, emptiness, budgets, stale references, nesting. */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CheckItem, CheckResult } from '@core/model/checkResult';
import type { GeometryKernel } from '@core/geometry/kernel';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

type Data = CheckResult & { parts: Array<{ id: string; volumeMm3: number }> };

const ctxOf = (k: GeometryKernel = kernel): ExecutionContext => ({ ...defaultContext(), kernel: k });

interface Scene {
  doc: () => CadDocument;
  run: (name: string, params: Record<string, unknown>) => string;
  check: (params?: Record<string, unknown>, k?: GeometryKernel) => Data;
}

function scene(): Scene {
  let doc = createEmptyDocument();
  return {
    doc: () => doc,
    run: (name, params) => {
      const result = execute(doc, name, params, ctxOf());
      expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
      doc = result.document;
      return result.affected[0] ?? '';
    },
    check: (params = {}, k = kernel) => {
      const result = execute(doc, 'check_assembly', params, ctxOf(k));
      expect(result.data, result.summary).toBeDefined();
      return result.data as Data;
    },
  };
}

const cube = (position: [number, number, number], side = 20): Record<string, unknown> => ({ size: [side, side, side], position });
const codes = (data: Data): string[] => data.items.map((item) => item.code);
const itemOf = (data: Data, code: string): CheckItem => {
  const found = data.items.find((item) => item.code === code);
  expect(found, `item ${code} in ${codes(data).join(', ')}`).toBeDefined();
  return found as CheckItem;
};

const wrapped = (patch: Partial<GeometryKernel>): GeometryKernel => ({
  supports: (op) => kernel.supports(op),
  evaluate: (recipe) => kernel.evaluate(recipe),
  tessellate: (shape) => kernel.tessellate(shape),
  topology: (shape) => kernel.topology(shape),
  exportStep: (shapes) => kernel.exportStep(shapes),
  analyze: (shape) => kernel.analyze?.(shape) ?? null,
  distance: (a, b, max) => kernel.distance?.(a, b, max) ?? null,
  ...patch,
});

describe('check_assembly never hides a kernel failure', () => {
  const overlapping = (): Scene => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    s.run('add_box', cube([10, 0, 0]));
    return s;
  };

  it('an intersect the kernel cannot evaluate gives not_run, not touch', () => {
    const broken = wrapped({
      evaluate: (recipe) => (recipe.op === 'boolean' && recipe.boolean === 'intersect' ? null : kernel.evaluate(recipe)),
    });
    const data = overlapping().check({ includeJoints: false }, broken);
    expect(codes(data)).toContain('FPR_KERNEL_UNSUPPORTED');
    expect(codes(data)).not.toContain('FPR_PAIR_TOUCH');
    expect(codes(data)).not.toContain('FPR_PAIR_HARD');
    expect(data.status).not.toBe('pass');
  });

  it('an invalid intersect result gives not_run', () => {
    let calls = 0;
    const invalid = wrapped({
      analyze: (shape) => {
        const real = kernel.analyze?.(shape) ?? null;
        calls++;
        return calls > 2 && real !== null ? { ...real, valid: false, volume: 0 } : real;
      },
    });
    const data = overlapping().check({ includeJoints: false }, invalid);
    expect(codes(data)).toContain('FPR_KERNEL_UNSUPPORTED');
    expect(codes(data)).not.toContain('FPR_PAIR_TOUCH');
  });

  it('a part the kernel cannot analyze makes its pairs not_run (no false containment)', () => {
    let first = true;
    const partial = wrapped({
      analyze: (shape) => {
        if (!first) return kernel.analyze?.(shape) ?? null;
        first = false;
        return null;
      },
    });
    const data = overlapping().check({ includeJoints: false }, partial);
    expect(codes(data)).toContain('FPR_KERNEL_UNSUPPORTED');
    expect(codes(data)).not.toContain('FPR_PAIR_CONTAINED');
    expect(data.status).not.toBe('pass');
  });

  it('thickness with a threshold but no sample hit is not_run', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    const open = wrapped({ tessellate: () => ({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }) });
    const data = s.check({ minWallMm: 1, includeJoints: false }, open);
    expect(data.items.find((item) => item.code === 'FPR_WALL_THIN')?.status).toBe('not_run');
    expect(data.unverified).toBe(true);
  });

  it('an area-0 analysis is not a sheet by the 2V/A proxy', () => {
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    const zeroArea = wrapped({
      analyze: () => ({
        valid: true,
        status: 'NoError',
        closed: true,
        volume: 8000,
        area: 0,
        lumps: [{ volume: 8000, area: 0, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
        freeFaces: 0,
      }),
    });
    expect(codes(s.check({ includeJoints: false }, zeroArea))).not.toContain('FPR_PART_SHEET');
  });
});

describe('check_assembly scope, emptiness, budgets and references', () => {
  it('an empty document or a 2D-only scope is never a pass', () => {
    const empty = execute(createEmptyDocument(), 'check_assembly', {}, ctxOf()).data as Data;
    expect(codes(empty)).toEqual(['FPR_NO_PARTS']);
    expect(empty.status).toBe('not_run');
    expect(empty.unverified).toBe(true);
    const s = scene();
    s.run('add_box', cube([0, 0, 0]));
    const flat = s.run('draw_rectangle', { width: 5, height: 5 });
    const only2D = s.check({ ids: [flat] });
    expect(codes(only2D)).toEqual(['FPR_NO_PARTS']);
    expect(only2D.status).not.toBe('pass');
  });

  it('a pin welded to an out-of-scope grounded frame is attached; a scoped run reports only its own items', () => {
    const s = scene();
    const frame = s.run('add_box', cube([0, 0, 0], 20));
    const pin = s.run('add_box', cube([100, 0, 0], 20));
    const stray = s.run('add_box', cube([300, 0, 0], 20));
    s.run('set_part_grounded', { ids: [frame], grounded: true });
    s.run('allow_interference', { a: pin, b: frame, kind: 'weld', reason: 'welded' });
    expect(codes(s.check({ ids: [pin] }))).not.toContain('FPR_PART_FLOATING');
    const strayScoped = s.check({ ids: [stray] });
    expect(strayScoped.items.map((item) => [item.code, item.ids])).toEqual([['FPR_PART_FLOATING', [stray]]]);
    expect(s.check({ ids: [pin] }).parts.map((part) => part.id)).toEqual([pin]);
  });

  it('contact with an out-of-scope grounded part is a (weak) connection for the scope', () => {
    const s = scene();
    const base = s.run('add_box', cube([0, 0, 0]));
    const top = s.run('add_box', cube([0, 0, 20]));
    s.run('set_part_grounded', { ids: [base], grounded: true });
    const data = s.check({ ids: [top] });
    expect(codes(data)).toContain('FPR_PART_RESTING_ONLY');
    expect(codes(data)).not.toContain('FPR_PART_FLOATING');
  });

  it('a scoped run only reports the joints of its bodies', () => {
    const s = scene();
    const a = s.run('add_box', cube([0, 0, 0]));
    const b = s.run('add_cylinder', { radius: 3, height: 10, position: [0, 0, 40] });
    const c = s.run('add_box', cube([200, 0, 0]));
    s.run('add_rigid_body', { entityIds: [a], fixed: true, id: 'fa' });
    s.run('add_rigid_body', { entityIds: [b], id: 'rb' });
    s.run('add_rigid_body', { entityIds: [c], id: 'rc' });
    s.run('add_body_joint', { id: 'j1', kind: 'revolute', parent: 'fa', child: 'rb', anchor: [0, 0, 40], axis: [0, 0, 1] });
    s.run('add_body_joint', { id: 'j2', kind: 'revolute', child: 'rc', anchor: [200, 0, 0], axis: [0, 0, 1] });
    const joints = (data: Data): string[] => data.items.filter((item) => /^j\d$/.test(item.ids[0] ?? '')).map((item) => item.ids[0] ?? '');
    expect(joints(s.check({ body: 'rb' }))).toEqual(['j1']);
    expect(joints(s.check())).toEqual(['j1', 'j2']);
  });

  it('refuses over the part budget before evaluating anything', () => {
    const s = scene();
    for (let k = 0; k < 501; k++) s.run('add_box', cube([k * 30, 0, 0], 10));
    let evaluations = 0;
    const spy = wrapped({ evaluate: (recipe) => (evaluations++, kernel.evaluate(recipe)) });
    const result = execute(s.doc(), 'check_assembly', {}, ctxOf(spy));
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FPR_BUDGET_EXCEEDED');
    expect(evaluations).toBe(0);
  }, 60_000);

  it('reports intents and grounded ids of deleted entities as an info item instead of failing', () => {
    const s = scene();
    const a = s.run('add_box', cube([0, 0, 0]));
    const b = s.run('add_box', cube([100, 0, 0]));
    s.run('set_part_grounded', { ids: [a], grounded: true });
    s.run('allow_interference', { a, b, kind: 'weld', reason: 'weld' });
    s.run('delete_entities', { ids: [a] });
    const stale = itemOf(s.check(), 'FPR_STALE_REFERENCE');
    expect(stale.status).toBe('info');
    expect(stale.ids).toEqual([a]);
  });

  it('expands nested instances into one part and flags an unbuildable instance as empty, not invalid', () => {
    const s = scene();
    const box = s.run('add_box', cube([0, 0, 0], 10));
    const inner = s.run('create_component', { name: 'Inner', entityIds: [box], componentId: 'inner' });
    const outer = s.run('create_component', { name: 'Outer', entityIds: [inner], componentId: 'outer' });
    const data = s.check();
    expect(data.parts.map((part) => part.id)).toEqual([outer]);
    expect(data.parts[0]?.volumeMm3).toBeCloseTo(1000, 2);
    expect(codes(data)).not.toContain('FPR_PART_INVALID');
    const missing = execute({ ...s.doc(), components: {} }, 'check_assembly', {}, ctxOf()).data as Data;
    expect(itemOf(missing, 'FPR_PART_EMPTY').ids).toEqual([outer]);
    expect(codes(missing)).not.toContain('FPR_PART_INVALID');
  });

  it('the input hash does not depend on key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }));
  });
});
