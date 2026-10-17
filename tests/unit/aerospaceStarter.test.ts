// The aerospace starter plan (UAV propulsion pod) replays on the default (Manifold) kernel exactly as the UI dispatches it, and the
// document it builds carries every engineering slice: materials, sheet metal, machined features, fasteners, dynamics, FE cases, sheet.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { aerospaceStarterActions } from '@ui/actions/aerospacePlan';

const catalog: unknown = JSON.parse(readFileSync('public/samples/aero-fastener-catalog.json', 'utf8'));

interface PlanReport {
  readonly ok: boolean;
  readonly aliases: Readonly<Record<string, string | readonly string[]>>;
}

let previousKernel: GeometryKernel | null;
let doc: CadDocument;
let report: PlanReport;

beforeAll(async () => {
  previousKernel = getGeometryKernel();
  setGeometryKernel(await createManifoldKernel());
  const result = execute(createEmptyDocument(), 'build_project', { actions: aerospaceStarterActions(catalog) });
  doc = result.document;
  report = result.data as PlanReport;
}, 120_000);

afterAll(() => setGeometryKernel(previousKernel));

const alias = (name: string): string => {
  const value = report.aliases[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
};

describe('aerospace starter plan', () => {
  it('applies every step', () => {
    expect(report.ok).toBe(true);
  });

  it('rebinds the fitting and the doubler the bolt row re-cut', () => {
    expect(doc.entities[alias('pylonFitting')]?.name).toBe('Pylon fitting (7075-T6, machined)');
    expect(doc.entities[alias('pylonDoubler')]?.name).toBe('Pylon doubler (7075-T6)');
    expect(doc.entities[alias('pylonFitting')]?.materialId).toBe('aa7075_t6');
  });

  it('places four NAS6203 stacks and lists them in the bill of materials', () => {
    expect(Object.keys(doc.fasteners?.stacks ?? {})).toHaveLength(4);
    const bom = execute(doc, 'bill_of_materials', {});
    expect(bom.summary).toMatch(/NAS6203-\d+" ×4/);
    expect(bom.summary).toMatch(/MS21042L3" ×4/);
  });

  it('builds a sheet-metal ESC bracket of 2024-T3 with two bends', () => {
    const part = Object.values(doc.sheetMetal?.parts ?? {})[0];
    expect(part).toBeDefined();
    const flat = execute(doc, 'flat_pattern', { id: alias('escBracket') });
    expect(flat.summary).toMatch(/2 bend\(s\)/);
  });

  it('sets up a propulsion drive that inspect_dynamics accepts', () => {
    const inspect = execute(doc, 'inspect_dynamics', {});
    const data = inspect.data as { bodies: Record<string, { massKg: number; fixed: boolean }>; problems: string[] };
    expect(data.problems).toEqual([]);
    expect(data.bodies['rotor']?.massKg).toBeCloseTo(0.32, 6);
    expect(data.bodies['airframe']?.fixed).toBe(true);
    expect(Object.keys(doc.dynamics?.propellers ?? {})).toEqual(['prop_16x8']);
  });

  it('records a static and a steady thermal case on the fitting, ready to mesh', () => {
    const cases = doc.analysis?.caseOrder.map((id) => doc.analysis?.cases[id]) ?? [];
    expect(cases.map((analysis) => analysis?.type)).toEqual(['static', 'heat_steady']);
    const [structural, thermal] = cases;
    expect(Object.keys(structural?.parts ?? {})).toEqual([alias('pylonFitting')]);
    expect(structural?.loadOrder).toHaveLength(3);
    expect(structural?.factors.extra[0]?.value).toBe(1.15);
    const check = execute(doc, 'check_analysis', { analysisId: structural?.id });
    const codes = (check.data as { items: { code: string; severity: string }[] }).items.filter((item) => item.severity === 'error');
    expect(codes.map((item) => item.code)).toEqual(['FEA_MESH_MISSING']);
    const thermalCheck = execute(doc, 'check_thermal', { analysisId: thermal?.id });
    expect((thermalCheck.data as { items: { severity: string }[] }).items.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('drives the thrust load from a document parameter', () => {
    const structural = doc.analysis?.cases[doc.analysis.caseOrder[0] ?? ''];
    const thrust = Object.values(structural?.loads ?? {}).find((load) => load.name === 'Propeller thrust');
    expect(thrust?.vector).toEqual([60, 0, 0]);
    expect(doc.parameters['thrust_limit_N']?.value).toBe(60);
  });

  it('documents the fitting on an A3 sheet with four views', () => {
    const sheet = Object.values(doc.drawings?.sheets ?? {})[0];
    expect(sheet?.paper).toBe('A3');
    expect(sheet?.views.map((view) => view.direction)).toEqual(['front', 'top', 'right', 'iso']);
  });
});
