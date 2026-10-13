import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, CylinderEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { evaluateExpression, extractReferences } from '@core/commands/parametric/expression';

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
    {
      command: 'add_cylinder',
      as: 'piston{i}',
      params: {
        radius: 2,
        height: 10,
        position: ['=r*cos(2*pi*i/n)', '=r*sin(2*pi*i/n)', 80],
      },
    },
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
      {
        repeat: { count: '=n' },
        actions: [{ command: 'move_entities', params: { ids: ['$base'], delta: [1, 0, 0] } }],
      },
    ]).document;
    const loopStep = built.featureHistory[1]?.params as {
      actions: { actions: { params: { ids: string[] } }[] }[];
    };
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
              {
                command: 'add_cylinder',
                as: 'c{row}_{col}',
                params: { radius: 1, height: 1, position: ['=col*10', '=row*10', 0] },
              },
            ],
          },
        ],
      },
      { command: 'move_entities', params: { ids: ['$c1_2'], delta: [0, 0, 1] } },
    ]);
    const spots = cylinders(result.document).map((c) => [c.position[0], c.position[1]]);
    expect(spots).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [0, 10],
      [10, 10],
      [20, 10],
    ]);
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
      {
        for: { var: 'k', from: 3, to: 1, step: -1 },
        actions: [{ command: 'add_sphere', params: { radius: '=k' } }],
      },
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
    const actions = [
      {
        repeat: { count: 3 },
        actions: [{ command: 'add_sphere', params: { radius: '=1-i' } }],
      },
    ];
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
    const snapshot = JSON.stringify(doc);
    run(doc, [polar]);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('rejects nested legacy step loops and non-actions inside a loop', () => {
    const legacy = run(createEmptyDocument(), [
      {
        repeat: { count: 1 },
        actions: [{ repeat: { count: 1 }, step: { command: 'add_box', params: {} } }],
      },
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
      {
        repeat: { count: 1 },
        actions: [{ command: 'add_box', as: 'b{zzz}', params: { size: [1, 1, 1] } }],
      },
    ]);
    expect(result.summary).toContain('zzz');
    const ref = run(createEmptyDocument(), [
      {
        repeat: { count: 1 },
        actions: [{ command: 'move_entities', params: { ids: ['$nope{i}'], delta: [0, 0, 0] } }],
      },
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
      {
        repeat: { count: '=n' },
        actions: [{ command: 'add_box', params: { size: [1, 1, 1] }, as: 'b{i}' }],
      },
    ];
    const withKernelStep = {
      ...doc,
      featureHistory: [
        {
          id: 'step-1',
          name: 'build_project',
          suppressed: false,
          params: {
            actions: [{ repeat: { count: 1 }, actions: [{ command: 'boolean', params: { op: 'union' } }] }],
          },
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
