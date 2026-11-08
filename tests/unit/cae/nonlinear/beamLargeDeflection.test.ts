/**
 * beam_large_deflection against the committed PHY-05 oracle (docs/physics/05-nonlinear-structural/validation): the generator's Lee frame path
 * (lee_frame_path.csv, 20 elements per leg, same algorithm -> 1e-6), the NL7 reference values (VC-NLS-20) and the elastica closed form
 * (VC-NLS-10, with the generator's corotational cross-check).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

const PACK = 'docs/physics/05-nonlinear-structural/validation';
const LEE = JSON.parse(readFileSync(`${PACK}/plans/nls_lee_frame.query.json`, 'utf8')) as Record<string, unknown>;
const EXPECTED = new Map(
  (JSON.parse(readFileSync(`${PACK}/expected_results.json`, 'utf8')) as { cases: { id: string; [key: string]: unknown }[] }).cases.map(
    (entry) => [entry.id, entry],
  ),
);
const expected = (id: string): Record<string, unknown> => EXPECTED.get(id) ?? {};
const valueOf = (id: string): number => Number(expected(id)['value']);

interface PathEntry {
  readonly step: number;
  readonly loadFactor: number;
  readonly u: { readonly ux?: number; readonly uy?: number; readonly rz?: number };
}
interface BeamData {
  readonly converged: boolean;
  readonly stopCode?: string;
  readonly stoppedBy: string;
  readonly steps: number;
  readonly every: number;
  readonly thinned: boolean;
  readonly path: readonly PathEntry[];
  readonly limitPoints: readonly {
    kind: string;
    step: number;
    loadFactor: number;
    refined: { loadFactor: number; dof: string; displacement: number } | null;
  }[];
  readonly snapBack: boolean;
  readonly reviewRequired: boolean;
}

const doc = createEmptyDocument();
const run = (params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, 'beam_large_deflection', params);
const dataOf = (params: Record<string, unknown>): BeamData => {
  const result = run(params);
  expect(result.error, result.summary).toBeUndefined();
  return result.data as BeamData;
};
const relative = (value: number, reference: number): number => Math.abs(value / reference - 1);

/** NL7 normalisation: P L^2 / (E I) = load factor x 120^2 / (720 x 2); v / L downwards. */
const NORM = (120 * 120) / (720 * 2);

describe('beam_large_deflection: NAFEMS NL7 Lee frame (VC-NLS-20)', () => {
  const lee = dataOf(LEE);
  const full = dataOf({ ...LEE, report: { node: 'P', dofs: ['ux', 'uy'], every: 1 } });

  it('reproduces the generator path (lee_frame_path.csv, same algorithm) to 1e-6 at every stored step', () => {
    const rows = readFileSync(`${PACK}/lee_frame_path.csv`, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(',').map(Number));
    expect(lee.steps).toBe(rows.at(-1)?.[0]);
    const byStep = new Map(lee.path.map((entry) => [entry.step, entry]));
    let compared = 0;
    for (const [step = -1, load = 0, vDown = 0, u = 0] of rows) {
      const entry = byStep.get(step);
      expect(entry, `step ${step}`).toBeDefined();
      if (entry === undefined) continue;
      const scale = (reference: number): number => Math.max(Math.abs(reference), 1e-3);
      expect(Math.abs(entry.loadFactor * NORM - load) / scale(load)).toBeLessThan(1e-6);
      expect(Math.abs(-(entry.u.uy ?? 0) / 120 - vDown) / scale(vDown)).toBeLessThan(1e-6);
      expect(Math.abs((entry.u.ux ?? 0) / 120 - u) / scale(u)).toBeLessThan(1e-6);
      compared++;
    }
    expect(compared).toBe(rows.length);
    expect(lee.every).toBe(5);
  });

  it('finds the first limit load 18.55 (1 %) at v/L 0.407 (+-0.004), as the generator at 20 elements per leg', () => {
    const first = lee.limitPoints.find((point) => point.kind === 'max');
    expect(first?.refined?.dof).toBe('uy');
    const peak = (first?.refined?.loadFactor ?? 0) * NORM;
    const vAtPeak = -(first?.refined?.displacement ?? 0) / 120;
    expect(relative(peak, valueOf('VC-NLS-20.a'))).toBeLessThan(0.01);
    expect(Math.abs(vAtPeak - valueOf('VC-NLS-20.b'))).toBeLessThan(0.004);
    const study = (expected('VC-NLS-20.a')['meshStudy'] as Record<string, { peak: number; vAtPeak: number }>)['20'];
    expect(relative(peak, study?.peak ?? 0)).toBeLessThan(1e-6);
    expect(relative(vAtPeak, study?.vAtPeak ?? 0)).toBeLessThan(1e-6);
  });

  it('passes the snap-back branch: v/L 0.781 (+-0.004) where the load climbs back to 31.89, minimum load -9.427 (3 %)', () => {
    const points = full.path.map((entry) => [entry.loadFactor * NORM, -(entry.u.uy ?? 0) / 120] as const);
    let vAt3189 = Number.NaN;
    for (let k = 0; k + 1 < points.length; k++) {
      const [p0 = 0, v0 = 0] = points[k] ?? [];
      const [p1 = 0, v1 = 0] = points[k + 1] ?? [];
      if (v0 > 0.6 && p0 < 31.89 && 31.89 <= p1) vAt3189 = v0 + ((31.89 - p0) / (p1 - p0)) * (v1 - v0);
    }
    expect(Math.abs(vAt3189 - valueOf('VC-NLS-20.c'))).toBeLessThan(0.004);
    const minimum = Math.min(...points.map(([load]) => load));
    expect(relative(minimum, valueOf('VC-NLS-20.d'))).toBeLessThan(0.03);
    expect(relative(minimum, (expected('VC-NLS-20.d')['meshStudy'] as Record<string, number>)['20'] ?? 0)).toBeLessThan(1e-6);
    expect(full.snapBack).toBe(true);
    expect(full.limitPoints.map((point) => point.kind).slice(0, 2)).toEqual(['max', 'min']);
    expect(full.stoppedBy).toBe('stopped');
    expect(full.reviewRequired).toBe(true);
  });
});

describe('beam_large_deflection: elastica cantilever (VC-NLS-10)', () => {
  const cantilever = {
    units: { length: 'm', force: 'N' },
    nodes: [
      { id: 'root', x: 0, y: 0 },
      { id: 'tip', x: 1, y: 0 },
    ],
    members: [{ from: 'root', to: 'tip', E: 1, A: 1e6, I: 1, elements: 20 }],
    supports: [{ node: 'root', ux: true, uy: true, rz: true }],
    referenceLoad: [{ node: 'tip', fy: -1 }],
    control: { kind: 'load', increments: 400, maxFactor: 10 },
    report: { node: 'tip', dofs: ['ux', 'uy', 'rz'] },
  };

  it('matches the elliptic closed form (1 %, 2 % for the shortening) and the generator corotational cross-check (1e-6)', () => {
    const data = dataOf(cantilever);
    expect(data.converged).toBe(true);
    expect(data.snapBack).toBe(false);
    expect(data.limitPoints).toEqual([]);
    const at = (lambda: number): PathEntry | undefined => data.path.find((entry) => Math.abs(entry.loadFactor - lambda) < 1e-12);
    for (const [id, lambda] of [
      ['VC-NLS-10.a', 1],
      ['VC-NLS-10.b', 2],
      ['VC-NLS-10.c', 10],
    ] as const) {
      const dv = -(at(lambda)?.u.uy ?? 0);
      expect(relative(dv, valueOf(id)), id).toBeLessThan(0.01);
      expect(relative(dv, Number((expected(id)['crossCheck'] as Record<string, number>)['corotational20'])), id).toBeLessThan(1e-6);
    }
    const dh = -(at(2)?.u.ux ?? 0);
    expect(relative(dh, valueOf('VC-NLS-10.d'))).toBeLessThan(0.02);
    expect(relative(dh, Number((expected('VC-NLS-10.d')['crossCheck'] as Record<string, number>)['corotational20']))).toBeLessThan(1e-6);
  });

  it('stops on a displacement rule and on a load-factor rule, thins long paths, and is a pure query', () => {
    const before = JSON.stringify(doc);
    const stopped = dataOf({ ...cantilever, stop: { node: 'tip', dof: 'uy', maxAbsDisplacement: 0.3 } });
    expect(stopped.stoppedBy).toBe('stopped');
    expect(Math.abs(stopped.path.at(-1)?.u.uy ?? 0)).toBeGreaterThan(0.3);
    expect(Math.abs(stopped.path.at(-2)?.u.uy ?? 0)).toBeLessThanOrEqual(0.3);
    const capped = dataOf({ ...cantilever, stop: { maxLoadFactor: 2 } });
    expect(capped.path.at(-1)?.loadFactor).toBeCloseTo(2.025, 12);
    const long = dataOf({
      ...cantilever,
      control: { kind: 'load', increments: 4500, maxFactor: 1 },
      report: { node: 'tip', dofs: ['uy'] },
    });
    expect(long.every).toBe(3);
    expect(long.thinned).toBe(true);
    expect(long.path.length).toBeLessThanOrEqual(2000);
    expect(long.path.at(-1)?.step).toBe(4500);
    expect(JSON.stringify(doc)).toBe(before);
    expect(run(cantilever).document).toBe(doc);
  });

  it('returns the path so far with NLS_NOT_CONVERGED when load control cannot pass the Lee frame limit point', () => {
    const result = run({ ...LEE, control: { kind: 'load', increments: 30, maxFactor: 3 } });
    const data = result.data as BeamData;
    expect(data.converged).toBe(false);
    expect(data.stopCode).toBe('NLS_NOT_CONVERGED');
    expect(data.path.at(-1)?.loadFactor ?? 0).toBeLessThan(1.86);
    expect(data.path.at(-1)?.loadFactor ?? 0).toBeGreaterThan(1.7);
    expect(result.summary).toContain('NLS_NOT_CONVERGED');
  });
});

describe('beam_large_deflection refusals', () => {
  const base = LEE;
  const code = (patch: Record<string, unknown>): string | undefined => run({ ...base, ...patch }).error?.code;

  it('names invalid frames NLS_FRAME_INVALID and leaves the document unchanged', () => {
    const nodes = base['nodes'] as { id: string; x: number; y: number }[];
    const members = base['members'] as Record<string, unknown>[];
    expect(code({ nodes: [...nodes, { id: 'A', x: 5, y: 5 }] })).toBe('NLS_FRAME_INVALID');
    expect(code({ nodes: [...nodes, { id: 'Z', x: 5, y: 5 }] })).toBe('NLS_FRAME_INVALID');
    expect(code({ members: [{ ...members[0], to: 'ghost' }, ...members.slice(1)] })).toBe('NLS_FRAME_INVALID');
    expect(code({ members: [{ ...members[0], to: 'A' }, ...members.slice(1)] })).toBe('NLS_FRAME_INVALID');
    expect(code({ members: [{ ...members[0], I: 0 }, ...members.slice(1)] })).toBe('NLS_FRAME_INVALID');
    expect(code({ nodes: nodes.map((node) => (node.id === 'B' ? { ...node, x: 0, y: 0 } : node)) })).toBe('NLS_FRAME_INVALID');
    expect(code({ members: [...members, ...members].map((member) => ({ ...member, elements: 1000 })) })).toBe('NLS_FRAME_INVALID');
    expect(code({ supports: [{ node: 'ghost', ux: true }] })).toBe('NLS_FRAME_INVALID');
    expect(code({ referenceLoad: [{ node: 'P', fy: 0 }] })).toBe('NLS_FRAME_INVALID');
    expect(code({ referenceLoad: [{ node: 'ghost', fy: 1 }] })).toBe('NLS_FRAME_INVALID');
    expect(code({ control: { kind: 'arc_length', arcLength: 0, maxSteps: 10 } })).toBe('NLS_FRAME_INVALID');
    expect(code({ control: { kind: 'load', increments: 10, maxFactor: 0 } })).toBe('NLS_FRAME_INVALID');
    expect(
      code({ control: { kind: 'arc_length', arcLength: 1, maxSteps: 100000 }, members: members.map((m) => ({ ...m, elements: 300 })) }),
    ).toBe('NLS_FRAME_INVALID');
    expect(code({ stop: { maxLoadFactor: -1 } })).toBe('NLS_FRAME_INVALID');
    expect(code({ stop: { node: 'P', maxAbsDisplacement: 1 } })).toBe('NLS_FRAME_INVALID');
    expect(code({ report: { node: 'ghost', dofs: ['uy'] } })).toBe('NLS_FRAME_INVALID');
    expect(code({ report: { node: 'P', dofs: ['uy', 'uy'] } })).toBe('NLS_FRAME_INVALID');
    const refused = run({ ...base, referenceLoad: [{ node: 'P', fy: 0 }] });
    expect(refused.document).toBe(doc);
    expect(refused.error?.paths).toEqual(['referenceLoad']);
  });

  it('refuses a mechanism (supports that leave a rigid-body motion) with NLS_NOT_CONVERGED', () => {
    const refused = run({ ...base, supports: [{ node: 'A', ux: true, uy: true }] });
    expect(refused.error?.code).toBe('NLS_NOT_CONVERGED');
    expect(refused.summary).toContain('rigid-body motion');
    const pinnedCantilever = run({
      units: { length: 'm', force: 'N' },
      nodes: [
        { id: 'root', x: 0, y: 0 },
        { id: 'tip', x: 1, y: 0 },
      ],
      members: [{ from: 'root', to: 'tip', E: 1, A: 1e6, I: 1, elements: 4 }],
      supports: [{ node: 'root', ux: true, uy: true }],
      referenceLoad: [{ node: 'tip', fy: -1 }],
      control: { kind: 'load', increments: 10, maxFactor: 1 },
      report: { node: 'tip', dofs: ['uy'] },
    });
    expect(pinnedCantilever.error?.code).toBe('NLS_NOT_CONVERGED');
  });

  it('converges on a fine frame (1000 elements) where rounding keeps the residual above the absolute tolerance', () => {
    const members = (base['members'] as { elements: number }[]).map((member) => ({ ...member, elements: member.elements * 25 }));
    const data = dataOf({ ...base, members, control: { kind: 'arc_length', arcLength: 1, maxSteps: 20 } });
    expect(data.converged).toBe(true);
    expect(data.steps).toBe(20);
  });
});
