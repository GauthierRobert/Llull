/**
 * The pack's own plans (docs/design/05-implicit-lattice/validation/plans) run step by step through `execute` (VC-IMP-05, 15, 22, 23, 24, 40). Voxels are coarsened where the plan's value exceeds the TS engine's 2^21-sample budget; the
 * native engine runs them as written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';

const PLANS = join(import.meta.dirname, '..', '..', '..', 'docs', 'design', '05-implicit-lattice', 'validation', 'plans');

interface PlanStep {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}

const readPlan = (name: string): PlanStep[] => JSON.parse(readFileSync(join(PLANS, `${name}.json`), 'utf8')) as PlanStep[];

const substitute = (value: unknown, ids: Map<string, string>): unknown => {
  if (typeof value === 'string' && value.startsWith('$')) return ids.get(value.slice(1)) ?? value;
  if (Array.isArray(value)) return value.map((item) => substitute(item, ids));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, ids)]));
  return value;
};

interface Outcome {
  readonly command: string;
  readonly result: CommandResult;
}

/** Run a plan; `override` rewrites the params of a command (by name) before it runs. */
function runPlan(name: string, override: Record<string, Record<string, unknown>> = {}): { doc: CadDocument; steps: Outcome[] } {
  let doc = createEmptyDocument();
  const ids = new Map<string, string>();
  const steps: Outcome[] = [];
  for (const step of readPlan(name)) {
    const params = { ...(substitute(step.params, ids) as Record<string, unknown>), ...(override[step.command] ?? {}) };
    const result = execute(doc, step.command, params);
    doc = result.document;
    if (step.as !== undefined && result.affected[0] !== undefined) ids.set(step.as, result.affected[0]);
    steps.push({ command: step.command, result });
  }
  return { doc, steps };
}

const data = (outcome: Outcome | undefined): Record<string, unknown> => (outcome?.result.data ?? {}) as Record<string, unknown>;
const stepOf = (steps: Outcome[], command: string): Outcome | undefined => steps.find((step) => step.command === command);

describe('target_smooth_union_corner (VC-IMP-05)', () => {
  it('has the analytic volume and tangent points', () => {
    const { steps } = runPlan('target_smooth_union_corner', { create_implicit_body: { voxel: 0.15 } });
    expect(steps.filter((s) => s.result.error !== undefined).map((s) => s.command)).toEqual([]);
    const volume = data(stepOf(steps, 'implicit_properties'))['volume'] as number;
    expect(Math.abs(volume - 1446.6667) / 1446.6667).toBeLessThan(0.001);
    for (const v of data(stepOf(steps, 'evaluate_field'))['values'] as number[]) expect(Math.abs(v)).toBeLessThan(1e-9);
  });
});

describe('target_shell_gyroid_infill (VC-IMP-22)', () => {
  it('has V = 40672 mm3 by field quadrature, hides the source box and reports the findings', () => {
    const { doc, steps } = runPlan('target_shell_gyroid_infill', { create_implicit_body: { voxel: 1 }, implicit_properties: { voxel: 1 } });
    expect(steps.filter((s) => s.result.error !== undefined).map((s) => `${s.command}: ${s.result.summary}`)).toEqual([]);
    const props = data(stepOf(steps, 'implicit_properties'));
    expect(Math.abs((props['volumeQuadrature'] as number) - 40672) / 40672).toBeLessThan(0.002);
    expect(Math.abs((props['volume'] as number) - 40672) / 40672).toBeLessThan(0.05);
    expect((props['errorEstimate'] as { value: number }).value).toBeGreaterThan(0);
    const check = data(stepOf(steps, 'check_implicit'));
    expect(check['limits']).toEqual([
      { name: 'minWallMm', value: 0.4, unit: 'mm', source: 'owner-supplied', defaulted: false },
      { name: 'minPoreMm', value: 1, unit: 'mm', source: 'owner-supplied', defaulted: false },
    ]);
    expect((check['findings'] as Array<{ code: string }>).map((f) => f.code)).toContain('IMP_TRAPPED_VOID');
    const hidden = Object.values(doc.entities).filter((e) => e.layerId === 'layer-implicit-hidden');
    expect(hidden).toHaveLength(1);
    expect(stepOf(steps, 'export_3mf')?.result.error).toBeUndefined();
  });
});

describe('target_sc_strut_lattice_cell (VC-IMP-15, 30)', () => {
  it('realises the simple-cubic cell: 82.934 mm3 by quadrature, 8 nodes and 12 beams', () => {
    const { steps } = runPlan('target_sc_strut_lattice_cell', { create_implicit_body: { voxel: 0.2 } });
    expect(steps.filter((s) => s.result.error !== undefined).map((s) => s.command)).toEqual([]);
    expect(Math.abs((data(stepOf(steps, 'implicit_properties'))['volumeQuadrature'] as number) - 82.93407) / 82.93407).toBeLessThan(0.005);
    expect(data(stepOf(steps, 'lattice_properties'))).toMatchObject({ nodes: 8, beams: 12, cells: 1 });
  });
});

describe('target_cylindrical_gyroid_sleeve (VC-IMP-25)', () => {
  it('builds a closed sleeve inside its region', () => {
    const { steps } = runPlan('target_cylindrical_gyroid_sleeve', {
      create_implicit_body: { voxel: 1 },
      implicit_properties: { voxel: 1 },
    });
    expect(steps.filter((s) => s.result.error !== undefined).map((s) => `${s.command}: ${s.result.summary}`)).toEqual([]);
    expect(data(stepOf(steps, 'create_implicit_body'))['closedManifold']).toBe(true);
  });
});

describe('target_errors (VC-IMP-40)', () => {
  it('refuses with the stable codes in order, and the okay step succeeds', () => {
    const { steps } = runPlan('target_errors');
    expect(steps.map((s) => s.result.error?.code ?? 'ok')).toEqual([
      'IMP_TPMS_CONTROL_RANGE',
      'IMP_STRUT_RADIUS_RANGE',
      'IMP_MAP_SEAM',
      'ok',
      'IMP_GRID_BUDGET',
      'IMP_FIELD_NOT_FOUND',
    ]);
  });
});

describe('target_graded_gyroid_column (VC-IMP-24)', () => {
  it('has the quadrature density 0.40438 and a wall from 0.5 to 2.5 mm', () => {
    const { steps } = runPlan('target_graded_gyroid_column', {
      create_implicit_body: { voxel: 0.5 },
      implicit_properties: { voxel: 0.25 },
    });
    expect(steps.filter((s) => s.result.error !== undefined).map((s) => `${s.command}: ${s.result.summary}`)).toEqual([]);
    const density = data(stepOf(steps, 'implicit_properties'))['relativeDensity'] as number;
    expect(Math.abs(density - 0.40438) / 0.40438).toBeLessThan(0.005);
    const lattice = data(stepOf(steps, 'lattice_properties'));
    expect(Math.abs((lattice['thicknessMin'] as number) - 0.5)).toBeLessThan(0.02);
    expect(Math.abs((lattice['thicknessMax'] as number) - 2.5)).toBeLessThan(0.02);
    expect(data(stepOf(steps, 'create_implicit_body'))['closedManifold']).toBe(true);
  }, 120_000);
});

describe('target_infill_solid_box (VC-IMP-23)', () => {
  it('lightens the 40 mm box to the analytic volume 40672 mm3', () => {
    const { steps } = runPlan('target_infill_solid_box', { infill_solid: { voxel: 0.5 } });
    expect(steps.filter((s) => s.result.error !== undefined).map((s) => `${s.command}: ${s.result.summary}`)).toEqual([]);
    const properties = data(stepOf(steps, 'implicit_properties'));
    expect(Math.abs((properties['volume'] as number) - 40672) / 40672).toBeLessThan(0.01);
    expect(Math.abs((properties['volumeQuadrature'] as number) - 40672) / 40672).toBeLessThan(0.005);
    const infill = data(stepOf(steps, 'infill_solid'));
    expect(infill['lighterFraction']).toBeGreaterThan(0.3);
  }, 180_000);
});
