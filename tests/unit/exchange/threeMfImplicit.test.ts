/** 3MF Volumetric & Implicit writer (05 IMP 6.2, FR-IMP-52): every tape op becomes native nodes without a forward reference. */
import { describe, expect, it } from 'vitest';
import { latticeObjectXml, otherObjectXml } from '@core/commands/exchange/threeMfBeamLattice';
import { implicitFunctionXml, levelSetXml } from '@core/commands/exchange/threeMfImplicit';
import { FieldBuilder } from '@core/geometry/field/build';
import type { FieldProgram } from '@core/geometry/field/program';

const META = { bounds: null, lipschitz: 1, quality: 'exact' } as const;
const cube = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1],
  indices: [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5],
};

/** Every identifier referenced by `ref="node.output"` is defined before its use. */
function noForwardReference(xml: string): void {
  const defined = new Set<string>(['inputs']);
  for (const line of xml.split('\n')) {
    for (const m of line.matchAll(/ref="([A-Za-z0-9_]+)\.[a-z]+"/g))
      expect(defined.has(m[1] as string), `${m[1]} used before definition`).toBe(true);
    const id = /<i:(?!in|out|scalar|vector|resourceref)[a-z0-9]+ identifier="([A-Za-z0-9_]+)"/.exec(line);
    if (id !== null) defined.add(id[1] as string);
  }
}

describe('implicitFunctionXml', () => {
  it('writes arithmetic, trigonometry, clamp, select, rounding and non-finite constants', () => {
    const b = new FieldBuilder('mm');
    const [x, y, z] = [b.x(), b.y(), b.z()];
    const a = b.op('atan2', y, x);
    const trig = b.add(b.op('sin', a), b.op('cos', z));
    const round = b.add(b.op('floor', x), b.op('fract', y));
    const picked = b.op('select', b.op('sub', x, y), trig, round);
    const clamped = b.op('clamp', picked, b.constant(-1), b.constant(Infinity));
    const mixed = b.add(b.op('div', clamped, b.constant(NaN)), b.op('abs', b.op('neg', b.op('sqrt', b.op('square', z)))));
    const program = b.finish(b.op('max', b.op('min', mixed, b.constant(-Infinity)), b.op('mul', x, y)), META);
    const xml = implicitFunctionXml(7, 'a <&> b', program, []);
    for (const tag of [
      'atan2',
      'sin',
      'cos',
      'floor',
      'fract',
      'select',
      'clamp',
      'division',
      'abs',
      'pow',
      'multiplication',
      'min',
      'max',
      'subtraction',
    ])
      expect(xml, tag).toContain(`<i:${tag} `);
    expect(xml).toContain('value="NaN"');
    expect(xml).toContain('value="INF"');
    expect(xml).toContain('value="-INF"');
    expect(xml).toContain('displayname="a &lt;&amp;&gt; b"');
    expect(xml).toContain('<i:out><i:scalarref identifier="shape"');
    noForwardReference(xml);
  });

  it('expands the three blends and refuses nothing it can write', () => {
    for (const op of ['smin_quad', 'smin_exp', 'chamfer_min'] as const) {
      const b = new FieldBuilder('mm');
      const program = b.finish(b.op(op, b.x(), b.y(), b.constant(0.5)), META);
      const xml = implicitFunctionXml(1, op, program, []);
      noForwardReference(xml);
      expect(xml).toContain('<i:min ');
    }
  });

  it('reads a mesh operand directly from the position input, or through composevector when the point is moved', () => {
    const b = new FieldBuilder('mm');
    const direct = b.meshSdf('cube', cube, b.x(), b.y(), b.z());
    const moved = b.meshSdf('cube2', cube, b.add(b.x(), b.constant(1)), b.y(), b.z());
    const program: FieldProgram = b.finish(b.op('min', direct, moved), META);
    const xml = implicitFunctionXml(3, 'mesh', program, [11, 12]);
    expect(xml).toContain('ref="inputs.pos"/><i:resourceref>11</i:resourceref>');
    expect(xml).toContain('<i:composevector ');
    expect(xml).toContain('<i:resourceref>12</i:resourceref>');
    noForwardReference(xml);
  });
});

describe('levelSetXml', () => {
  it('allocates ids for operand meshes, the domain box and the function, and scales object to function coordinates', () => {
    const b = new FieldBuilder('mm');
    const program = b.finish(b.meshSdf('cube', cube, b.x(), b.y(), b.z()), META);
    const tri = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ] as [[number, number, number], [number, number, number], [number, number, number]];
    const made = levelSetXml(2, 5, 'body', 0, { program, toFunction: 0.5, minFeatureSize: 0.2, domain: [tri], meshes: [[tri]] });
    expect(made.nextId).toBe(8);
    expect(made.resources).toHaveLength(3);
    expect(made.object).toContain('functionid="7"');
    expect(made.object).toContain('meshid="6"');
    expect(made.object).toContain('transform="0.5 0 0 0 0.5 0 0 0 0.5 0 0 0"');
    expect(made.object).toContain('minfeaturesize="0.2"');
  });
});

describe('beam lattice and helper object writers', () => {
  it('writes a lattice without clipping or representation mesh and without balls', () => {
    const xml = latticeObjectXml(
      3,
      'lattice',
      0,
      {
        nodes: [
          [0, 0, 0],
          [3, 0, 0],
        ],
        beams: [{ a: 0, b: 1, r1: 0.5, r2: 0.4, cap1: 'sphere', cap2: 'butt' }],
        radius: 0.5,
        ballRadius: null,
        clip: null,
        representation: null,
      },
      { clip: null, representation: null },
    );
    expect(xml).toContain('minlength="1.5"');
    expect(xml).not.toContain('clippingmesh');
    expect(xml).not.toContain('representationmesh');
    expect(xml).not.toContain('ballmode');
  });

  it('drops the triangles that collapse when the vertices are welded', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0, 0];
    const c: [number, number, number] = [0, 1, 0];
    const xml = otherObjectXml(4, 'helper', [
      [a, b, c],
      [a, a, c],
    ]);
    expect(xml.match(/<triangle /g)).toHaveLength(1);
  });
});
