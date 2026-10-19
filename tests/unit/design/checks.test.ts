/** `check` lines (metrics, generic read-only queries, tolerances) and the read-only design commands. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type { CheckResult } from '@design/checks';

const apply = (source: string, doc: CadDocument = createEmptyDocument()): CommandResult => execute(doc, 'apply_design', { source });
const checksOf = (source: string): CheckResult[] => (apply(source).data as { checks: CheckResult[] }).checks;

const BLOCK = `param s = 10
add_box a size=[s, 20, 30] position=[0, 0, 15]
add_box b size=[10, 10, 10] position=[50, 0, 5]
`;

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

describe('metrics', () => {
  it('bbox / size / min / max / volume / mass with units and tolerances', () => {
    const checks = checksOf(
      BLOCK +
        [
          'check bbox of=a expect == [s, 20, 30]',
          'check size of=a expect == [1cm, 2cm, 3cm]',
          'check min of=a expect == [-5, -10, 0] ± 0.001mm',
          'check max of=a expect == [5, 10, 30]',
          'check volume of=a expect ~= 6000',
          'check volume of=a expect <= 6000',
          'check volume of=a expect >= 5999',
          'check volume of=a expect < 6001',
          'check volume of=a expect > 5999',
          'check volume of=a expect == 6100 ± 2%',
          'check bbox expect == [60, 20, 30]',
        ].join('\n'),
    );
    expect(checks.map((c) => c.pass)).toEqual(Array(11).fill(true));
  });

  it('mass reads its unit from the expected value', () => {
    const steel =
      'create_material _ name="steel" density=7.85 densityUnit="g/cm^3"\nassign_material _ materialName="steel" entityIds=[a]\n';
    const expectations = [
      'check mass of=a expect ~= 0.0471kg ± 0.1%',
      'check mass of=a expect ~= 47.1g',
      'check mass of=a expect ~= 0.1038lb',
    ];
    const checks = checksOf(BLOCK + steel + expectations.join('\n'));
    expect(checks.map((c) => [c.pass, c.actual])).toEqual([
      [true, expect.closeTo(0.0471, 6)],
      [true, expect.closeTo(47.1, 3)],
      [true, expect.closeTo(0.10384, 4)],
    ]);
  });

  it('reports a failing check with the actual value and never fails the design', () => {
    const r = apply(BLOCK + 'check bbox of=a expect == [11, 20, 30]');
    expect(r.document.order).toHaveLength(2);
    expect(r.summary).toMatch(/0\/1 checks pass — FAILED line 4 bbox of a/);
    expect((r.data as { checks: CheckResult[] }).checks[0]).toMatchObject({ pass: false, actual: [10, 20, 30] });
  });

  it('issues, dof and hard_interferences', () => {
    const source = [
      'add_box a size=[10, 10, 10]',
      'add_box b size=[10, 10, 10] position=[5, 0, 0]',
      'add_rigid_body wheel entityIds=[a]',
      'add_body_joint pin kind=revolute child=wheel anchor=[0, 0, 0] axis=[0, 0, 1]',
      'check issues expect >= 0',
      'check dof expect == 1',
      'check hard_interferences expect == 1',
    ].join('\n');
    const checks = checksOf(source);
    expect(checks.map((c) => [c.metric, c.pass, c.actual])).toEqual([
      ['issues', true, expect.any(Number)],
      ['dof', true, 1],
      ['hard_interferences', true, 1],
    ]);
  });

  it('any read-only command with path=, string comparison', () => {
    const checks = checksOf(
      BLOCK +
        'check measure_distance point1=[0,0,0] point2=[3,4,0] path=distance expect == 5\ncheck check_mechanism path=status expect == not_run',
    );
    expect(checks.map((c) => c.pass)).toEqual([true, true]);
  });

  it('refuses unknown metrics, missing of= / path=, consumed aliases', () => {
    const code = (source: string): string | undefined => apply(BLOCK + source).error?.code;
    expect(code('check nope of=a expect == 1')).toBe('DESIGN_UNKNOWN_COMMAND');
    expect(code('check volume expect == 1')).toBe('DESIGN_BAD_VALUE');
    expect(code('check measure_distance point1=[0,0,0] point2=[1,0,0] expect == 1')).toBe('DESIGN_BAD_VALUE');
    expect(code('check volume of="a" expect == 1')).toBe('DESIGN_BAD_VALUE');
    expect(code('check volume of=zz expect == 1')).toBe('DESIGN_UNKNOWN_ALIAS');
    expect(code('boolean c op=union a=a b=b\ncheck volume of=a expect == 1')).toBe('DESIGN_ALIAS_CONSUMED');
    expect(code('check bbox of=a expect == [1,1,1] ± 2parsec')).toBe('DESIGN_UNIT_NOT_SUPPORTED');
  });

  it('a query that cannot answer fails the check with a note', () => {
    const [check] = checksOf(BLOCK + 'draw_polyline p points=[[0,0],[1,0],[1,1]] closed=true\ncheck volume of=p expect == 1');
    expect(check).toMatchObject({ pass: false, actual: undefined });
    expect(check?.note).toBeTruthy();
  });
});

describe('check_design', () => {
  it('re-evaluates the design checks on the current document and gates on failure', () => {
    const built = apply(BLOCK + 'check max of=a expect == [5, 10, 30]').document;
    const ok = execute(built, 'check_design', {});
    expect(ok.error).toBeUndefined();
    expect(ok.data).toMatchObject({ passed: 1, failed: 0 });
    const moved = execute(built, 'move_entities', { ids: [built.order[0] ?? ''], delta: [0, 0, 1] }).document;
    const failed = execute(moved, 'check_design', {});
    expect(failed.error?.code).toBe('DESIGN_CHECK_FAILED');
    expect(failed.error?.paths).toEqual(['line 4']);
    expect(failed.document).toBe(moved);
  });

  it('refuses a document without design', () => {
    expect(execute(createEmptyDocument(), 'check_design', {}).error?.code).toBe('DESIGN_NO_DESIGN');
  });
});

describe('export_design', () => {
  it('returns the source verbatim, named after the design', () => {
    const source = 'design flange\n' + BLOCK;
    const r = execute(apply(source).document, 'export_design', {});
    expect(r.data).toEqual({ text: source, fileName: 'flange.lld' });
    expect((execute(apply(BLOCK).document, 'export_design', {}).data as { fileName: string }).fileName).toBe('design.lld');
    expect(execute(createEmptyDocument(), 'export_design', {}).error?.code).toBe('DESIGN_NO_DESIGN');
  });
});

describe('describe_design_syntax', () => {
  it('guide, a command line generated from its schema, unknown commands', () => {
    expect(execute(createEmptyDocument(), 'describe_design_syntax', {}).summary).toMatch(/check <metric>/);
    const hole = execute(createEmptyDocument(), 'describe_design_syntax', { command: 'add_hole' }).summary;
    expect(hole).toMatch(/^add_hole <alias> target=name\|"text" face=<alias>\.<side> /);
    expect(hole).toMatch(/hole\.kind=simple\|counterbore\|countersink\|counterdrill/);
    expect(hole).toMatch(/\[pointsFrame=face\|world_xy\|world\]/);
    expect(execute(createEmptyDocument(), 'describe_design_syntax', { command: 'add_bx' }).error?.remediation).toMatch(/add_box/);
  });
});

describe('design_source', () => {
  it('needs the geometry kernel (a replay without one is refused, never silently empty)', async () => {
    setGeometryKernel(null);
    try {
      const r = execute(createEmptyDocument(), 'design_source', { source: BLOCK, reads: {} });
      expect(r.error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
    } finally {
      setGeometryKernel(await createManifoldKernel());
    }
  });

  it('refuses a param without value when run directly', () => {
    expect(execute(createEmptyDocument(), 'design_source', { source: BLOCK, reads: {} }).error?.code).toBe('DESIGN_UNKNOWN_PARAMETER');
  });

  it('a design cannot call the design commands', () => {
    expect(apply('apply_design _ source="x"').error?.code).toBe('DESIGN_UNKNOWN_COMMAND');
  });
});
