/** Plant 01 PSC M2: `import_pipe_spec`, `create_pipe_spec`, `edit_pipe_spec` (FR-PSC-16): file parsing, revisions, all-or-nothing edits. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { getSpecModel, latestSpec, withSpecModel } from '@aec/plant/spec/store';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { fixtureSpec, importedDoc, smallSpec, withPipe, type Json } from './specFixture';

const empty = createEmptyDocument();
const header = (over: Json = {}): Json => ({
  id: 'NEW-1',
  dimensionalStandard: 'ASME',
  rating: { system: 'ASME B16.5', class: 300, materialGroup: '1.1' },
  corrosionAllowance: { value: 0.125, unit: 'in' },
  sizeRange: { fromNps: 1, toNps: 12 },
  catalogs: ['llull-open-piping'],
  ...over,
});
const edit = (doc: ReturnType<typeof importedDoc>, ops: Json[], specId = 'SMALL'): ReturnType<typeof execute> =>
  execute(doc, 'edit_pipe_spec', { specId, ops });

describe('import_pipe_spec (VC-PSC-17 input side)', () => {
  it('imports the pack fixture as a draft: 15 components, 9 branch cells, extras and aliases kept', () => {
    const result = ok(empty, 'import_pipe_spec', { spec: fixtureSpec() });
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('CS150-A1 r1 as draft: 15 component(s), 9 branch cell(s)');
    const spec = latestSpec(result.document, 'CS150-A1');
    expect(spec).toMatchObject({ revision: 1, status: 'draft', dimensionalStandard: 'ASME', corrosionAllowance: { value: 3, unit: 'mm' } });
    expect(spec?.components.find((component) => component.id === 'E90-SW')).toMatchObject({ class: 3000, ends: 'SW' });
    expect(spec?.components.find((component) => component.id === 'F-WN')?.extra).toEqual({ boreFromPipe: true });
    expect(spec?.components.find((component) => component.id === 'G-SW')?.extra).toEqual({ rings: 'inner+outer' });
    expect(spec?.branchTable).toMatchObject({ system: 'NPS', cells: { '6': { '2': 'W' } } });
    expect(getSpecModel(result.document).specOrder).toEqual(['CS150-A1']);
  });

  it('always stores a draft: an approved status or approval block in the file is ignored (approval is human-gated)', () => {
    const file = { ...smallSpec(), status: 'approved', approval: { signer: 'a', signatureId: 's', at: 't' } };
    const result = ok(empty, 'import_pipe_spec', { spec: file });
    expect(latestSpec(result.document, 'SMALL')).toMatchObject({ status: 'draft' });
    expect(latestSpec(result.document, 'SMALL')?.approval).toBeUndefined();
    expect(result.summary).toContain('ignored');
    expect((result.data as Json)['statusForcedToDraft']).toBe(true);
  });

  it('converts a corrosion allowance in inches to mm', () => {
    const spec = latestSpec(
      apply(empty, 'import_pipe_spec', { spec: smallSpec({ corrosionAllowance: { value: 0.125, unit: 'in' } }) }),
      'SMALL',
    );
    expect(spec?.corrosionAllowance).toEqual({ value: 3.175, unit: 'mm' });
  });

  it('identical content changes nothing; different content needs replace: a draft is overwritten, an approved spec gets a new revision', () => {
    const first = importedDoc(smallSpec());
    const same = ok(first, 'import_pipe_spec', { spec: smallSpec() });
    expect(same.document).toBe(first);
    expect(same.summary).toContain('nothing changed');
    const changed = smallSpec({ title: 'changed' });
    expectRefusal(first, 'import_pipe_spec', { spec: changed }, 'PSC_SPEC_CONFLICT', 'spec.id');
    const overwritten = apply(first, 'import_pipe_spec', { spec: changed, replace: true });
    expect(getSpecModel(overwritten).specs['SMALL']).toHaveLength(1);
    expect(latestSpec(overwritten, 'SMALL')?.title).toBe('changed');
    const model = getSpecModel(overwritten);
    const approved = withSpecModel(overwritten, {
      ...model,
      specs: { SMALL: (model.specs['SMALL'] ?? []).map((spec) => ({ ...spec, status: 'approved' as const })) },
    });
    const next = apply(approved, 'import_pipe_spec', { spec: smallSpec({ title: 'r2' }), replace: true });
    expect(getSpecModel(next).specs['SMALL']?.map((spec) => [spec.revision, spec.status])).toEqual([
      [1, 'approved'],
      [2, 'draft'],
    ]);
  });

  it('refuses structure, size, unit and duplicate errors with PSC_SPEC_INVALID / PSC_UNIT_INVALID and the file paths', () => {
    const base = smallSpec();
    const components = base['components'] as Json[];
    const bad = (over: Json, code: string, path: string): void => {
      const result = expectRefusal(empty, 'import_pipe_spec', { spec: { ...base, ...over } }, code, path);
      expect((result.data as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    };
    bad({ format: 'nope' }, 'PSC_SPEC_INVALID', 'format');
    bad({ id: 'bad id!' }, 'PSC_SPEC_INVALID', 'id');
    bad({ dimensionalStandard: undefined }, 'PSC_SPEC_INVALID', 'dimensionalStandard');
    bad({ corrosionAllowance: undefined }, 'PSC_SPEC_INVALID', 'corrosionAllowance');
    bad({ corrosionAllowance: { value: 1, unit: 'ft' } }, 'PSC_UNIT_INVALID', 'corrosionAllowance.unit');
    bad({ sizeRange: { fromNps: 6, toNps: 2 } }, 'PSC_SPEC_INVALID', 'sizeRange');
    bad({ sizeRange: { fromNps: 2.3, toNps: 6 } }, 'PSC_SPEC_INVALID', 'sizeRange.fromNps');
    bad({ sizeRange: { fromNps: 2, toNps: 'x' } }, 'PSC_SPEC_INVALID', 'sizeRange.toNps');
    bad({ sizeRange: { fromNps: 2, toDn: 100 } }, 'PSC_SPEC_INVALID', 'sizeRange');
    bad({ sizeRange: { fromDn: 25.5, toDn: 100 } }, 'PSC_SPEC_INVALID', 'sizeRange.fromDn');
    bad({ catalogs: [] }, 'PSC_SPEC_INVALID', 'catalogs');
    bad({ components: [components[0], { ...components[1], id: 'P' }] }, 'PSC_SPEC_INVALID', 'components.1.id');
    bad({ components: [{ ...(components[0] as Json), fromNps: 8, toNps: 2 }] }, 'PSC_SPEC_INVALID', 'components.0');
    bad({ components: [{ ...(components[0] as Json), type: 'sprocket' }] }, 'PSC_SPEC_INVALID', 'components.0.type');
    bad({ components: [{ ...(components[0] as Json), fromNps: undefined, toNps: undefined }] }, 'PSC_SPEC_INVALID', 'components.0');
    bad({ components: [{ ...(components[0] as Json), branchFromNps: 1 }] }, 'PSC_SPEC_INVALID', 'components.0');
    bad({ components: [{ ...(components[0] as Json), class: 150, pressureClass: 300 }] }, 'PSC_SPEC_INVALID', 'components.0.pressureClass');
    bad({ components: [{ ...(components[0] as Json), nested: { a: 1 } }] }, 'PSC_SPEC_INVALID', 'components.0.nested');
    bad({ branchTable: { cells: { '4': { '2': 'Z' } } } }, 'PSC_SPEC_INVALID', 'branchTable.cells.4.2');
    bad({ branchTable: { cells: { x: { '2': 'T' } } } }, 'PSC_SPEC_INVALID', 'branchTable.cells.x');
    bad({ branchTable: { cells: { '4': { y: 'T' } } } }, 'PSC_SPEC_INVALID', 'branchTable.cells.4.y');
    bad({ branchTable: { system: 'DN', cells: {} } }, 'PSC_SPEC_INVALID', 'branchTable.system');
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'import_pipe_spec', { spec: smallSpec() }));
  });
});

describe('create_pipe_spec', () => {
  it('creates an empty draft with the named header; corrosion allowance is stored in mm', () => {
    const result = ok(empty, 'create_pipe_spec', header());
    expect(result.summary).toContain('Created draft pipe spec NEW-1 r1');
    expect(latestSpec(result.document, 'NEW-1')).toMatchObject({
      revision: 1,
      status: 'draft',
      components: [],
      corrosionAllowance: { value: 3.175, unit: 'mm' },
      sizeRange: { from: { key: '1' }, to: { key: '12' } },
    });
  });

  it('nothing is defaulted: a missing dimensional standard, corrosion allowance or size range is refused by the schema', () => {
    for (const missing of ['dimensionalStandard', 'corrosionAllowance', 'sizeRange', 'rating', 'catalogs']) {
      const result = execute(empty, 'create_pipe_spec', header({ [missing]: undefined }));
      expect(result.rejected, missing).toBe(true);
      expect(result.document).toBe(empty);
    }
  });

  it('refuses an existing id, a bad range and a bad unit', () => {
    const made = apply(empty, 'create_pipe_spec', header());
    expectRefusal(made, 'create_pipe_spec', header(), 'PSC_SPEC_CONFLICT', 'id');
    expectRefusal(empty, 'create_pipe_spec', header({ sizeRange: { fromNps: 8, toNps: 2 } }), 'PSC_SPEC_INVALID', 'sizeRange');
    expectRefusal(empty, 'create_pipe_spec', header({ corrosionAllowance: { value: 1, unit: 'ft' } }), 'PSC_UNIT_INVALID');
  });

  it('a created spec is editable and resolvable end to end', () => {
    let doc = apply(empty, 'create_pipe_spec', header({ id: 'E2E', sizeRange: { fromNps: 2, toNps: 6 } }));
    doc = apply(doc, 'edit_pipe_spec', {
      specId: 'E2E',
      ops: [
        { op: 'addComponent', component: { id: 'P', type: 'pipe', fromNps: 2, toNps: 6, schedule: 'STD', catalogRef: 'asme-b36.10m' } },
      ],
    });
    expect(data<Json>(doc, 'resolve_spec_component', { specId: 'E2E', type: 'pipe', nps: 4 })).toMatchObject({
      schedule: 'STD',
      wallMm: 6.02,
    });
  });
});

describe('edit_pipe_spec', () => {
  const base = importedDoc(smallSpec());

  it('adds, updates (null removes a member), removes components; a draft is edited in place', () => {
    const added = edit(base, [
      { op: 'addComponent', component: { id: 'T', type: 'tee', fromNps: 2, toNps: 6, ends: 'BW', catalogRef: 'asme-b16.9' } },
    ]);
    expect(added.summary).toContain('draft r1');
    expect(latestSpec(added.document, 'SMALL')?.components.map((component) => component.id)).toEqual(['P', 'E', 'T']);
    expect(getSpecModel(added.document).specs['SMALL']).toHaveLength(1);
    const updated = apply(added.document, 'edit_pipe_spec', {
      specId: 'SMALL',
      ops: [{ op: 'updateComponent', id: 'P', changes: { schedule: '80', ends: null, commodityCode: 'PIP-80' } }],
    });
    const pipe = latestSpec(updated, 'SMALL')?.components[0];
    expect(pipe).toMatchObject({ schedule: '80', commodityCode: 'PIP-80' });
    expect(pipe?.ends).toBeUndefined();
    expect(data<Json>(updated, 'resolve_spec_component', { specId: 'SMALL', type: 'pipe', nps: 4 })).toMatchObject({
      schedule: '80',
      commodityCode: 'PIP-80',
    });
    const removed = apply(updated, 'edit_pipe_spec', { specId: 'SMALL', ops: [{ op: 'removeComponent', id: 'T' }] });
    expect(latestSpec(removed, 'SMALL')?.components.map((component) => component.id)).toEqual(['P', 'E']);
  });

  it('updating a size in the other system replaces the first (NPS -> DN, branch range too)', () => {
    const dn = apply(base, 'edit_pipe_spec', {
      specId: 'SMALL',
      ops: [{ op: 'updateComponent', id: 'E', changes: { fromDn: 50, toDn: 100 } }],
    });
    expect(latestSpec(dn, 'SMALL')?.components[1]).toMatchObject({ from: { system: 'DN', key: '50' }, to: { system: 'DN', key: '100' } });
    const withOlet = apply(base, 'edit_pipe_spec', {
      specId: 'SMALL',
      ops: [
        {
          op: 'addComponent',
          component: { id: 'W', type: 'weldolet', fromNps: 2, toNps: 6, branchFromNps: 1, branchToNps: 2, catalogRef: 'mss-sp-97' },
        },
        { op: 'updateComponent', id: 'W', changes: { branchFromDn: 25, branchToDn: 50 } },
      ],
    });
    expect(latestSpec(withOlet, 'SMALL')?.components[2]).toMatchObject({ branchFrom: { system: 'DN', key: '25' } });
  });

  it('sets the size range, branch cells and header members', () => {
    const next = apply(base, 'edit_pipe_spec', {
      specId: 'SMALL',
      ops: [
        { op: 'setSizeRange', sizeRange: { fromNps: 2, toNps: 8 } },
        { op: 'setBranchCell', header: 6, branch: 4, fitting: 'RT' },
        { op: 'setBranchCell', header: 6, branch: '2-1/2', fitting: 'S' },
        { op: 'clearBranchCell', header: 4, branch: 4 },
        { op: 'clearBranchCell', header: 4, branch: 2 },
        { op: 'setHeader', fields: { title: 'Small', service: null, millTolerance: 0.125, designLimits: { maxTemperatureC: 150 } } },
      ],
    });
    const spec = latestSpec(next, 'SMALL');
    expect(spec?.sizeRange.to.key).toBe('8');
    expect(spec?.branchTable?.cells).toEqual({ '6': { '4': 'RT', '2-1/2': 'S' } });
    expect(spec).toMatchObject({ title: 'Small', millTolerance: 0.125, designLimits: { maxTemperatureC: 150 } });
    const created = apply(empty, 'create_pipe_spec', header({ id: 'TBL' }));
    const table = apply(created, 'edit_pipe_spec', { specId: 'TBL', ops: [{ op: 'setBranchCell', header: 4, branch: 2, fitting: 'T' }] });
    expect(latestSpec(table, 'TBL')?.branchTable).toEqual({ system: 'NPS', cells: { '4': { '2': 'T' } } });
  });

  it('is all or nothing: a bad op leaves the document unchanged and names ops.N', () => {
    const ops = [
      { op: 'addComponent', component: { id: 'Z', type: 'tee', fromNps: 2, toNps: 6, catalogRef: 'asme-b16.9' } },
      { op: 'removeComponent', id: 'NOPE' },
    ];
    const result = expectRefusal(base, 'edit_pipe_spec', { specId: 'SMALL', ops }, 'PSC_SPEC_INVALID', 'ops.1.id');
    expect(result.summary).toContain('ops.1 (removeComponent)');
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'addComponent', component: { id: 'P', type: 'pipe' } }] },
      'PSC_SPEC_INVALID',
      'ops.0.component.id',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'updateComponent', id: 'NOPE', changes: {} }] },
      'PSC_SPEC_INVALID',
      'ops.0.id',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'updateComponent', id: 'P', changes: { id: 'Q' } }] },
      'PSC_SPEC_INVALID',
      'ops.0.changes.id',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'setBranchCell', header: 'x', branch: 2, fitting: 'T' }] },
      'PSC_SPEC_INVALID',
      'ops.0.header',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'clearBranchCell', header: 4, branch: 'y' }] },
      'PSC_SPEC_INVALID',
      'ops.0.branch',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'removeComponent', id: 'NOPE' }] },
      'PSC_SPEC_INVALID',
      'ops.0.id',
    );
  });

  it('header edits cannot touch the id, components or required members', () => {
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'setHeader', fields: { id: 'OTHER' } }] },
      'PSC_SPEC_INVALID',
      'ops.0.fields.id',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'setHeader', fields: { components: [] } }] },
      'PSC_SPEC_INVALID',
      'ops.0.fields.components',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'setHeader', fields: { corrosionAllowance: null } }] },
      'PSC_SPEC_INVALID',
      'ops.0.fields.corrosionAllowance',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'setHeader', fields: { dimensionalStandard: 'XX' } }] },
      'PSC_SPEC_INVALID',
      'dimensionalStandard',
    );
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'setSizeRange', sizeRange: { fromNps: 9, toNps: 1 } }] },
      'PSC_SPEC_INVALID',
      'sizeRange',
    );
  });

  it('an edit that changes nothing creates no revision', () => {
    const same = edit(base, [{ op: 'setHeader', fields: { title: null } }]);
    expect(same.document).toBe(base);
    expect(same.summary).toContain('unchanged');
  });

  it('editing an approved spec creates a new draft revision and keeps the approved one', () => {
    const model = getSpecModel(base);
    const approved = withSpecModel(base, {
      ...model,
      specs: {
        SMALL: (model.specs['SMALL'] ?? []).map((spec) => ({
          ...spec,
          status: 'approved' as const,
          approval: { signer: 'a', signatureId: 's', at: 't' },
        })),
      },
    });
    const next = edit(approved, [{ op: 'setHeader', fields: { title: 'rev 2' } }]);
    expect(next.summary).toContain('new draft revision r2');
    const revisions = getSpecModel(next.document).specs['SMALL'];
    expect(revisions?.map((spec) => [spec.revision, spec.status])).toEqual([
      [1, 'approved'],
      [2, 'draft'],
    ]);
    expect(revisions?.[1]?.approval).toBeUndefined();
    expect(revisions?.[0]?.title).toBeUndefined();
    expect(data<Json>(next.document, 'resolve_spec_component', { specId: 'SMALL', revision: 1, type: 'pipe', nps: 2 })['revision']).toBe(1);
  });

  it('refuses to remove the pipe component a bound pipe element needs (PSC_SPEC_IN_USE), allows it for an unbound one', () => {
    const bound = withPipe(base, 'pipe-1', 73, {
      specId: 'SMALL',
      revision: 1,
      nps: '2-1/2',
      odMm: 73,
      wallMm: 5.16,
      dimensionalStandard: 'ASME',
      verified: true,
    });
    const result = expectRefusal(
      bound,
      'edit_pipe_spec',
      { specId: 'SMALL', ops: [{ op: 'removeComponent', id: 'P' }] },
      'PSC_SPEC_IN_USE',
      'ops',
    );
    expect(result.error?.ids).toEqual(['pipe-1']);
    expect(edit(bound, [{ op: 'updateComponent', id: 'P', changes: { schedule: '80' } }]).rejected).toBeUndefined();
    expect(edit(withPipe(base, 'pipe-2', 73), [{ op: 'removeComponent', id: 'P' }]).rejected).toBeUndefined();
  });

  it('refuses an unknown spec and is pure', () => {
    expectRefusal(base, 'edit_pipe_spec', { specId: 'NOPE', ops: [{ op: 'removeComponent', id: 'P' }] }, 'PSC_SPEC_UNKNOWN', 'specId');
    expectPure(base, () => edit(base, [{ op: 'removeComponent', id: 'E' }]));
  });
});
