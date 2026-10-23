/** Plant 01 PSC M2: `resolve_spec_component` (VC-PSC-08), `resolve_branch` (VC-PSC-09) and `list_pipe_specs` on the pack fixture CS150-A1. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { resolveBranch, resolveComponent } from '@aec/plant/spec/resolve';
import { findSpec, specCatalogs } from '@aec/plant/spec/store';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { fixtureSpec, importedDoc, mixSpec, smallSpec, type Json } from './specFixture';

const doc = importedDoc();
const resolve = (params: Json): Json => data<Json>(doc, 'resolve_spec_component', { specId: 'CS150-A1', ...params });
const branch = (headerNps: number, branchNps: number): Json =>
  data<Json>(doc, 'resolve_branch', { specId: 'CS150-A1', headerNps, branchNps });
const near = (actual: unknown, expected: number, tolerance = 0.01): void =>
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);

describe('resolve_spec_component (VC-PSC-08)', () => {
  it('NPS 6 elbow: E90-LR, schedule from the pipe (Sch 40), centre-to-end 228.6, wall 7.11, grade A', () => {
    const row = resolve({ type: 'elbow90', nps: 6 });
    expect(row).toMatchObject({
      componentId: 'E90-LR',
      schedule: '40',
      ends: 'BW',
      radius: 'LR',
      verified: true,
      familyId: 'asme-b16.9-lr90',
    });
    near(row['centreToEndMm'], 228.6);
    near(row['wallMm'], 7.11, 0.001);
    near(row['outsideDiameterMm'], 168.3, 0.001);
    expect(row['pipe']).toMatchObject({ componentId: 'P-BW', schedule: '40' });
  });

  it('NPS 1 elbow: the socket-weld component, selected but unverified because B16.11 is import-only', () => {
    const row = resolve({ type: 'elbow90', nps: 1 });
    expect(row).toMatchObject({ componentId: 'E90-SW', ends: 'SW', class: 3000, verified: false });
    expect((row['warnings'] as Array<{ code: string }>).map((w) => w.code)).toEqual(['PSC_DATA_UNVERIFIED', 'PSC_CATALOG_ROW_MISSING']);
    expect(row['dims']).toEqual({});
  });

  it('NPS 10 pipe: Sch STD, wall 9.27; DN input reaches the same component through the fixed map', () => {
    const row = resolve({ type: 'pipe', nps: 10 });
    expect(row).toMatchObject({ componentId: 'P-BW-L', schedule: 'STD' });
    near(row['wallMm'], 9.27, 0.001);
    expect(resolve({ type: 'pipe', dn: 250 })['componentId']).toBe('P-BW-L');
    expect(resolve({ type: 'pipe', nps: '2-1/2' })).toMatchObject({ componentId: 'P-BW', schedule: '40' });
    near(resolve({ type: 'pipe', nps: 2.5 })['wallMm'], 5.16, 0.001);
  });

  it('NPS 30 is outside the spec range: PSC_SIZE_OUT_OF_RANGE naming the range', () => {
    const result = expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'elbow90', nps: 30 }, 'PSC_SIZE_OUT_OF_RANGE');
    expect(result.summary).toContain('NPS 1/2 to NPS 24');
  });

  it('filters by class, facing and ends; reads flange, gasket and valve rows with their dimensions', () => {
    const flange = resolve({ type: 'flangeWeldNeck', nps: 4, class: 150, facing: 'RF' });
    expect(flange).toMatchObject({ componentId: 'F-WN', class: 150, facing: 'RF' });
    near(flange['outsideDiameterMm'], 228.6);
    expect(flange['boltCount']).toBe(8);
    expect(resolve({ type: 'valveGate', nps: 4, ends: 'FL' })['faceToFaceMm']).toBe(229);
    near(resolve({ type: 'gasketSpiralWound', nps: 4 })['innerRingIdMm'], 106.4, 0.05);
    expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'flangeWeldNeck', nps: 4, class: 300 }, 'PSC_NO_COMPONENT');
  });

  it('refuses a type the spec does not define at the size, listing what it defines', () => {
    const result = expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'valveBall', nps: 4 }, 'PSC_NO_COMPONENT');
    expect(result.summary).toContain('types defined at this size');
    expect(result.summary).toContain('pipe');
    expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'flangeWeldNeck', nps: 1 }, 'PSC_NO_COMPONENT');
  });

  it('asks for a branch size when the only matching components are olets with a branch range', () => {
    const result = expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'weldolet', nps: 6 }, 'PSC_NO_COMPONENT');
    expect(result.summary).toContain('branchNps');
    expect(resolve({ type: 'weldolet', nps: 6, branchNps: 3 })['componentId']).toBe('WOL');
    expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'weldolet', nps: 6, branchNps: 8 }, 'PSC_NO_COMPONENT');
  });

  it('a missing catalogue row where the family exists is PSC_CATALOG_ROW_MISSING (not a silent unverified answer)', () => {
    expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'flangeWeldNeck', nps: 24 }, 'PSC_CATALOG_ROW_MISSING');
  });

  it('refuses bad sizes, unknown specs and revisions, and unknown catalogues with stable codes', () => {
    expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'pipe' }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'pipe', nps: 2.3 }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'tee', nps: 4, branchNps: 'x' }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'resolve_spec_component', { specId: 'NOPE', type: 'pipe', nps: 2 }, 'PSC_SPEC_UNKNOWN');
    expectRefusal(doc, 'resolve_spec_component', { specId: 'CS150-A1', revision: 7, type: 'pipe', nps: 2 }, 'PSC_SPEC_UNKNOWN');
    const orphan = importedDoc({ ...smallSpec(), catalogs: ['llull-open-piping', 'ghost'] });
    expectRefusal(orphan, 'resolve_spec_component', { specId: 'SMALL', type: 'pipe', nps: 2 }, 'PSC_CATALOG_UNKNOWN');
  });

  it('equal-priority matches are ambiguous; the lower priority wins', () => {
    const spec = smallSpec();
    const extra = { id: 'P-ALT', type: 'pipe', fromNps: 4, toNps: 6, schedule: '80', ends: 'BE', catalogRef: 'asme-b36.10m' };
    const ambiguous = importedDoc({ ...spec, components: [...(spec['components'] as Json[]), extra] });
    const refusal = expectRefusal(
      ambiguous,
      'resolve_spec_component',
      { specId: 'SMALL', type: 'pipe', nps: 4 },
      'PSC_AMBIGUOUS_COMPONENT',
    );
    expect(refusal.error?.ids).toEqual(['P', 'P-ALT']);
    const ranked = importedDoc({ ...spec, components: [...(spec['components'] as Json[]), { ...extra, priority: 10 }] });
    expect(data<Json>(ranked, 'resolve_spec_component', { specId: 'SMALL', type: 'pipe', nps: 4 })).toMatchObject({
      componentId: 'P-ALT',
      schedule: '80',
    });
    expect(data<Json>(ranked, 'resolve_spec_component', { specId: 'SMALL', type: 'pipe', nps: 2 })['componentId']).toBe('P');
  });

  it('a DN spec with an EN 10220 pipe: OD from the series (grade A), wall from the component (unverified)', () => {
    const mix = importedDoc(mixSpec());
    const row = data<Json>(mix, 'resolve_spec_component', { specId: 'MIX-1', type: 'pipe', dn: 65 });
    expect(row).toMatchObject({ componentId: 'P', dimensionalStandard: 'EN', outsideDiameterMm: 76.1, wallMm: 3.6, verified: false });
    expect(row['unverifiedDims']).toEqual(['wall']);
    const nps = data<Json>(mix, 'resolve_spec_component', { specId: 'MIX-1', type: 'pipe', nps: 2.5 });
    expect(nps['outsideDiameterMm']).toBe(76.1);
    expectRefusal(mix, 'resolve_spec_component', { specId: 'MIX-1', type: 'pipe', nps: 24 }, 'PSC_SIZE_OUT_OF_RANGE');
  });

  it('is pure and read-only', () => {
    expectPure(doc, () => execute(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'elbow90', nps: 6 }));
    const result = ok(doc, 'resolve_spec_component', { specId: 'CS150-A1', type: 'elbow90', nps: 6 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('the exported pure functions give the same answer as the command (the 02 RTE entry point)', () => {
    const spec = findSpec(doc, 'CS150-A1');
    expect(spec).toBeDefined();
    const { catalogs, missing } = specCatalogs(doc, spec as NonNullable<typeof spec>);
    expect(missing).toEqual([]);
    const outcome = resolveComponent(spec as NonNullable<typeof spec>, catalogs, { type: 'elbow90', nps: 6 });
    expect(outcome.ok && outcome.resolved.component.id).toBe('E90-LR');
    expect(outcome.ok && outcome.resolved.wallMm).toBe(7.11);
    const bad = resolveComponent(spec as NonNullable<typeof spec>, catalogs, { type: 'elbow90', nps: 30 });
    expect(bad.ok).toBe(false);
  });
});

describe('resolve_branch (VC-PSC-09)', () => {
  it('reads the fitting from the branch table: 6x6 T, 6x4 RT, 6x2 W (WOL), 6x1 S, 4x6 undefined', () => {
    expect(branch(6, 6)).toMatchObject({ fitting: 'T', componentId: 'T-BW', type: 'tee' });
    expect(branch(6, 4)).toMatchObject({ fitting: 'RT', componentId: 'TR-BW', type: 'reducingTee' });
    expect(branch(6, 2)).toMatchObject({ fitting: 'W', fittingName: 'weldolet', componentId: 'WOL', verified: false });
    expect(branch(6, 1)).toMatchObject({ fitting: 'S', componentId: 'SOL' });
    const refusal = expectRefusal(doc, 'resolve_branch', { specId: 'CS150-A1', headerNps: 4, branchNps: 6 }, 'PSC_BRANCH_UNDEFINED');
    expect(refusal.summary).toContain('branches defined for this header: 1, 2, 4');
  });

  it('the tee carries the run dimension of the header size', () => {
    near(branch(4, 4)['centreToEndRunMm'], 105, 0.5);
  });

  it('a stub-in is a fitting kind with no component', () => {
    const spec = smallSpec();
    const stub = importedDoc({ ...spec, branchTable: { cells: { '4': { '2': 'SI', '3': 'SIR' } } } });
    expect(data<Json>(stub, 'resolve_branch', { specId: 'SMALL', headerNps: 4, branchNps: 2 })).toMatchObject({
      fitting: 'SI',
      stubIn: true,
    });
    expect(data<Json>(stub, 'resolve_branch', { specId: 'SMALL', headerNps: 4, branchNps: 3 }).fittingName).toBe('reinforced stub-in');
  });

  it('accepts DN sizes for an NPS table and refuses a missing table, out-of-range sizes and no component', () => {
    expect(data<Json>(doc, 'resolve_branch', { specId: 'CS150-A1', headerDn: 150, branchDn: 100 })['fitting']).toBe('RT');
    const noTable = importedDoc({ ...smallSpec(), branchTable: undefined });
    expectRefusal(noTable, 'resolve_branch', { specId: 'SMALL', headerNps: 4, branchNps: 2 }, 'PSC_BRANCH_UNDEFINED');
    expectRefusal(doc, 'resolve_branch', { specId: 'CS150-A1', headerNps: 30, branchNps: 2 }, 'PSC_SIZE_OUT_OF_RANGE');
    expectRefusal(doc, 'resolve_branch', { specId: 'CS150-A1', headerNps: 6, branchNps: 30 }, 'PSC_SIZE_OUT_OF_RANGE');
    expectRefusal(doc, 'resolve_branch', { specId: 'CS150-A1', headerNps: 6 }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'resolve_branch', { specId: 'NOPE', headerNps: 6, branchNps: 2 }, 'PSC_SPEC_UNKNOWN');
    const orphanTee = importedDoc({ ...smallSpec(), branchTable: { cells: { '4': { '2': 'TH' } } } });
    expectRefusal(orphanTee, 'resolve_branch', { specId: 'SMALL', headerNps: 4, branchNps: 2 }, 'PSC_NO_COMPONENT');
  });

  it('a DN branch table resolves by DN keys and the NPS pairing', () => {
    const spec: Json = { ...mixSpec(), branchTable: { cells: { '100': { '50': 'T' } } } };
    const dnDoc = importedDoc({
      ...spec,
      components: [...(spec['components'] as Json[]), { id: 'T', type: 'tee', fromDn: 50, toDn: 100, catalogRef: 'asme-b16.9' }],
    });
    expect(data<Json>(dnDoc, 'resolve_branch', { specId: 'MIX-1', headerDn: 100, branchDn: 50 })['fitting']).toBe('T');
    expect(data<Json>(dnDoc, 'resolve_branch', { specId: 'MIX-1', headerNps: 4, branchNps: 2 })['componentId']).toBe('T');
    const noPair = resolveBranch(findSpec(dnDoc, 'MIX-1') as NonNullable<ReturnType<typeof findSpec>>, [], { headerDn: 90, branchDn: 50 });
    expect(noPair.ok).toBe(false);
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'resolve_branch', { specId: 'CS150-A1', headerNps: 6, branchNps: 4 }));
  });
});

describe('list_pipe_specs', () => {
  it('lists specs with revisions, standard, range and types; filters by id and status', () => {
    const both = importedDoc(mixSpec());
    const merged = execute(both, 'import_pipe_spec', { spec: fixtureSpec() }).document;
    const all = data<{ specs: Array<Json>; count: number }>(merged, 'list_pipe_specs', {});
    expect(all.count).toBe(2);
    expect(all.specs.map((spec) => spec['id'])).toEqual(['MIX-1', 'CS150-A1']);
    expect(all.specs[1]).toMatchObject({
      latestRevision: 1,
      status: 'draft',
      dimensionalStandard: 'ASME',
      components: 15,
      hasBranchTable: true,
    });
    expect(all.specs[1]?.['sizeRange']).toMatchObject({ from: { key: '1/2' }, to: { key: '24' } });
    expect(data<{ count: number }>(merged, 'list_pipe_specs', { specId: 'MIX-1' }).count).toBe(1);
    expect(data<{ count: number }>(merged, 'list_pipe_specs', { status: 'approved' }).count).toBe(0);
    expect(data<{ count: number }>(createEmptyDocument(), 'list_pipe_specs', {}).count).toBe(0);
    expectRefusal(merged, 'list_pipe_specs', { specId: 'NOPE' }, 'PSC_SPEC_UNKNOWN');
  });
});
