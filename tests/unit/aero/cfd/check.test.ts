/** 12 CFD M1: check_cfd (AF-20), the cfd document slice validation, registration in the `flow` toolset, and SC-CFD-01 through build_project. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute, getCommand, listCommands } from '@core/commands/registry';
import { toToolSchemas } from '@core/commands/commandTable';
import type { CadDocument } from '@core/model/types';
import { cfdPlugin } from '@aero/index';
import { TOOLSETS, toolsetOf } from '@protocol/toolsets';
import { expectPure } from '../../../helpers/expectNoOp';
import { expectRefusal } from '../../../helpers/commandAssertions';
import { addBody, boxMesh, metreDocument, ok, withCase } from './fixtures';

interface CheckData {
  status: string;
  counts: { pass: number; warn: number; fail: number };
  cases: Array<{ caseId: string; status: string; failing: string[]; warning: string[]; result: string; solver: string | null }>;
}

const block = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
const open = boxMesh([5, 0, 0], [1, 1, 1]);
const meshes = ok(block.doc, 'import_mesh', { bodies: [{ positions: open.positions, indices: open.indices.slice(0, 30) }] });
const holed = meshes.affected[0] as string;

describe('check_cfd', () => {
  it('lists pass / warn / fail per case with the failing codes', () => {
    let doc = withCase(meshes.document, [block.id]);
    doc = ok(doc, 'create_cfd_case', {
      id: 'broken',
      entityIds: [holed],
      freestream: { speedMS: 1 },
      reference: { areaM2: 1, lengthM: 1 },
    }).document;
    const result = ok(doc, 'check_cfd', {});
    const data = result.data as CheckData;
    expect(data.status).toBe('fail');
    expect(data.counts).toEqual({ pass: 1, warn: 0, fail: 1 });
    expect(data.cases.map((entry) => [entry.caseId, entry.status])).toEqual([
      ['c1', 'pass'],
      ['broken', 'fail'],
    ]);
    expect(data.cases[1]?.failing).toEqual(['CFD_GEOMETRY_NOT_WATERTIGHT']);
    expect(data.cases[0]?.result).toBe('none');
    expect(data.cases[0]?.solver).toBe('lbm');
    expect(result.summary).toContain('broken: CFD_GEOMETRY_NOT_WATERTIGHT');
    const one = ok(doc, 'check_cfd', { caseIds: ['c1'] }).data as CheckData;
    expect(one.cases).toHaveLength(1);
    expect(one.status).toBe('pass');
  });

  it('warns on a stale recorded result and on small features', () => {
    const doc = withCase(meshes.document, [block.id]);
    const prepared = ok(doc, 'prepare_cfd_case', { caseId: 'c1' }).data as { caseHash: string; geometryHash: string };
    const record = (caseHash: string, geometryHash: string): CadDocument => ({
      ...doc,
      cfd: {
        cases: doc.cfd?.cases ?? {},
        results: { c1: { caseId: 'c1', caseHash, geometryHash, resultsHash: 'r', solver: 'lbm' } as never },
      },
    });
    const current = ok(record(prepared.caseHash, prepared.geometryHash), 'check_cfd', {}).data as CheckData;
    expect(current.cases[0]).toMatchObject({ status: 'pass', result: 'current' });
    const staleCase = ok(record('other', prepared.geometryHash), 'check_cfd', {}).data as CheckData;
    expect(staleCase.cases[0]).toMatchObject({ status: 'warn', result: 'stale', warning: ['CFD_RESULT_STALE'] });
    const staleGeometry = ok(record(prepared.caseHash, 'other'), 'check_cfd', {}).data as CheckData;
    expect(staleGeometry.cases[0]?.result).toBe('stale');
    const plate = addBody(metreDocument(), 'add_box', { size: [1, 1, 0.01], position: [0, 0, 0], anchor: 'min' });
    const thin = ok(withCase(plate.doc, [plate.id], { cellsPerReferenceLength: 100 }), 'check_cfd', {}).data as CheckData;
    expect(thin.cases[0]).toMatchObject({ status: 'warn', warning: ['CFD_SMALL_FEATURE'] });
  });

  it('answers on a document without cases, is pure, and refuses unknown ids', () => {
    const empty = execute(metreDocument(), 'check_cfd', {});
    expect(empty.summary).toBe('check_cfd: no flow case in the document.');
    expect((empty.data as CheckData).cases).toEqual([]);
    expect((empty.data as CheckData).status).toBe('pass');
    const doc = withCase(meshes.document, [block.id]);
    expectPure(doc, () => execute(doc, 'check_cfd', {}));
    expectRefusal(doc, 'check_cfd', { caseIds: ['ghost'] }, 'CFD_CASE_NOT_FOUND', 'caseIds');
  });
});

describe('document slice', () => {
  const doc = withCase(meshes.document, [block.id]);
  const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  const mutate = (edit: (cases: Record<string, Record<string, unknown>>) => void): string[] => {
    const document = raw();
    edit((document['cfd'] as { cases: Record<string, Record<string, unknown>> }).cases);
    return cfdPlugin.document?.validate(document) ?? [];
  };

  it('accepts a valid slice and an absent one', () => {
    expect(cfdPlugin.document?.validate(raw())).toEqual([]);
    expect(cfdPlugin.document?.validate({})).toEqual([]);
    expect(cfdPlugin.document?.derivedEntityIds(doc).size).toBe(0);
    const input = raw();
    expect(cfdPlugin.document?.restore(input)).toBe(input);
  });

  it('rejects malformed cases and results', () => {
    expect(cfdPlugin.document?.validate({ cfd: [] })).toEqual(['cfd must be { cases, results }']);
    expect(mutate((cases) => (cases['c1'] = { id: 'other' }))).not.toEqual([]);
    expect(mutate((cases) => (cases['c1'] = null as never))).toEqual(['cfd.cases.c1 must be an object']);
    const reasons: Array<[string, (c: Record<string, unknown>) => void]> = [
      ['id must equal', (c) => (c['id'] = 'x')],
      ['entityIds', (c) => (c['entityIds'] = [1])],
      ['regime', (c) => (c['regime'] = 'fast')],
      ['freestream', (c) => (c['freestream'] = {})],
      ['flowAxis', (c) => (c['flowAxis'] = [1, 0])],
      ['reference', (c) => (c['reference'] = {})],
      ['domain.rule', (c) => (c['domain'] = { rule: 'moon' })],
      ['ground', (c) => (c['ground'] = {})],
      ['boundaries', (c) => (c['boundaries'] = [{ kind: 'door', entityId: 'a' }])],
      ['quality', (c) => (c['quality'] = 'ultra')],
      ['solver', (c) => (c['solver'] = 'rans')],
      ['outputs', (c) => (c['outputs'] = {})],
    ];
    for (const [needle, edit] of reasons) {
      const errors = mutate((cases) => edit(cases['c1'] as Record<string, unknown>));
      expect(errors.join(' | '), needle).toContain(needle);
    }
    const document = raw();
    (document['cfd'] as { results: Record<string, unknown> }).results = { c1: { caseId: 'zzz' }, c2: 5 };
    expect(cfdPlugin.document?.validate(document)).toEqual([
      'cfd.results.c1 needs caseId equal to its key, resultsHash, caseHash, geometryHash and a solver',
      'cfd.results.c2 must be an object',
    ]);
  });
});

describe('registration', () => {
  const names = [
    'create_cfd_case',
    'update_cfd_case',
    'delete_cfd_case',
    'set_cfd_boundary',
    'prepare_cfd_case',
    'check_cfd',
    'record_cfd_results',
    'cfd_report',
  ];

  it('lists the eight commands and the native cfd_solve in the flow toolset, 1:1 with the tool schemas', () => {
    expect([...TOOLSETS.flow].sort()).toEqual([...names, 'cfd_solve'].sort());
    for (const name of names) {
      expect(getCommand(name), name).toBeDefined();
      expect(toolsetOf(name)).toBe('flow');
    }
    expect(
      toToolSchemas()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(
      listCommands()
        .map((command) => command.name)
        .sort(),
    );
    expect(getCommand('prepare_cfd_case')?.annotations?.readOnly).toBe(true);
    expect(getCommand('create_cfd_case')?.paramsSchema.properties['id']?.description).toContain('Returned in affected[0]');
  });

  it('clear_document removes the cfd slice', () => {
    const doc = withCase(block.doc, [block.id]);
    expect(execute(doc, 'clear_document', {}).document.cfd).toBeUndefined();
  });
});

describe('SC-CFD-01 (build_project plan of the validation pack)', () => {
  interface Row {
    step: number;
    path: string;
    value?: number | string;
    max?: number;
    abs?: number;
    rel?: number;
  }
  const plan = JSON.parse(
    readFileSync(resolve(process.cwd(), 'docs/aerospace/12-cfd-gpu/validation/plans/sc-cfd-01-prepare-checks.json'), 'utf8'),
  ) as { actions: unknown[]; expected: Row[]; validates: string[] };
  const at = (root: unknown, path: string): unknown =>
    path
      .replace(/\[code=([A-Z_]+)\]/g, '.@$1')
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .reduce<unknown>((node, key) => {
        if (node === undefined || node === null) return undefined;
        if (key.startsWith('@')) return (node as Array<{ code: string }>).find((row) => row.code === key.slice(1));
        return (node as Record<string, unknown>)[key];
      }, root);

  it('runs and meets every expected row', () => {
    const result = execute(metreDocument(), 'build_project', { actions: plan.actions });
    const report = result.data as { ok: boolean; steps: Array<{ summary: string; data?: unknown }> };
    expect(report.ok, report.steps.map((step) => step.summary).join('\n')).toBe(true);
    for (const row of plan.expected) {
      const actual = at(report.steps[row.step]?.data, row.path);
      const label = `step ${row.step} ${row.path}`;
      if (row.max !== undefined) expect(actual as number, label).toBeLessThanOrEqual(row.max);
      else if (typeof row.value === 'string') expect(actual, label).toBe(row.value);
      else if (row.abs !== undefined) expect(Math.abs((actual as number) - (row.value as number)), label).toBeLessThanOrEqual(row.abs);
      else if (row.rel !== undefined) expect(Math.abs((actual as number) / (row.value as number) - 1), label).toBeLessThanOrEqual(row.rel);
      else expect(actual, label).toBe(row.value);
    }
    expect(plan.validates).toEqual(['VC-CFD-10', 'VC-CFD-11', 'VC-CFD-12']);
  });
});

describe('SC-CFD-02..05 setup steps', () => {
  const plans = ['sc-cfd-02-sphere-lbm', 'sc-cfd-03-wedge-supersonic', 'sc-cfd-04-sphere-stagnation', 'sc-cfd-05-winged-body-demo'];

  it.each(plans)('%s builds its flow cases through build_project', (name) => {
    const file = resolve(process.cwd(), 'docs/aerospace/12-cfd-gpu/validation/plans', `${name}.json`);
    const plan = JSON.parse(readFileSync(file, 'utf8')) as { actions: unknown[] };
    const result = execute(metreDocument(), 'build_project', { actions: plan.actions });
    const report = result.data as { ok: boolean; steps: Array<{ summary: string }> };
    expect(report.ok, report.steps.map((step) => step.summary).join('\n')).toBe(true);
    expect(Object.keys(result.document.cfd?.cases ?? {}).length).toBeGreaterThan(0);
    expect(execute(result.document, 'check_cfd', {}).rejected).toBeUndefined();
  });
});
