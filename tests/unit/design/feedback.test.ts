/**
 * Behaviours found by authoring the toolset examples: aliases of record-making commands, regeneration of designs that create materials /
 * components / joints, check paths, and the guard rails on lines, keys and values.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CheckResult } from '@design/checks';

const apply = (source: string, doc: CadDocument = createEmptyDocument()): CommandResult => execute(doc, 'apply_design', { source });
const checksOf = (r: CommandResult): CheckResult[] => (r.data as { checks: CheckResult[] }).checks;

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

describe('aliases of commands that make records', () => {
  it('a wall alias names the walls (records), its geometry is their bodies', () => {
    const r = apply(
      [
        'design shed units=m',
        'add_level ground name="ground" elevation=0',
        'draw_walls shell points=[[0,0],[6,0],[6,4],[0,4]] closed=true thickness=0.2 height=3 levelId=ground',
        'add_slab floor wallIds=[shell] levelId=ground thickness=0.2',
        'check bbox of=shell expect == [6.2, 0.2, 3] ± 0.01',
      ].join('\n'),
    );
    expect(r.error, r.summary).toBeUndefined();
    const aliases = (r.data as { aliases: Record<string, string[]> }).aliases;
    expect(aliases['shell']).toEqual(['wall-1', 'wall-2', 'wall-3', 'wall-4']);
    expect(checksOf(r)[0]?.pass).toBe(true);
  });

  it('alias[i] picks one id; an index out of range is refused', () => {
    const source =
      'for i in 0..1 {\n  add_box b{i} size=[1,1,1] position=[i*3,0,0]\n}\ngroup_entities g ids=[b0, b1]\nmove_entities _ ids=[g[1]] delta=[0,0,5]';
    expect(apply(source).error).toBeDefined();
    const doc = apply(
      'add_box a size=[1,1,1]\nadd_box b size=[1,1,1] position=[3,0,0]\nmove_entities m ids=[a, b] delta=[0,0,1]\nmove_entities _ ids=[m[1]] delta=[0,0,5]',
    ).document;
    const top = (id: string): number => (execute(doc, 'measure_bounding_box', { entityId: id }).data as { max: number[] }).max[2] ?? 0;
    expect([top(doc.order[0] ?? ''), top(doc.order[1] ?? '')]).toEqual([1.5, 6.5]);
    expect(apply('add_box a size=[1,1,1]\nmove_entities _ ids=[a[3]] delta=[1,0,0]').error?.code).toBe('DESIGN_UNKNOWN_ALIAS');
  });

  it('a consumed alias points to the live alias that finally holds it', () => {
    const r = apply(
      'add_box a size=[2,2,2]\nadd_box b size=[1,1,1] position=[1,0,0]\nadd_box c size=[1,1,1] position=[-1,0,0]\nboolean ab op=union a=a b=b\nboolean abc op=union a=ab b=c\nmove_entities _ ids=[a] delta=[1,0,0]',
    );
    expect(r.error?.code).toBe('DESIGN_ALIAS_CONSUMED');
    expect(r.error?.remediation).toBe('Use abc instead.');
  });

  it('anchors give bare points to point params', () => {
    const r = apply(
      'add_box base size=[10,10,10] position=[0,0,5]\nadd_rigid_body body entityIds=[base]\nadd_body_joint _ kind=revolute child=body anchor=base.top axis=[0,0,1]\ncheck dof expect == 1',
    );
    expect(r.error, r.summary).toBeUndefined();
  });
});

describe('regeneration of designs that create materials, components and joints', () => {
  const ASSEMBLY = [
    'param leaf = 40',
    'add_box plate size=[leaf, 30, 4]',
    'create_component pc name="Plate" entityIds=[plate] componentId=plate_c',
    'create_material _ name="steel" density=7.85 densityUnit="g/cm^3"',
    'add_material_model _ material="steel" id=elastic model={"kind":"elastic_isotropic","E":{"value":210,"unit":"GPa"},"nu":{"value":0.3,"unit":"1"}} validity=[{"variable":"T","unit":"degC","data":[-20,100]}] basis=typical source.citation="handbook"',
    'check size of=pc expect == [leaf, 30, 4]',
  ].join('\n');

  it('set_parameter and check_design re-run cleanly, with the explicit ids', () => {
    const r = apply(ASSEMBLY);
    expect(r.error, r.summary).toBeUndefined();
    expect(execute(r.document, 'check_design', {}).error).toBeUndefined();
    const regen = execute(r.document, 'set_parameter', { name: 'leaf', expression: '70' });
    expect(regen.error, regen.summary).toBeUndefined();
    expect(Object.keys(regen.document.components)).toEqual(['plate_c']);
    expect(execute(regen.document, 'check_design', {}).data).toMatchObject({ passed: 1, failed: 0 });
    expect(execute(regen.document, 'replay_history', {}).error).toBeUndefined();
  });

  it('joints made by the design are listed in its step, so replay regenerates them', () => {
    const r = apply(
      [
        'param angle = 0',
        'add_box a size=[10,10,2]',
        'add_box b size=[10,10,2] position=[0,0,4]',
        'create_component ia name="A" entityIds=[a] componentId=a_c',
        'create_component ib name="B" entityIds=[b] componentId=b_c',
        'add_joint hinge kind=revolute a.instanceId=ia b.instanceId=ib axis=z id=hinge_pin',
        'set_joint_value _ id=hinge_pin value=angle',
      ].join('\n'),
    );
    expect(r.error, r.summary).toBeUndefined();
    expect(r.document.featureHistory[0]?.affected).toContain('hinge_pin');
    const regen = execute(r.document, 'set_parameter', { name: 'angle', expression: '0.5' });
    expect(regen.error, regen.summary).toBeUndefined();
    expect(Object.keys(regen.document.joints)).toEqual(['hinge_pin']);
  });
});

describe('check paths and values', () => {
  const BOX = 'add_box a size=[10,20,30] position=[0,0,15]\n';

  it('path= may start with data., works on metrics, reads boolean and text expectations', () => {
    const checks = checksOf(
      apply(
        BOX +
          [
            'check measure_bounding_box entityId=a path=data.size.2 expect == 30',
            'check size of=a path=1 expect == 20',
            'check check_model path=ok expect == true',
            'check check_mechanism path=status expect == "not_run"',
          ].join('\n'),
      ),
    );
    expect(checks.map((c) => c.pass)).toEqual([true, true, true, true]);
  });

  it('a path that does not resolve says where it stops and what is there', () => {
    const [check] = checksOf(apply(BOX + 'check measure_bounding_box entityId=a path=size.nope expect == 1'));
    expect(check?.note).toMatch(/path "size.nope" not found in data \(stops after "size"\); keys there: 0, 1, 2/);
  });

  it('extra pairs of a metric check go to its query (density for mass)', () => {
    const [check] = checksOf(apply(BOX + 'check mass of=a density=0.00785 expect ~= 47.1g'));
    expect(check).toMatchObject({ pass: true });
  });

  it('refuses ~= 0 without a tolerance, and of= on an alias that names nothing measurable', () => {
    expect(apply(BOX + 'check volume of=a expect ~= 0').error?.code).toBe('DESIGN_BAD_VALUE');
    const [check] = checksOf(apply(BOX + 'add_layer lay name="L1"\ncheck volume of=lay expect == 1'));
    expect(check).toMatchObject({ pass: false });
    expect(check?.note).toBeTruthy();
  });

  it('accepts ± glued to the value', () => {
    expect(checksOf(apply(BOX + 'check size of=a expect == [10,20,30]±1%'))[0]?.pass).toBe(true);
  });
});

describe('guard rails', () => {
  it('refuses a read-only command as a line, pointing to check', () => {
    const r = apply('add_box a size=[1,1,1]\nmeasure_bounding_box m entityId=a');
    expect(r.error?.code).toBe('DESIGN_BAD_VALUE');
    expect(r.error?.remediation).toMatch(/check measure_bounding_box/);
  });

  it('refuses "expect" in a command line, duplicate keys and unknown sides', () => {
    expect(apply('measure_bounding_box _ entityId=a path=size expect == 1').error?.remediation).toMatch(/A query is a check/);
    expect(apply('add_box a size=[1,1,1] size=[2,2,2]').error?.remediation).toMatch(/one value per key/);
    expect(apply('add_box a size=[1,1,1]\nadd_box b size=[1,1,1] on=a.tp').error?.remediation).toMatch(/top/);
  });

  it('points ^ and % to pow and mod', () => {
    expect(apply('add_box a size=[2^3,1,1]').error?.remediation).toMatch(/pow\(a, b\)/);
    expect(apply('add_box a size=[5%2,1,1]').error?.remediation).toMatch(/mod\(a, b\)/);
  });

  it('a union written with dotted keys reaches the command, which names the bad path', () => {
    expect(apply('add_material_model _ material="m" id=e model.kind=elastic_isotropic').error?.code).toBe('DESIGN_STEP_FAILED');
  });

  it('refuses metaHistory / session commands (they would write inputs or history from inside the recipe, L8)', () => {
    const code = (line: string): string | undefined => apply(`add_box a size=[1,1,1]\n${line}`).error?.remediation;
    expect(code('set_parameter _ name=zz expression="5"')).toMatch(/param <name>/);
    expect(code('create_configuration _ name="long" parameterValues={"L": "80"}')).toMatch(/after apply_design/);
    expect(code('fit_view _')).toMatch(/view is not part of the model/);
    expect(code('replay_history _')).toMatch(/outside the design/);
  });

  it('refuses a design that runs no command, and more checks than the limit', () => {
    expect(apply('param w = 2\ncheck issues expect >= 0').error?.code).toBe('DESIGN_SYNTAX');
    expect(apply('add_box a size=[1,1,1]\nfor i in 0..999 {\n  for j in 0..1 {\n    check issues expect >= 0\n  }\n}').error?.code).toBe(
      'DESIGN_LOOP_LIMIT',
    );
  });

  it('caps the failed-checks text', () => {
    const r = apply('add_box a size=[1,1,1]\nfor i in 0..11 {\n  check volume of=a expect == 2\n}');
    expect(r.summary).toMatch(/0\/12 checks pass .*… and 2 more/);
  });

  it('a suppressed design is not silently doubled by apply_design', () => {
    const doc = apply('add_box a size=[1,1,1]').document;
    const off = execute(doc, 'set_step_suppressed', { stepId: doc.featureHistory[0]?.id ?? '', suppressed: true }).document;
    const r = apply('add_box b size=[2,2,2]', off);
    expect(r.error?.remediation).toMatch(/Unsuppress it/);
    expect(r.document).toBe(off);
  });

  it('a design using a material made outside it still regenerates (no clean pass possible)', () => {
    const steel = execute(createEmptyDocument(), 'create_material', { name: 'steel', density: 7.85, densityUnit: 'g/cm^3' }).document;
    const r = apply(
      'param w = 10\nadd_box a size=[w,10,10]\nassign_material _ materialName="steel" entityIds=[a]\ncheck mass of=a expect ~= 7.85g',
      steel,
    );
    expect(r.error, r.summary).toBeUndefined();
    const regen = execute(r.document, 'set_parameter', { name: 'w', expression: '20' });
    expect(regen.error, regen.summary).toBeUndefined();
    expect(execute(regen.document, 'check_design', {}).error?.code).toBe('DESIGN_CHECK_FAILED');
  });

  it('a param named in metres takes length literals in metres', () => {
    const r = apply('check standard_atmosphere altitudeM=1000mm path=altitudeM expect == 1');
    expect(r.error?.code === undefined || r.error.code !== 'DESIGN_UNIT_NOT_SUPPORTED').toBe(true);
  });
});
