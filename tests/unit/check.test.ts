import { describe, it, expect } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { withEntity } from '@core/commands/entity/entityOps';
import { groupedBoxes } from '../helpers/groupedBoxes';
import { type CheckResult, runModelChecks } from '@core/commands/inspect/checkModel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { build, pline } from '../helpers/addEntity';
import { xy } from '../helpers/xy';

const BASE = { position: [0, 0, 0] as const, rotation: [0, 0, 0] as const, layerId: 'layer-default', color: '#ffffff' };
const raw = (e: Record<string, unknown>): CadDocument => withEntity(createEmptyDocument(), { ...BASE, id: 'x', ...e } as Entity);
const issues = (doc: CadDocument, code: string, far = 1e6): CheckResult['issues'] =>
  runModelChecks(doc, far).issues.filter((i) => i.code === code);

describe('check_model', () => {
  it('is a pure query; empty and well-formed documents are ok (empty-layer info only)', () => {
    const empty = createEmptyDocument();
    expectPure(empty, () => expectNoOp(execute(empty, 'check_model', {}), empty));
    const data = execute(empty, 'check_model', {}).data as CheckResult;
    expect(data.ok).toBe(true);
    expect(data.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    const solids = build(['add_box', { size: [2, 2, 2] }], ['add_cylinder', { radius: 1, height: 3 }], ['add_sphere', { radius: 1.5 }]).doc;
    expect(execute(solids, 'check_model', {}).data).toMatchObject({ ok: true, issues: [] });
  });

  it.each<[string, Record<string, unknown>]>([
    ['degenerate_size', { kind: 'box', size: [1, 0, 1] }],
    ['degenerate_size', { kind: 'cylinder', radius: -1, height: 5 }],
    ['degenerate_size', { kind: 'cylinder', radius: 2, height: 0 }],
    ['degenerate_size', { kind: 'sphere', radius: 0 }],
    ['degenerate_size', { kind: 'extrusion', profile: xy(0, 0, 1, 0, 1, 1, 0, 1), depth: 0 }],
    ['degenerate_size', { kind: 'circle', center: [0, 0], radius: -2 }],
    ['degenerate_size', { kind: 'arc', center: [0, 0], radius: 0, startAngle: 0, endAngle: 1 }],
    ['degenerate_size', { kind: 'ellipse', center: [0, 0], radiusX: 0, radiusY: 1 }],
    ['degenerate_size', { kind: 'ellipse', center: [0, 0], radiusX: 1, radiusY: -1 }],
    ['insufficient_points', { kind: 'polyline', points: [[0, 0]], closed: false }],
    ['insufficient_points', { kind: 'polyline', points: [], closed: false }],
    ['insufficient_points', { kind: 'spline', points: [[0, 0]], closed: false }],
  ])('flags %s as an error for %j (ok=false, summary counts)', (code, e) => {
    const doc = raw(e);
    expect(issues(doc, code)).toEqual([expect.objectContaining({ entityId: 'x', severity: 'error' })]);
    expect(runModelChecks(doc, 1e6).ok).toBe(false);
    const { summary } = execute(doc, 'check_model', {});
    expect(summary).toContain('error');
    expect(summary).toContain('ok=');
  });

  it.each<[string, Array<readonly [string, unknown]>]>([
    ['degenerate_size', [['add_box', { size: [1, 2, 3] }]]],
    ['open_profile', [pline([0, 0, 1, 0, 1, 1], { closed: true })]],
    ['insufficient_points', [pline([0, 0, 1, 0])]],
    ['far_from_origin', [['add_box', { size: [1, 1, 1], position: [0, 0, 0] }]]],
    ['empty_layer', [['add_box', { size: [1, 1, 1] }]]],
    ['parameter_error', [['set_parameter', { name: 'width', expression: '10' }]]],
  ])('does not flag %s on a healthy model', (code, steps) => expect(issues(build(...steps).doc, code)).toHaveLength(0));

  it('warns on open profiles (still ok) and far-from-origin entities (custom threshold too)', () => {
    const open = build(pline([0, 0, 1, 0, 1, 1], { closed: false })).doc;
    expect(issues(open, 'open_profile')).toEqual([expect.objectContaining({ severity: 'warning' })]);
    const data = runModelChecks(open, 1e6);
    expect(data.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(data.ok).toBe(true);
    expect(issues(build(['add_box', { size: [1, 1, 1], position: [2e6, 0, 0] }]).doc, 'far_from_origin')).toEqual([
      expect.objectContaining({ severity: 'warning' }),
    ]);
    const near = build(['add_box', { size: [1, 1, 1], position: [500, 0, 0] }]).doc;
    const tight = execute(near, 'check_model', { farThreshold: 100 }).data as CheckResult;
    expect(tight.issues.some((i) => i.code === 'far_from_origin')).toBe(true);
    expect((execute(near, 'check_model', {}).data as CheckResult).issues.some((i) => i.code === 'far_from_origin')).toBe(false);
  });

  it('reports empty layers (info), orphaned group members and parameter errors', () => {
    expect(issues(createEmptyDocument(), 'empty_layer')).toEqual([
      expect.objectContaining({ severity: 'info', message: expect.stringContaining('layer-default') }),
    ]);
    const orphan: CadDocument = { ...createEmptyDocument(), groups: { g1: { id: 'g1', name: 'Broken Group', memberIds: ['ghost-id'] } } };
    expect(issues(orphan, 'orphaned_group_member')).toEqual([
      expect.objectContaining({ severity: 'error', entityId: 'ghost-id', message: expect.stringContaining('ghost-id') }),
    ]);
    expect(issues(groupedBoxes('Good').doc, 'orphaned_group_member')).toHaveLength(0);
    const broken: CadDocument = {
      ...createEmptyDocument(),
      parameters: { broken: { name: 'broken', expression: 'unknown_ref * 2', value: 0, error: 'unknown parameter: unknown_ref' } },
    };
    const [hit] = issues(broken, 'parameter_error');
    expect(hit).toMatchObject({ severity: 'error' });
    expect(hit!.message).toContain('broken');
    expect(hit!.message).toContain('unknown parameter');
  });
});
