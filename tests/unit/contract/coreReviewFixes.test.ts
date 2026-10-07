/** Regression tests for the core command-layer review (expressions, rotations, exports, refs). */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type {
  CadDocument,
  Constraint,
  Entity,
  ExtrusionEntity,
  Joint,
  RectangleEntity,
  Vec3,
} from '@core/model/types';
import { execute, listCommands } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { evaluateExpression } from '@core/commands/expression';
import { entityToTriangles } from '@core/commands/exportTriangulate';
import { composeEulerXYZ, applyEulerXYZ, rotateEulerAboutWorldZ } from '@lib/eulerRotation';
import { isVec2, isVec2List } from '@lib/vec2';
import { elementAt } from '@lib/elementAt';
import { sampleArc } from '@lib/arc';
import { sub3, cross3, dot3 } from '@lib/vec3';

const run = (doc: CadDocument, name: string, params: unknown): ReturnType<typeof execute> =>
  execute(doc, name, params);
const only = (doc: CadDocument, kind: string): Entity =>
  Object.values(doc.entities).find((e) => e.kind === kind) as Entity;

describe('expressions: own numeric names and finite results', () => {
  it('rejects divide-by-zero and inherited names', () => {
    expect(evaluateExpression('1/0', {}).ok).toBe(false);
    expect(evaluateExpression('constructor', {}).ok).toBe(false);
    expect(evaluateExpression('valueOf + 1', {}).ok).toBe(false);
    expect(evaluateExpression('a * 2', { a: 4 })).toEqual({ ok: true, value: 8 });
  });

  it('set_parameter refuses the __proto__ name', () => {
    const result = run(createEmptyDocument(), 'set_parameter', {
      name: '__proto__',
      expression: '1',
    });
    expect(result.affected).toEqual([]);
    expect(Object.keys(result.document.parameters)).toEqual([]);
  });

  it('set_parameter stores an error, never Infinity', () => {
    const doc = run(createEmptyDocument(), 'set_parameter', { name: 'p', expression: '1/0' });
    expect(doc.document.parameters.p?.error).toBeDefined();
    expect(Number.isFinite(doc.document.parameters.p?.value)).toBe(true);
    const ok = run(createEmptyDocument(), 'set_parameter', { name: 'p', expression: '6/3' });
    expect(ok.document.parameters.p?.value).toBe(2);
  });

  it('delete_parameter ignores prototype names', () => {
    const doc = createEmptyDocument();
    const result = run(doc, 'delete_parameter', { name: 'toString' });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('does not exist');
  });
});

describe('world-Z rotation helper', () => {
  it('composes with a zero rotation exactly and matches a vector rotation', () => {
    expect(rotateEulerAboutWorldZ([0, 0, 0.5], 0.25)[2]).toBeCloseTo(0.75);
    const tilted: Vec3 = [Math.PI / 2, 0, 0];
    const rotated = rotateEulerAboutWorldZ(tilted, Math.PI / 2);
    const viaEuler = applyEulerXYZ([1, 2, 3], [0, 0, 0], rotated);
    const direct = applyEulerXYZ(
      applyEulerXYZ([1, 2, 3], [0, 0, 0], tilted),
      [0, 0, 0],
      [0, 0, Math.PI / 2],
    );
    direct.forEach((v, i) => expect(viaEuler[i]).toBeCloseTo(v));
    expect(composeEulerXYZ([0.1, 0.2, 0.3], [0, 0, 0])).toEqual([0.1, 0.2, 0.3]);
  });

  it('never returns negative zero', () => {
    expect(Object.is(rotateEulerAboutWorldZ([0, 0, 0.5], 1)[0], 0)).toBe(true);
    expect(Object.is(rotateEulerAboutWorldZ([0, 0, 0.5], 1)[1], 0)).toBe(true);
  });

  it('array_polar rotates the copy axes of a tilted part about world Z', () => {
    let doc = run(createEmptyDocument(), 'add_cylinder', {
      radius: 1,
      height: 4,
      position: [10, 0, 0],
      rotation: [Math.PI / 2, 0, 0],
    }).document;
    const id = doc.order[0] as string;
    const result = run(doc, 'array_polar', { id, count: 4, center: [0, 0, 0] });
    expect(result.affected).toHaveLength(3);
    doc = result.document;
    const axisOf = (e: Entity): Vec3 => applyEulerXYZ([0, 0, 1], [0, 0, 0], e.rotation);
    const quarter = doc.entities[result.affected[0] as string] as Entity;
    const [ax, ay] = axisOf(quarter);
    // Source axis is world -Y; a 90 degree world-Z turn sends it to +X.
    expect(ax).toBeCloseTo(1);
    expect(ay).toBeCloseTo(0);
    expect(quarter.position[1]).toBeCloseTo(10);
  });

  it('array_polar failure: missing id is a no-op', () => {
    const doc = createEmptyDocument();
    expect(run(doc, 'array_polar', { id: 'nope', count: 3, center: [0, 0, 0] }).affected).toEqual(
      [],
    );
  });
});

describe('offset_2d on a rotated rectangle', () => {
  it('shifts the origin by [-d, -d] in world space (2D renderers ignore rotation)', () => {
    const base = run(createEmptyDocument(), 'draw_rectangle', { width: 4, height: 2 }).document;
    const id = base.order[0] as string;
    const rect = base.entities[id] as RectangleEntity;
    const doc = {
      ...base,
      entities: { ...base.entities, [id]: { ...rect, rotation: [0, 0, Math.PI / 2] as Vec3 } },
    };
    const result = run(doc, 'offset_2d', { id, distance: 1 });
    const copy = result.document.entities[result.affected[0] as string] as RectangleEntity;
    expect(copy.position[0]).toBeCloseTo(-1);
    expect(copy.position[1]).toBeCloseTo(-1);
    expect(copy.width).toBe(6);
  });

  it('failure: degenerate inward offset is a no-op', () => {
    const base = run(createEmptyDocument(), 'draw_rectangle', { width: 4, height: 2 }).document;
    const result = run(base, 'offset_2d', { id: base.order[0], distance: -5 });
    expect(result.document).toBe(base);
  });
});

describe('extrude_sketch does not inherit the sketch rotation', () => {
  const sketch = (): { doc: CadDocument; id: string } => {
    const base = run(createEmptyDocument(), 'draw_rectangle', { width: 4, height: 2 }).document;
    const id = base.order[0] as string;
    const rect = base.entities[id] as RectangleEntity;
    return {
      id,
      doc: {
        ...base,
        entities: { ...base.entities, [id]: { ...rect, rotation: [Math.PI / 2, 0, 0] as Vec3 } },
      },
    };
  };

  it('defaults to [0, 0, 0] and uses an explicit rotation verbatim', () => {
    const { doc, id } = sketch();
    const plain = run(doc, 'extrude_sketch', { id, depth: 3 });
    expect((only(plain.document, 'extrusion') as ExtrusionEntity).rotation).toEqual([0, 0, 0]);
    const rotated = run(doc, 'extrude_sketch', { id, depth: 3, rotation: [0, 0, Math.PI / 2] });
    expect((only(rotated.document, 'extrusion') as ExtrusionEntity).rotation).toEqual([
      0,
      0,
      Math.PI / 2,
    ]);
  });

  it('failure: depth <= 0 is a no-op', () => {
    const { doc, id } = sketch();
    expect(run(doc, 'extrude_sketch', { id, depth: 0 }).document).toBe(doc);
  });
});

describe('exported extrusion facets face outward', () => {
  const square = (clockwise: boolean): Array<[number, number]> =>
    clockwise
      ? [
          [0, 0],
          [0, 2],
          [2, 2],
          [2, 0],
        ]
      : [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ];

  for (const clockwise of [false, true]) {
    it(`${clockwise ? 'clockwise' : 'counter-clockwise'} profile: every facet normal points away from the centre`, () => {
      const doc = run(createEmptyDocument(), 'extrude_profile', {
        profile: square(clockwise),
        depth: 2,
        position: [0, 0, 0],
      }).document;
      const triangles = entityToTriangles(only(doc, 'extrusion'), doc);
      expect(triangles.length).toBeGreaterThanOrEqual(12);
      const centre: Vec3 = [1, 1, 1];
      for (const [a, b, c] of triangles) {
        const normal = cross3(sub3(b, a), sub3(c, a));
        const middle: Vec3 = [
          (a[0] + b[0] + c[0]) / 3,
          (a[1] + b[1] + c[1]) / 3,
          (a[2] + b[2] + c[2]) / 3,
        ];
        expect(dot3(normal, sub3(middle, centre))).toBeGreaterThan(0);
      }
    });
  }
});

describe('profile validation', () => {
  it('isVec2 / isVec2List', () => {
    expect(isVec2([1, 2])).toBe(true);
    expect(isVec2([1, 2, 3])).toBe(false);
    expect(isVec2('a')).toBe(false);
    expect(isVec2([1, Number.NaN])).toBe(false);
    expect(
      isVec2List([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(true);
    expect(isVec2List([[0, 0], 'a'])).toBe(false);
  });

  it('extrude_profile / revolve_profile name the bad point', () => {
    const doc = createEmptyDocument();
    for (const profile of [
      ['a', [1, 0], [0, 1]],
      [
        [0, 0],
        [1, 2, 3],
        [0, 1],
      ],
    ]) {
      const extruded = run(doc, 'extrude_profile', { profile, depth: 1 });
      expect(extruded.document).toBe(doc);
      expect(extruded.summary).toContain('profile point');
      const revolved = run(doc, 'revolve_profile', { profile });
      expect(revolved.document).toBe(doc);
      expect(revolved.summary).toContain('profile point');
    }
    const good = run(doc, 'extrude_profile', {
      profile: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      depth: 1,
    });
    expect(good.affected).toHaveLength(1);
  });
});

describe('revolve_profile ids and layers', () => {
  const profile = [
    [1, 0],
    [2, 0],
    [2, 1],
  ];

  it('refuses an id that already exists and keeps order duplicate-free', () => {
    const first = run(createEmptyDocument(), 'revolve_profile', { profile, id: 'rev-a' });
    expect(first.affected).toEqual(['rev-a']);
    const again = run(first.document, 'revolve_profile', { profile, id: 'rev-a' });
    expect(again.document).toBe(first.document);
    expect(first.document.order).toEqual(['rev-a']);
    const proto = run(first.document, 'revolve_profile', { profile, id: 'toString' });
    expect(proto.document).toBe(first.document);
  });

  it('unknown layer falls back to the default layer', () => {
    const result = run(createEmptyDocument(), 'revolve_profile', { profile, layerId: 'ghost' });
    expect(only(result.document, 'revolution').layerId).toBe('layer-default');
  });
});

describe('add_box size length', () => {
  it('rejects a 2-component size', () => {
    const doc = createEmptyDocument();
    const result = run(doc, 'add_box', { size: [1, 2] });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('3 components');
    expect(run(doc, 'add_box', { size: [1, 2, 3] }).affected).toHaveLength(1);
  });
});

describe('move_entity', () => {
  it('requires a 3-component delta', () => {
    const base = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const id = base.order[0] as string;
    const bad = run(base, 'move_entity', { id, delta: [1, 2] });
    expect(bad.document).toBe(base);
    const good = run(base, 'move_entity', { id, delta: [1, 2, 3] });
    expect((good.document.entities[id] as Entity).position).toEqual([1, 2, 3]);
  });
});

describe('explode_polyline prunes group membership', () => {
  it('removes the polyline from groups', () => {
    let doc = run(createEmptyDocument(), 'draw_polyline', {
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    }).document;
    doc = run(doc, 'draw_circle', { center: [0, 0], radius: 1 }).document;
    const [poly, circle] = doc.order as [string, string];
    doc = run(doc, 'group_entities', { ids: [poly, circle, poly] }).document;
    const group = Object.values(doc.groups)[0];
    expect(group?.memberIds).toEqual([poly, circle]);
    const result = run(doc, 'explode_polyline', { id: poly });
    expect(result.affected.length).toBe(2);
    for (const g of Object.values(result.document.groups)) {
      expect(g.memberIds).not.toContain(poly);
    }
  });

  it('failure: unknown id', () => {
    const doc = createEmptyDocument();
    expect(run(doc, 'explode_polyline', { id: 'x' }).document).toBe(doc);
  });
});

describe('group_entities dedupes ids', () => {
  it('two copies of one id is not a group', () => {
    const doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const id = doc.order[0] as string;
    expect(run(doc, 'group_entities', { ids: [id, id] }).document).toBe(doc);
  });
});

describe('deleting entities prunes constraints, joints and drives', () => {
  const build = (): CadDocument => {
    let doc = createEmptyDocument();
    doc = run(doc, 'draw_circle', { center: [0, 0], radius: 1 }).document;
    doc = run(doc, 'draw_circle', { center: [5, 0], radius: 1 }).document;
    const [a, b] = doc.order as [string, string];
    const constraint: Constraint = {
      id: 'c1',
      kind: 'coincident',
      a: { entityId: a },
      b: { entityId: b },
    };
    const joint = (id: string): Joint => ({
      id,
      kind: 'revolute',
      a: { instanceId: a },
      b: { instanceId: b },
      axis: 'z',
      angle: 0,
    });
    return {
      ...doc,
      constraints: { c1: constraint },
      constraintOrder: ['c1'],
      joints: { j1: joint('j1'), j2: joint('j2') },
      jointOrder: ['j1', 'j2'],
      driveRelations: { d1: { id: 'd1', driver: 'j1', driven: 'j2', ratio: 1 } },
      driveRelationOrder: ['d1'],
    };
  };

  it('delete_entity removes dependent records and reports them', () => {
    const doc = build();
    const result = run(doc, 'delete_entity', { id: doc.order[0] });
    expect(result.document.constraintOrder).toEqual([]);
    expect(result.document.constraints).toEqual({});
    expect(result.document.jointOrder).toEqual([]);
    expect(result.document.driveRelationOrder).toEqual([]);
    expect(result.summary).toContain('4 constraint/joint/drive');
    const check = run(result.document, 'check_model', {});
    expect((check.data as { issues: Array<{ code: string }> }).issues).toEqual([]);
  });

  it('check_model flags dangling references left by a hand edit', () => {
    const doc = build();
    const broken = { ...doc, entities: {}, order: [] };
    const issues = (run(broken, 'check_model', {}).data as { issues: Array<{ code: string }> })
      .issues;
    expect(issues.filter((i) => i.code === 'dangling_reference').length).toBeGreaterThanOrEqual(3);
  });

  it('delete_entities keeps unrelated records', () => {
    const doc = run(build(), 'draw_circle', { center: [9, 9], radius: 1 }).document;
    const extra = doc.order[2] as string;
    const result = run(doc, 'delete_entities', { ids: [extra] });
    expect(result.document.constraintOrder).toEqual(['c1']);
  });
});

describe('insert_step is not idempotent', () => {
  it('drops the idempotent annotation', () => {
    const def = listCommands().find((c) => c.name === 'insert_step');
    expect(def?.annotations?.idempotent).toBeUndefined();
  });
});

describe('hex colors', () => {
  it('colorField rejects non-hex colors and accepts #rrggbb', () => {
    const doc = createEmptyDocument();
    const bad = run(doc, 'add_box', { size: [1, 1, 1], color: 'red' });
    expect(bad.document).toBe(doc);
    expect(bad.summary).toContain('rejected');
    expect(run(doc, 'add_box', { size: [1, 1, 1], color: '#aabbcc' }).affected).toHaveLength(1);
  });
});

describe('set_entity_name', () => {
  it('sets and clears the name without a cast', () => {
    const base = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const id = base.order[0] as string;
    const named = run(base, 'set_entity_name', { id, name: 'Beam', tags: ['a'] }).document;
    expect((named.entities[id] as Entity).name).toBe('Beam');
    const cleared = run(named, 'set_entity_name', { id, name: '' }).document;
    expect((cleared.entities[id] as Entity).name).toBeUndefined();
    expect((cleared.entities[id] as Entity).tags).toEqual(['a']);
    expect(run(base, 'set_entity_name', { id: 'ghost', name: 'x' }).document).toBe(base);
  });
});

describe('lib helpers', () => {
  it('elementAt throws out of range and sampleArc ends at the sweep', () => {
    expect(elementAt([1, 2], 1)).toBe(2);
    expect(() => elementAt([1], 3)).toThrow(RangeError);
    const points = sampleArc([1, 1], 2, 0, Math.PI, 2);
    expect(points[1]?.[0]).toBeCloseTo(-1);
    expect(points[1]?.[1]).toBeCloseTo(1);
  });
});

describe('execute marks refusals as rejected', () => {
  it('unknown command, invalid params, and prototype ids', () => {
    const doc = createEmptyDocument();
    expect(run(doc, 'no_such_tool', {}).rejected).toBe(true);
    expect(run(doc, 'add_box', { size: 'big' }).rejected).toBe(true);
    expect(run(doc, 'delete_entity', { id: 'constructor' }).rejected).toBe(true);
  });

  it('a command-level no-op and a success are not rejected', () => {
    const doc = createEmptyDocument();
    expect(run(doc, 'delete_entity', { id: 'ghost' }).rejected).toBeUndefined();
    expect(run(doc, 'add_box', { size: [1, 1, 1] }).rejected).toBeUndefined();
  });

  it('requiresKernel without a kernel', () => {
    const kernelCommand = listCommands().find((c) => c.annotations?.requiresKernel === true);
    expect(kernelCommand).toBeDefined();
    const result = execute(
      createEmptyDocument(),
      (kernelCommand as { name: string }).name,
      {},
      { ...defaultContext(), kernel: null },
    );
    expect(result.rejected).toBe(true);
    expect(result.summary).toContain('kernel not available');
  });
});

describe('export_code file name', () => {
  it('collapses runs of unsafe characters', () => {
    const result = run(createEmptyDocument(), 'export_code', {
      language: 'openscad',
      name: 'my  weird/name',
    });
    expect(result.summary).toContain('my_weird_name.scad');
  });
});

describe('contract: params schemas carry no defaults or transforms', () => {
  it('no registered command uses .default() or .transform()', () => {
    const offenders: string[] = [];
    const visit = (schema: unknown, path: string, seen: Set<unknown>): void => {
      if (typeof schema !== 'object' || schema === null || seen.has(schema)) return;
      seen.add(schema);
      const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
      if (!def) return;
      if (def.type === 'default' || def.type === 'prefault') offenders.push(`${path} (default)`);
      if (def.type === 'pipe') offenders.push(`${path} (transform)`);
      if (def.type === 'transform') offenders.push(`${path} (transform)`);
      const children: Array<[string, unknown]> = [];
      if (def.shape && typeof def.shape === 'object') {
        for (const [key, child] of Object.entries(def.shape)) children.push([`.${key}`, child]);
      }
      for (const key of ['innerType', 'element', 'in', 'out']) {
        if (def[key]) children.push([`.${key}`, def[key]]);
      }
      if (Array.isArray(def.items)) def.items.forEach((c, i) => children.push([`[${i}]`, c]));
      if (Array.isArray(def.options)) def.options.forEach((c, i) => children.push([`|${i}`, c]));
      for (const [suffix, child] of children) visit(child, `${path}${suffix}`, seen);
    };
    for (const command of listCommands()) {
      const validator = command.paramsValidator;
      if (validator) visit(validator, command.name, new Set());
    }
    expect(offenders).toEqual([]);
  });
});
