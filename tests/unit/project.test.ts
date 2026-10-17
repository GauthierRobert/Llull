import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type BoxEntity, type CylinderEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { executeRecorded } from '@core/commands/history/record';
import { xyz, xy } from '../helpers/xy';
import { defaultContext } from '@core/commands/context';
import { evaluateExpression, extractReferences } from '@core/commands/parametric/expression';
import type { PlanStepEvent } from '@core/commands/types';

interface BuildData {
  ok: boolean;
  validated: boolean;
  stepCount: number;
  steps: Array<{ index: number; command: string; ok: boolean; summary: string; affected: string[] }>;
  failedAt: number | null;
  issues?: string[];
  scene?: { entityCount: number };
}

const build = (
  actions: unknown[],
  extra: Record<string, unknown> = {},
  doc = createEmptyDocument(),
): { result: ReturnType<typeof execute>; data: BuildData; doc: CadDocument } => {
  const result = execute(doc, 'build_project', { ...extra, actions });
  return { result, data: result.data as BuildData, doc };
};
const BOX = { command: 'add_box', params: { size: [1, 1, 1] } };
const GHOST_MOVE = { command: 'move_entities', params: { ids: ['ghost'], delta: [1, 0, 0] } };

describe('build_project — happy path', () => {
  it('runs a multi-step plan and reports each step, purely', () => {
    const { result, data, doc } = build([
      { command: 'add_box', params: { size: [2, 2, 2] } },
      { command: 'add_sphere', params: { radius: 1 } },
    ]);
    expect(data).toMatchObject({ ok: true, stepCount: 2, scene: { entityCount: 2 } });
    expect(data.steps.map((s) => s.ok)).toEqual([true, true]);
    expect([result.affected.length, result.document.order.length]).toEqual([2, 2]);
    expect(result.summary).toContain('2/2');
    expectPure(doc, () => execute(doc, 'build_project', { actions: [BOX] }));
  });

  it.each([
    ['$base', [5, 0, 0]],
    ['$base[0]', [0, 2, 0]],
  ])('resolves %s to an earlier step id', (ref, delta) => {
    const { result, data } = build([
      { command: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 0] }, as: 'base' },
      { command: 'move_entities', params: { ids: [ref], delta } },
    ]);
    expect(data.ok).toBe(true);
    expect(result.document.entities[data.steps[0]!.affected[0]!]!.position).toEqual(delta);
  });

  it('resolves $alias inside an array param', () => {
    const { result, data } = build([
      { command: 'add_box', params: { size: [2, 2, 2] }, as: 'a' },
      { command: 'add_box', params: { size: [2, 2, 2], position: [1, 0, 0] }, as: 'b' },
      { command: 'group_entities', params: { ids: ['$a', '$b'], name: 'Pair' } },
    ]);
    expect([data.ok, data.steps[2]!.ok]).toEqual([true, true]);
    expect(Object.keys(result.document.groups)).toHaveLength(1);
  });
});

describe('build_project — failures', () => {
  it('aborts (default) at the first failing step and rolls back', () => {
    const { doc, result, data } = build([BOX, GHOST_MOVE, { command: 'add_sphere', params: { radius: 1 } }]);
    expect([data.ok, data.failedAt, data.steps.length]).toEqual([false, 1, 2]);
    expectNoOp(result, doc);
    expect(result.summary).toMatch(/aborted at step 1/);
  });

  it.each<[unknown[], number, RegExp?]>([
    [[{ command: 'frobnicate', params: {} }], 0, /Unknown command/],
    [[{ command: 'move_entities', params: { ids: ['$missing'], delta: [1, 0, 0] } }], 0, /undefined alias/],
    [
      [
        { ...BOX, as: 'b' },
        { command: 'move_entities', params: { ids: ['$b[3]'], delta: [1, 0, 0] } },
      ],
      1,
      /no id at index 3/,
    ],
    [['not-an-action'], 0],
    [
      [
        { command: 'add_box', params: { size: [10, 10, 10] } },
        { command: 'mass_properties', params: { entityId: 'missing' } },
      ],
      1,
    ],
  ])('aborts on %j at step %i', (actions, failedAt, summary) => {
    const { doc, result, data } = build(actions);
    expect(data.failedAt).toBe(failedAt);
    if (summary) expect(data.steps[failedAt]!.summary).toMatch(summary);
    expect(result.document).toBe(doc);
  });

  it.each<[unknown[], boolean[]]>([
    [
      [BOX, GHOST_MOVE, { command: 'add_sphere', params: { radius: 2 } }],
      [true, false, true],
    ],
    [
      [{ command: 'nope', params: {} }, 42, BOX],
      [false, false, true],
    ],
    [
      [{ command: 'move_entities', params: { ids: ['$ghost'], delta: [1, 0, 0] } }, BOX],
      [false, true],
    ],
  ])('onError continue applies the good steps of %j', (actions, oks) => {
    const { result, data } = build(actions, { onError: 'continue' });
    expect(data.steps.map((s) => s.ok)).toEqual(oks);
    expect(result.document.order).toHaveLength(oks.filter(Boolean).length);
    if (oks.length === 3 && oks[0]) expect([data.ok, data.failedAt, result.affected.length]).toEqual([false, null, 2]);
  });

  it('no-ops on an empty or non-array actions list', () => {
    const { doc, result, data } = build([]);
    expectNoOp(result, doc);
    expect(data.stepCount).toBe(0);
    const bad = execute(doc, 'build_project', { actions: 'nope' });
    expect(bad.document).toBe(doc);
    expect(bad.summary).toContain('build_project rejected: invalid params');
  });

  it('a read-only step that answers does not abort the plan', () => {
    const { result, data } = build([
      { command: 'add_box', params: { size: [10, 10, 10] }, as: 'b' },
      { command: 'mass_properties', params: { entityId: '$b' } },
      BOX,
    ]);
    expect(data.ok).toBe(true);
    expect(data.steps[1]).toMatchObject({ ok: true, affected: [], summary: expect.stringContaining('1000') });
    expect(result.document.order).toHaveLength(2);
  });
});

describe('build_project — validate (dry run)', () => {
  it('reports a valid plan without mutating the document', () => {
    const { doc, result, data } = build(
      [
        { ...BOX, as: 'b' },
        { command: 'move_entities', params: { ids: ['$b'], delta: [1, 0, 0] } },
      ],
      { validate: true },
    );
    expect([data.validated, data.ok]).toEqual([true, true]);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('valid');
  });

  it('flags unknown commands, missing required params, forward alias refs and malformed actions', () => {
    const { doc, result, data } = build(
      [
        { command: 'nope', params: {} },
        { command: 'add_box', params: {} },
        { command: 'move_entities', params: { ids: ['$later'], delta: [0, 0, 0] } },
        { command: 'add_sphere', params: { radius: 1 }, as: 'later' },
      ],
      { validate: true },
    );
    expect(data.ok).toBe(false);
    expect(data.issues!.length).toBeGreaterThanOrEqual(3);
    for (const s of [/unknown command/, /missing required param "size"/, /undefined alias \$later/])
      expect(data.issues!.join(' ')).toMatch(s);
    expect(result.document).toBe(doc);
    const malformed = build([null], { validate: true }).data;
    expect(malformed.ok).toBe(false);
    expect(malformed.issues!.join(' ')).toMatch(/not a valid action/);
  });

  it('type-checks literal params against the command schema and names step and parameter (VC-FTR-45)', () => {
    const { result, data } = build([{ command: 'add_sphere', params: { radius: 'abc' } }], { validate: true });
    expect(data.ok).toBe(false);
    expect(data.issues).toHaveLength(1);
    expect(data.issues![0]).toMatch(/^step 0 \(add_sphere\): invalid params — radius: /);
    expect(result.summary).toContain('step 0');
    // values only known at run time (alias refs, =expr, {loop} placeholders) are not type-checked
    const deferred = build(
      [
        { command: 'set_parameter', params: { name: 'r', expression: '2' } },
        { command: 'add_sphere', params: { radius: '=r' } },
      ],
      { validate: true },
    ).data;
    expect(deferred.ok).toBe(true);
    // a missing required param is reported once, not twice
    expect(build([{ command: 'add_sphere', params: {} }], { validate: true }).data.issues).toHaveLength(1);
  });
});

function project(doc: CadDocument, actions: unknown[]): ReturnType<typeof execute> {
  return execute(doc, 'build_project', { actions });
}

function boxes(doc: CadDocument): BoxEntity[] {
  return Object.values(doc.entities).filter((e): e is BoxEntity => e.kind === 'box');
}

describe('build_project feature history', () => {
  it('records the inner steps only; replay_history builds exactly the solids once', () => {
    const built = project(createEmptyDocument(), [
      { command: 'add_box', params: { size: [1, 1, 1] } },
      { command: 'add_sphere', params: { radius: 2 } },
    ]);
    expect(built.affected).toHaveLength(2);
    const names = built.document.featureHistory.map((s) => s.name);
    expect(names).toEqual(['add_box', 'add_sphere']);
    expect(names).not.toContain('build_project');
    const replayed = execute(built.document, 'replay_history', {}).document;
    expect(replayed.order).toHaveLength(2);
    expect(Object.keys(replayed.entities)).toHaveLength(2);
    expect(replayed.featureHistory.map((s) => s.name)).toEqual(['add_box', 'add_sphere']);
  });
  it('keeps parameter-driven =expr in the history so set_parameter + replay_history resizes', () => {
    const built = project(createEmptyDocument(), [
      { command: 'set_parameter', params: { name: 'W', expression: '10' } },
      { command: 'add_box', params: { size: ['=W', 4, 4] } },
      { command: 'add_box', params: { size: [1, 1, 1] } },
    ]);
    const params = built.document.featureHistory[0]!.params as { size: unknown[] };
    expect(params.size).toEqual(['=W', 4, 4]);
    expect(
      boxes(built.document)
        .map((b) => b.size[0])
        .sort((a, b) => a - b),
    ).toEqual([1, 10]);
    let doc = execute(built.document, 'set_parameter', { name: 'W', expression: '25' }).document;
    doc = execute(doc, 'replay_history', {}).document;
    expect(boxes(doc)).toHaveLength(2);
    expect(
      boxes(doc)
        .map((b) => b.size[0])
        .sort((a, b) => a - b),
    ).toEqual([1, 25]);
  });
  it('does not append build_project itself, even when the plan is rolled back or empty', () => {
    const empty = project(createEmptyDocument(), []);
    expect(empty.document.featureHistory).toEqual([]);
    const doc = createEmptyDocument();
    expectNoOp(project(doc, [{ command: 'add_box', params: { size: [-1, 1, 1] } }]), doc);
  });
  it('records resolved ids (not $alias) for cross-step references', () => {
    const built = project(createEmptyDocument(), [
      { command: 'add_box', as: 'b', params: { size: [1, 1, 1] } },
      { command: 'move_entities', params: { ids: ['$b'], delta: [1, 0, 0] } },
    ]);
    const move = built.document.featureHistory[1]!.params as { ids: string[] };
    expect(move.ids).toEqual([built.affected[0]]);
  });

  describe('recordableParams', () => {
    it('records a $i loop expression as its numeric value, not the expression', () => {
      const built = project(createEmptyDocument(), [
        { repeat: { count: 3 }, step: { command: 'add_box', params: { size: [1, 1, 1], position: ['=$i * 5', 0, 0] } } },
      ]);
      const recorded = built.document.featureHistory.map((s) => (s.params as { position: unknown[] }).position);
      expect(recorded).toEqual(xyz(0, 0, 0, 5, 0, 0, 10, 0, 0));
    });
    it('records for_each loop expressions ($as) as values', () => {
      const built = project(createEmptyDocument(), [
        { for_each: { values: [2, 4], as: 'r' }, step: { command: 'add_sphere', params: { radius: '=$r * 2' } } },
      ]);
      expect(built.document.featureHistory.map((s) => (s.params as { radius: unknown }).radius)).toEqual([4, 8]);
    });
    it('records an expression over a non-parameter identifier as its value', () => {
      const built = project(createEmptyDocument(), [
        { repeat: { count: 2 }, step: { command: 'add_box', params: { size: ['=i + 1', 1, 1] } } },
      ]);
      expect(built.document.featureHistory.map((s) => (s.params as { size: unknown[] }).size[0])).toEqual([1, 2]);
    });
    it('keeps =expr in repeat bodies when it only references document parameters', () => {
      const built = project(createEmptyDocument(), [
        { command: 'set_parameter', params: { name: 'W', expression: '3' } },
        { repeat: { count: 2 }, step: { command: 'add_box', params: { size: ['=W * 2', 1, 1] } } },
      ]);
      expect(built.document.featureHistory.map((s) => (s.params as { size: unknown[] }).size[0])).toEqual(['=W * 2', '=W * 2']);
    });
    it('handles mixed nested structures (arrays of objects) without losing values', () => {
      const built = project(createEmptyDocument(), [
        { command: 'set_parameter', params: { name: 'H', expression: '6' } },
        {
          command: 'extrude_profile',
          params: {
            profile: [
              [0, 0],
              [4, 0],
              [4, '=H'],
            ],
            depth: '=H',
          },
        },
      ]);
      const params = built.document.featureHistory[0]!.params as { profile: unknown[][]; depth: unknown };
      expect(params.profile[2]).toEqual([4, '=H']);
      expect(params.depth).toBe('=H');
    });
  });
});

describe('executeRecorded', () => {
  it('replaces the params of the single step execute appended', () => {
    const doc = createEmptyDocument();
    const result = executeRecorded(doc, 'add_box', { size: [2, 2, 2] }, { size: ['=W', 2, 2] });
    expect(result.affected).toHaveLength(1);
    expect(result.document.featureHistory).toHaveLength(1);
    expect(result.document.featureHistory[0]).toMatchObject({ name: 'add_box', params: { size: ['=W', 2, 2] }, affected: result.affected });
    expect(doc.featureHistory).toHaveLength(0);
  });
  it('returns a no-op untouched', () => {
    const doc = createEmptyDocument();
    expectNoOp(executeRecorded(doc, 'add_box', { size: [-1, 1, 1] }, { size: ['=W', 1, 1] }), doc);
  });
  it('returns queries and meta-history commands untouched', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const query = executeRecorded(doc, 'export_code', { language: 'cadquery' }, { x: 1 });
    expect(query.document).toBe(doc);
    expect(query.document.featureHistory).toHaveLength(1);
    const meta = executeRecorded(doc, 'replay_history', {}, { x: 1 });
    expect(meta.document.featureHistory).toHaveLength(1);
    expect(meta.document.featureHistory[0]!.params).toEqual({ size: [1, 1, 1] });
  });
  it('keeps previous history steps and only rewrites the last one', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    doc = executeRecorded(doc, 'add_sphere', { radius: 3 }, { radius: '=R' }).document;
    expect(doc.featureHistory.map((s) => s.params)).toEqual([{ size: [1, 1, 1] }, { radius: '=R' }]);
  });
});

describe('build_project + insert_step', () => {
  it('keeps the inserted step params (does not overwrite them with insert_step params)', () => {
    const result = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'set_parameter', params: { name: 'w', expression: '10' } },
        { command: 'insert_step', params: { name: 'add_box', params: { size: ['=w', '=w', '=w'] } } },
      ],
    });
    expect(result.document.featureHistory.map((step) => step.params)).toEqual([{ size: ['=w', '=w', '=w'] }]);
  });
});

interface PlanData {
  ok: boolean;
  issues?: string[];
  steps: { ok: boolean; summary: string; path?: string }[];
}

const run = (doc: CadDocument, actions: unknown[], extra: object = {}): ReturnType<typeof execute> =>
  execute(doc, 'build_project', { actions, ...extra });

const cylinders = (doc: CadDocument): CylinderEntity[] =>
  Object.values(doc.entities).filter((e): e is CylinderEntity => e.kind === 'cylinder');

const params = (n: number, r: number): unknown[] => [
  { command: 'set_parameter', params: { name: 'n', expression: String(n) } },
  { command: 'set_parameter', params: { name: 'r', expression: String(r) } },
];

const polar = {
  repeat: { count: '=n', as: 'i' },
  actions: [
    { command: 'add_cylinder', as: 'piston{i}', params: { radius: 2, height: 10, position: ['=r*cos(2*pi*i/n)', '=r*sin(2*pi*i/n)', 80] } },
  ],
};

describe('expression built-ins', () => {
  const ev = (src: string, env: Record<string, number> = {}): unknown => {
    const r = evaluateExpression(src, env);
    return r.ok ? r.value : r.error;
  };
  it('evaluates constants and functions', () => {
    expect(ev('pi')).toBeCloseTo(Math.PI);
    expect(ev('2*cos(0) + sqrt(16)')).toBe(6);
    expect(ev('max(1, 5, 3) - min(4, 2)')).toBe(3);
    expect(ev('atan2(1, 1)')).toBeCloseTo(Math.PI / 4);
    expect(ev('floor(2.7) + round(2.5) + abs(-1)')).toBe(6);
    expect(ev('mod(-1, 3)')).toBe(2);
    expect(ev('pi', { pi: 3 })).toBe(3);
  });
  it('reports bad calls without throwing', () => {
    expect(ev('foo(1)')).toBe('unknown function: foo');
    expect(ev('sqrt(-1)')).toContain('undefined');
    expect(ev('cos(1, 2)')).toContain('argument');
    expect(ev('cos(1')).toContain("expected ')'");
    expect(ev('constructor')).toContain('unknown parameter');
  });
  it('does not treat function names as parameter references', () => {
    expect([...extractReferences('r*cos(2*pi*i/n)')].sort()).toEqual(['i', 'n', 'pi', 'r']);
  });
});

describe('build_project nestable loops', () => {
  it('lays out a polar pattern driven by parameters', () => {
    const result = run(createEmptyDocument(), [...params(7, 50), polar]);
    const pistons = cylinders(result.document);
    expect(pistons).toHaveLength(7);
    expect(result.affected).toHaveLength(7);
    expect(pistons[0]?.position[0]).toBeCloseTo(50);
    expect(pistons[1]?.position[0]).toBeCloseTo(50 * Math.cos((2 * Math.PI) / 7));
    expect(pistons[1]?.position[1]).toBeCloseTo(50 * Math.sin((2 * Math.PI) / 7));
    expect(pistons[1]?.position[2]).toBe(80);
    expect(result.document.order).toHaveLength(7);
    expect((result.data as PlanData).steps[2]?.path).toBe('step 2 › iter 0 › step 0');
  });
  it('records the loop as one history step and regenerates on set_parameter (count and radius)', () => {
    const built = run(createEmptyDocument(), [...params(7, 50), polar]).document;
    expect(built.featureHistory.map((s) => s.name)).toEqual(['build_project']);
    const nine = execute(built, 'set_parameter', { name: 'n', expression: '9' });
    expect(cylinders(nine.document)).toHaveLength(9);
    expect(nine.document.order).toHaveLength(9);
    expect(nine.summary).toContain('regenerated 1 dependent feature step');
    const three = execute(nine.document, 'set_parameter', { name: 'n', expression: '3' });
    expect(cylinders(three.document)).toHaveLength(3);
    const wider = execute(three.document, 'set_parameter', { name: 'r', expression: '70' });
    expect(cylinders(wider.document)[0]?.position[0]).toBeCloseTo(70);
  });
  it('replay_history re-expands the loop with identical ids', () => {
    const built = run(createEmptyDocument(), [...params(7, 50), polar]).document;
    const replayed = execute(built, 'replay_history', {}).document;
    expect(replayed.order).toEqual(built.order);
    expect(replayed.entities).toEqual(built.entities);
  });
  it('binds interpolated aliases usable by later steps', () => {
    const result = run(createEmptyDocument(), [
      ...params(3, 10),
      polar,
      { command: 'move_entities', params: { ids: ['$piston2'], delta: [0, 0, 5] } },
    ]);
    const data = result.data as PlanData;
    expect(data.ok).toBe(true);
    const third = result.document.order[2] as string;
    expect(result.affected).toContain(third);
    expect(result.document.entities[third]?.position[2]).toBe(85);
  });
  it('keeps later steps that referenced loop ids by alias in the recorded history', () => {
    const built = run(createEmptyDocument(), [
      ...params(3, 10),
      polar,
      { command: 'move_entities', params: { ids: ['$piston1'], delta: [0, 0, 5] } },
    ]).document;
    const history = built.featureHistory;
    expect(history.map((s) => s.name)).toEqual(['build_project', 'move_entities']);
    expect((history[1]?.params as { ids: string[] }).ids).toEqual([built.order[1]]);
    const replayed = execute(built, 'replay_history', {}).document;
    expect(replayed.entities).toEqual(built.entities);
  });
  it('freezes outer aliases referenced inside a recorded loop', () => {
    const built = run(createEmptyDocument(), [
      { command: 'set_parameter', params: { name: 'n', expression: '2' } },
      { command: 'add_box', as: 'base', params: { size: [1, 1, 1] } },
      { repeat: { count: '=n' }, actions: [{ command: 'move_entities', params: { ids: ['$base'], delta: [1, 0, 0] } }] },
    ]).document;
    const loopStep = built.featureHistory[1]?.params as { actions: { actions: { params: { ids: string[] } }[] }[] };
    expect(loopStep.actions[0]?.actions[0]?.params.ids).toEqual([built.order[0]]);
    const replayed = execute(built, 'replay_history', {}).document;
    expect(replayed.entities).toEqual(built.entities);
    const bigger = execute(built, 'set_parameter', { name: 'n', expression: '5' }).document;
    expect(bigger.entities[built.order[0] as string]?.position[0]).toBe(5);
  });
  it('nests loops and gives each iteration its own variable', () => {
    const result = run(createEmptyDocument(), [
      {
        repeat: { count: 2, as: 'row' },
        actions: [
          {
            repeat: { count: 3, as: 'col' },
            actions: [
              { command: 'add_cylinder', as: 'c{row}_{col}', params: { radius: 1, height: 1, position: ['=col*10', '=row*10', 0] } },
            ],
          },
        ],
      },
      { command: 'move_entities', params: { ids: ['$c1_2'], delta: [0, 0, 1] } },
    ]);
    const spots = cylinders(result.document).map((c) => [c.position[0], c.position[1]]);
    expect(spots).toEqual(xy(0, 0, 10, 0, 20, 0, 0, 10, 10, 10, 20, 10));
    expect((result.data as PlanData).ok).toBe(true);
    expect(result.document.entities[result.document.order[5] as string]?.position[2]).toBe(1);
  });
  it('supports for loops with inclusive bounds, step and $var references', () => {
    const result = run(createEmptyDocument(), [
      { command: 'set_parameter', params: { name: 'n', expression: '4' } },
      {
        for: { var: 'k', from: 0, to: '=n-1', step: 2 },
        actions: [{ command: 'add_cylinder', params: { radius: 1, height: 1, position: ['=$k', 0, 0] } }],
      },
    ]);
    expect(cylinders(result.document).map((c) => c.position[0])).toEqual([0, 2]);
    const down = run(createEmptyDocument(), [
      { for: { var: 'k', from: 3, to: 1, step: -1 }, actions: [{ command: 'add_sphere', params: { radius: '=k' } }] },
    ]);
    expect(down.affected).toHaveLength(3);
  });
  it('a zero-iteration loop is a clean no-op (nothing recorded)', () => {
    const result = run(createEmptyDocument(), [
      { command: 'add_box', params: { size: [1, 1, 1] } },
      { repeat: { count: 0 }, actions: [{ command: 'add_box', params: { size: [1, 1, 1] } }] },
    ]);
    expect(result.document.featureHistory.map((s) => s.name)).toEqual(['add_box']);
  });
  it('rolls back the whole plan when an iteration fails (abort), continues otherwise', () => {
    const doc = createEmptyDocument();
    const actions = [{ repeat: { count: 3 }, actions: [{ command: 'add_sphere', params: { radius: '=1-i' } }] }];
    const aborted = run(doc, actions);
    expect(aborted.document).toBe(doc);
    expect(aborted.summary).toContain('Plan aborted');
    const data = aborted.data as PlanData;
    expect(data.steps.some((s) => !s.ok && s.path === 'step 0 › iter 1 › step 0')).toBe(true);
    const carried = run(doc, actions, { onError: 'continue' });
    expect(carried.affected).toHaveLength(1);
    expect(carried.document.featureHistory[0]?.params).toMatchObject({ onError: 'continue' });
  });
  it('reports header errors at run time', () => {
    const bad = run(createEmptyDocument(), [{ repeat: { count: 2.5 }, actions: [{ command: 'add_box', params: { size: [1, 1, 1] } }] }]);
    expect(bad.affected).toEqual([]);
    expect(bad.summary).toContain('non-negative integer');
  });
  it('is pure', () => {
    const doc = run(createEmptyDocument(), params(2, 5)).document;
    expectPure(doc, () => run(doc, [polar]));
  });
  it('rejects nested legacy step loops and non-actions inside a loop', () => {
    const legacy = run(createEmptyDocument(), [
      { repeat: { count: 1 }, actions: [{ repeat: { count: 1 }, step: { command: 'add_box', params: {} } }] },
    ]);
    expect(legacy.summary).toContain('cannot be nested');
    const junk = run(createEmptyDocument(), [{ repeat: { count: 1 }, actions: [42] }]);
    expect(junk.summary).toContain('not a valid action');
  });
  it('enforces the total iteration cap', () => {
    const big = run(createEmptyDocument(), [
      { repeat: { count: 600 }, actions: [] },
      { repeat: { count: 600 }, actions: [] },
    ]);
    expect(big.summary).toContain('MAX_LOOP_ITERATIONS');
    const huge = run(createEmptyDocument(), [{ repeat: { count: 5000 }, actions: [] }]);
    expect(huge.summary).toContain('MAX_LOOP_ITERATIONS');
  });
  it('reports undefined placeholders and aliases while running', () => {
    const result = run(createEmptyDocument(), [
      { repeat: { count: 1 }, actions: [{ command: 'add_box', as: 'b{zzz}', params: { size: [1, 1, 1] } }] },
    ]);
    expect(result.summary).toContain('zzz');
    const ref = run(createEmptyDocument(), [
      { repeat: { count: 1 }, actions: [{ command: 'move_entities', params: { ids: ['$nope{i}'], delta: [0, 0, 0] } }] },
    ]);
    expect(ref.summary).toContain('nope0');
  });
});

describe('build_project validate with loops', () => {
  const validate = (actions: unknown[]): PlanData => run(createEmptyDocument(), actions, { validate: true }).data as PlanData;
  it('accepts a valid parametric loop whose parameters the plan itself defines', () => {
    const data = validate([...params(7, 50), polar]);
    expect(data.issues).toEqual([]);
    expect(data.ok).toBe(true);
  });
  it('locates errors by step, iteration and inner step', () => {
    const data = validate([
      { command: 'add_box', params: { size: [1, 1, 1] } },
      {
        repeat: { count: 3 },
        actions: [
          { command: 'add_box', params: { size: [1, 1, 1] } },
          { command: 'add_sphere', params: { radius: '=i - 1 + nope' } },
        ],
      },
    ]);
    expect(data.ok).toBe(false);
    expect(data.issues?.[0]).toContain('step 1 › iter 0 › step 1 (add_sphere)');
    expect(data.issues?.[0]).toContain('unknown parameter: nope');
    expect(data.issues?.some((m) => m.startsWith('step 1 › iter 2 › step 1'))).toBe(true);
  });
  it('reports bad counts, caps, unknown commands, missing params and aliases', () => {
    expect(validate([{ repeat: { count: 'n' }, actions: [] }]).issues?.[0]).toContain('step 0');
    expect(validate([{ repeat: { count: 1.5 }, actions: [] }]).issues?.[0]).toContain('integer');
    expect(validate([{ repeat: { count: 2000 }, actions: [] }]).issues?.[0]).toContain('MAX_LOOP_ITERATIONS');
    expect(
      validate([
        { repeat: { count: 600 }, actions: [] },
        { repeat: { count: 600 }, actions: [] },
      ]).issues?.[0],
    ).toContain('step 1');
    expect(validate([{ for: { var: '1x', from: 0, to: 1 }, actions: [] }]).ok).toBe(false);
    expect(validate([{ for: { var: 'k', from: 0, to: 1, step: 0 }, actions: [] }]).ok).toBe(false);
    const inner = validate([
      {
        repeat: { count: 1 },
        actions: [
          { command: 'nope_cmd' },
          { command: 'add_box' },
          { command: 'move_entities', params: { ids: ['$ghost'], delta: [0, 0, 0] } },
          { command: 'add_box', as: 'x{q}', params: { size: [1, 1, 1] } },
          { repeat: { count: 1 }, step: { command: 'add_box' } },
          7,
        ],
      },
    ]).issues as string[];
    expect(inner).toHaveLength(6);
    expect(inner[0]).toBe('step 0 › iter 0 › step 0 (nope_cmd): unknown command');
    expect(inner[1]).toContain('missing required param');
    expect(inner[2]).toContain('undefined alias $ghost');
    expect(inner[3]).toContain('alias placeholder');
    expect(inner[4]).toContain('cannot be nested');
    expect(inner[5]).toContain('not a valid action');
  });
  it('flags iteration-interpolated alias refs that were never defined', () => {
    const data = validate([
      {
        repeat: { count: 2 },
        actions: [
          { command: 'add_box', as: 'b{i}', params: { size: [1, 1, 1] } },
          { command: 'move_entities', params: { ids: ['$b{i}'], delta: [0, 0, 0] } },
          { command: 'move_entities', params: { ids: ['$b{i+1}'], delta: [0, 0, 0] } },
        ],
      },
    ]);
    expect(data.issues).toHaveLength(2);
    expect(data.issues?.[0]).toContain('step 0 › iter 0 › step 2');
  });
  it('truncates a flood of repeated issues', () => {
    const data = validate([{ repeat: { count: 200 }, actions: [{ command: 'nope_cmd' }] }]);
    expect(data.issues?.at(-1)).toContain('further issues omitted');
  });
  it('does not mutate the document', () => {
    const doc = createEmptyDocument();
    const result = run(doc, [polar], { validate: true });
    expect(result.document).toBe(doc);
  });
});

describe('replay of a loop step that needs the kernel', () => {
  it('refuses (document unchanged) when no kernel is available', () => {
    const doc = createEmptyDocument();
    const plan = [
      { command: 'set_parameter', params: { name: 'n', expression: '2' } },
      { repeat: { count: '=n' }, actions: [{ command: 'add_box', params: { size: [1, 1, 1] }, as: 'b{i}' }] },
    ];
    const withKernelStep = {
      ...doc,
      featureHistory: [
        {
          id: 'step-1',
          name: 'build_project',
          suppressed: false,
          params: { actions: [{ repeat: { count: 1 }, actions: [{ command: 'boolean', params: { op: 'union' } }] }] },
        },
      ],
    };
    const noKernel = { ...defaultContext(), kernel: null };
    const refused = execute(withKernelStep, 'replay_history', {}, noKernel);
    expect(refused.document).toBe(withKernelStep);
    expect(refused.summary).toContain('needs the geometry kernel');
    expect(run(doc, plan).affected).toHaveLength(2);
  });
});

const plan = {
  actions: [
    { command: 'add_box', params: { size: [1, 1, 1] } },
    { repeat: { count: 2 }, step: { command: 'add_sphere', params: { radius: 1 } } },
    { command: 'no_such_command', params: {} },
  ],
  onError: 'continue',
};

describe('build_project ExecutionContext.onStep', () => {
  it('reports a start and end per executed command with ordinal, total and step position', () => {
    const events: PlanStepEvent[] = [];
    const ctx = { ...defaultContext(), onStep: (event: PlanStepEvent) => events.push(event) };
    const result = execute(createEmptyDocument(), 'build_project', plan, ctx);
    expect(events.map((e) => `${e.phase}:${e.command}:${e.ordinal}/${e.total}`)).toEqual([
      'start:add_box:1/4',
      'end:add_box:1/4',
      'start:add_sphere:2/4',
      'end:add_sphere:2/4',
      'start:add_sphere:3/4',
      'end:add_sphere:3/4',
    ]);
    const ends = events.filter((e) => e.phase === 'end');
    expect(ends.map((e) => e.ok)).toEqual([true, true, true]);
    const steps = (result.data as { steps: { command: string }[] }).steps;
    expect(ends.map((e) => steps[e.stepPosition ?? -1]?.command)).toEqual(['add_box', 'add_sphere', 'add_sphere']);
  });
  it('marks a graceful no-op step as not ok', () => {
    const events: PlanStepEvent[] = [];
    const ctx = { ...defaultContext(), onStep: (event: PlanStepEvent) => events.push(event) };
    execute(
      createEmptyDocument(),
      'build_project',
      { actions: [{ command: 'delete_entities', params: { ids: ['ghost'] } }], onError: 'continue' },
      ctx,
    );
    expect(events.filter((e) => e.phase === 'end').map((e) => e.ok)).toEqual([false]);
  });
  it('lets the observer abort the plan by throwing: the command fails, the document is unchanged', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => {
      const ctx = {
        ...defaultContext(),
        onStep: (event: PlanStepEvent) => {
          if (event.ordinal === 2) throw new Error('stop here');
        },
      };
      const result = execute(doc, 'build_project', plan, ctx);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('build_project failed: stop here');
    });
  });
  it('changes nothing without an observer', () => {
    const doc = createEmptyDocument();
    const observed = execute(doc, 'build_project', plan, { ...defaultContext(), onStep: () => undefined });
    const plain = execute(doc, 'build_project', plan);
    expect(observed.summary).toBe(plain.summary);
    expect(observed.affected).toEqual(plain.affected);
  });
});

const box = { command: 'add_box', params: { size: [1, 1, 1] } };

describe('build_project completion summary counts plan steps, not expanded commands', () => {
  it('plain plan: N/N with no expansion note', () => {
    const result = execute(createEmptyDocument(), 'build_project', { actions: [box, box] });
    expect(result.summary).toContain('Plan complete: 2/2 plan step(s) ok,');
    expect(result.summary).not.toContain('commands executed');
  });
  it('repeat plan: plan steps stay N/N and the executed command count is reported separately', () => {
    const result = execute(createEmptyDocument(), 'build_project', { actions: [box, { repeat: { count: 50 }, step: box }, box, box] });
    expect(result.summary).toContain('Plan complete: 4/4 plan step(s) ok (53 commands executed)');
  });
  it('a failing step inside a repeat counts once against its plan step (onError continue)', () => {
    const result = execute(createEmptyDocument(), 'build_project', {
      onError: 'continue',
      actions: [box, { repeat: { count: 3 }, step: { command: 'add_box', params: { size: [0, 0, 0] } } }],
    });
    expect(result.summary).toContain('Plan complete: 1/2 plan step(s) ok (4 commands executed)');
  });
});
