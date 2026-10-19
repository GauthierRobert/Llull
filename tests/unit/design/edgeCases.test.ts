/** Edge cases of the design language: union / untyped param schemas, face picking, loops, hints and header / param errors. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import type { CommandDefinition, CommandResult, ParamsSchema } from '@core/commands/types';
import type { FaceDetail } from '@core/geometry/kernelPorts';
import { createEmptyDocument } from '@core/model/types';
import { parseDesign, type Pair } from '@design/parse';
import { AnchorRef, bindCommand, ExprRef, NameRef, type BoundCommand } from '@design/schemaValue';
import { facingFacePoint, sidePoint } from '@design/anchors';
import { DesignError } from '@design/errors';
import type { CheckResult } from '@design/checks';

const apply = (source: string): CommandResult => execute(createEmptyDocument(), 'apply_design', { source });

/** A fake command whose params schema exercises union and untyped params. */
const fake: CommandDefinition<unknown> = {
  name: 'fake',
  description: 'fake',
  paramsSchema: {
    type: 'object',
    required: [],
    properties: {
      density: { description: 'number | object', anyOf: [{ type: 'number' }, { type: 'object', properties: {} }] },
      target: { description: 'string | list', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      mode: { description: 'enum | boolean', anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'boolean' }] },
      face: { description: 'picker | number', anyOf: [{ type: 'number' }, { type: 'object', properties: { near: { description: 'p' } } }] },
      free: { description: 'untyped' },
      label: { description: 'string', type: 'string' },
      flags: { description: 'array', type: 'array' },
      plain: { description: 'object', type: 'object', properties: { x: { description: 'x', type: 'number' } } },
      record: { description: 'free-form record', type: 'object' },
    },
  } as ParamsSchema,
  run: (doc) => ({ document: doc, summary: '', affected: [] }),
};

function bind(text: string): BoundCommand {
  const [statement] = parseDesign(`fake _ ${text}`);
  if (statement?.kind !== 'command') throw new Error('not a command');
  return bindCommand(fake, statement.pairs as Pair[], { units: 'mm' }, 1);
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DesignError) return error.code;
    throw error;
  }
  return 'none';
};

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

describe('union and untyped params', () => {
  it('picks the union branch from the value shape', () => {
    expect(bind('density=w*2').params['density']).toEqual(new ExprRef('w*2'));
    expect(bind('density={"value": 1, "unit": "g/cm^3"}').params['density']).toEqual({ value: 1, unit: 'g/cm^3' });
    expect(bind('target=base').params['target']).toEqual(new NameRef('base'));
    expect(bind('target=[a, b]').params['target']).toEqual([new NameRef('a'), new NameRef('b')]);
    expect(bind('target="x"').params['target']).toBe('x');
    expect(bind('mode=b').params['mode']).toBe('b');
    expect(bind('mode=true').params['mode']).toBe(true);
    expect(bind('face=base.top').params['face']).toEqual(new AnchorRef('base', 'top'));
    expect(bind('face=3').params['face']).toBe(3);
  });

  it('untyped params read booleans, names, numbers, expressions, text and lists', () => {
    expect(bind('free=true').params['free']).toBe(true);
    expect(bind('free=name').params['free']).toEqual(new NameRef('name'));
    expect(bind('free=2*3').params['free']).toBe(6);
    expect(bind('free=w+1').params['free']).toEqual(new ExprRef('w+1'));
    expect(bind('free="t"').params['free']).toBe('t');
    expect(bind('free=[1, x]').params['free']).toEqual([1, new NameRef('x')]);
    expect(bind('flags=[1, "a"]').params['flags']).toEqual([1, 'a']);
  });

  it('refuses shapes a param cannot take', () => {
    expect(code(() => bind('label=[1]'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('density=[1]'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('plain=3'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('mode=[1]'))).toBe('DESIGN_BAD_ENUM');
    expect(code(() => bind('plain.y=1'))).toBe('DESIGN_UNKNOWN_PARAM');
    expect(bind('plain.x=2').params['plain']).toEqual({ x: 2 });
    expect(bind('record.L=80 record.H=w').params['record']).toEqual({ L: 80, H: new NameRef('w') });
  });
});

describe('face picking', () => {
  const face = (
    index: number,
    centroid: [number, number, number],
    normal: [number, number, number] | undefined,
    area: number,
    samples: [number, number, number][] = [],
  ): FaceDetail => ({ index, surface: 'plane', area, centroid, ...(normal ? { normal } : {}), samples }) as unknown as FaceDetail;

  it('takes the outermost face facing the side, the largest on a tie, its sample nearest the centroid', () => {
    const faces = [
      face(0, [0, 0, 10], [0, 0, 1], 100),
      face(1, [0, 30, 60], [0, 0, 1], 20, [
        [5, 30, 60],
        [0, 31, 60],
      ]),
      face(2, [50, 30, 60], [0, 0, 1], 40),
      face(3, [0, 0, 0], [0, 0, -1], 500),
      face(4, [0, 0, 30], undefined, 900),
    ];
    expect(facingFacePoint(faces, 'top')).toEqual([50, 30, 60]);
    expect(facingFacePoint(faces.slice(0, 2), 'top')).toEqual([0, 31, 60]);
    expect(facingFacePoint(faces, 'bottom')).toEqual([0, 0, 0]);
    expect(facingFacePoint(faces, 'left')).toBeNull();
    expect(facingFacePoint(faces, 'center')).toBeNull();
  });

  it('side points of a box, center included', () => {
    const frame = { min: [0, 0, 0] as [number, number, number], max: [2, 4, 6] as [number, number, number] };
    expect(sidePoint(frame, 'center')).toEqual([1, 2, 3]);
    expect(sidePoint(frame, 'left')).toEqual([0, 2, 3]);
    expect(sidePoint(frame, 'front')).toEqual([1, 0, 3]);
  });
});

describe('interpreter edge cases', () => {
  it('checks inside loops are re-evaluated by check_design with their loop variable', () => {
    const source = 'for i in 1..3 {\n  add_box b{i} size=[i, 1, 1]\n  check bbox of=b{i} expect == [i, 1, 1]\n}';
    const r = apply(source);
    expect((r.data as { checks: CheckResult[] }).checks.map((c) => c.pass)).toEqual([true, true, true]);
    expect(execute(r.document, 'check_design', {}).data).toMatchObject({ passed: 3, failed: 0 });
  });

  it('aliases interpolate non-integers; a loop with no iterations runs nothing', () => {
    const r = apply('for i in 1..1 {\n  add_box b{i/2} size=[1, 1, 1]\n}\nfor j in 2..1 {\n  add_box c size=[1, 1, 1]\n}');
    expect(Object.keys((r.data as { aliases: Record<string, string[]> }).aliases)).toEqual(['b0.5']);
  });

  it('refuses non-integer loop bounds and huge loops', () => {
    expect(apply('for i in 0..1.5 {\nadd_box _ size=[1,1,1]\n}').error?.code).toBe('DESIGN_BAD_VALUE');
    expect(apply('for i in 0..5000 {\nadd_box _ size=[1,1,1]\n}').error?.code).toBe('DESIGN_LOOP_LIMIT');
  });

  it('hints an alias when a typo reaches a command as a plain name', () => {
    const r = apply('add_box base size=[1,1,1]\nmove_entities _ ids=[bse] delta=[1,0,0]');
    expect(r.error?.code).toBe('DESIGN_STEP_FAILED');
    expect(r.error?.remediation).toMatch(/did you mean base/);
  });

  it('on= needs a line that creates geometry; an anchor needs geometry', () => {
    const material = 'create_material steel name="steel" density=7.85';
    expect(apply(`add_box base size=[1,1,1]\n${material} on=base.top`).error?.code).toBe('DESIGN_BAD_VALUE');
    expect(apply(`${material}\nadd_box b size=[1,1,1]`).error?.code).toBe('DESIGN_UNKNOWN_ALIAS');
    expect(apply('add_level lvl name="L0" elevation=0\nadd_box b size=[1,1,1] on=lvl.top').error?.code).toBe('DESIGN_UNKNOWN_ANCHOR');
    expect(apply('add_box b size=[1,1,1] on=nothing.top').error?.remediation).toMatch(/earlier line/);
  });

  it('on= that is already in place moves nothing; an anchor on a consumed operand uses its last box', () => {
    const r = apply(
      'add_box a size=[2,2,2] position=[0,0,1]\nadd_box b size=[2,2,2] position=[0,0,3] on=a.top\nboolean u op=union a=a b=b\nadd_box c size=[1,1,1] on=b.top',
    );
    const top = execute(r.document, 'measure_bounding_box', { entityId: r.document.order.at(-1) ?? '' }).data as { min: number[] };
    expect(r.document.featureHistory).toHaveLength(1);
    expect(top.min[2]).toBeCloseTo(4);
  });

  it('unknown names without close candidates, unknown commands without close names', () => {
    expect(apply('add_box b size=[zzzz,1,1]').error?.remediation).toMatch(/Declare it/);
    expect(apply('qqqqqqqq _ x=1').error?.remediation).toMatch(/llull search/);
    expect(apply('add_box b size=[1,1,1]\ncheck volume of=qqqq expect == 1').error?.remediation).toMatch(/earlier line/);
  });
});

describe('apply_design inputs', () => {
  it('refuses bad header options, units and param expressions', () => {
    expect(apply('design p colour=red').error?.code).toBe('DESIGN_UNKNOWN_PARAM');
    expect(apply('design p units=parsec').error?.code).toBe('DESIGN_BAD_ENUM');
    expect(apply('param w = 1 +').error?.code).toBe('DESIGN_BAD_VALUE');
  });

  it('a replaced design whose sandbox cannot re-run still applies, with no checks', () => {
    const first = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const designed = execute(first, 'apply_design', { source: 'add_box b size=[1,1,1]' }).document;
    const replaced = execute(designed, 'apply_design', {
      source: `move_entities _ ids=["${first.order[0] ?? ''}"] delta=[1,0,0]\ncheck bbox expect == [1,1,1]`,
    });
    expect(replaced.error).toBeUndefined();
    expect(replaced.data).toMatchObject({ checks: [] });
    expect(execute(replaced.document, 'check_design', {}).error?.code).toBe('DESIGN_STEP_FAILED');
  });
});
