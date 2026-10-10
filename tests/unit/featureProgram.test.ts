import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { type GeometryKernel, type MeshData, setGeometryKernel } from '@core/geometry/kernel';
import { buildFeatureProgram } from '@core/codegen/featureProgram';
import { translateExpression } from '@core/codegen/identifiers';
import type { Feature, FeatureProgram, ShapeSpec, Term } from '@core/codegen/program';
import { emitPython } from '@core/codegen/python';
import { emitOpenScad } from '@core/codegen/openscad';
import { emitFreeCad } from '@core/codegen/freecad';
import {
  formatDegrees,
  formatNumber,
  formatTerm,
  numberRows,
  stepHeading,
} from '@core/codegen/format';
import { fakeKernel } from '../helpers/fakeKernel';

const cannedMesh: MeshData = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
};
const cannedKernel: GeometryKernel = fakeKernel({ boolean: cannedMesh });

beforeEach(() => {
  setGeometryKernel(cannedKernel);
});
afterEach(() => {
  setGeometryKernel(null);
});

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  return execute(doc, name, params).document;
}

function project(doc: CadDocument, actions: unknown[]): CadDocument {
  return execute(doc, 'build_project', { actions }).document;
}

function program(doc: CadDocument): FeatureProgram {
  return buildFeatureProgram(doc, getCommand);
}

const t = (value: number, expression?: string): Term =>
  expression === undefined ? { value } : { value, expression };

describe('translateExpression', () => {
  const ids = new Map([
    ['width', 'width'],
    ['len', 'len_1'],
  ]);

  it('maps identifiers and normalises spacing', () => {
    expect(translateExpression('width*2 + len', ids)).toBe('width * 2 + len_1');
    expect(translateExpression('(width+1)/2', ids)).toBe('(width + 1) / 2');
    expect(translateExpression('  -width ', ids)).toBe('- width');
  });

  it('keeps decimal and exponent numbers', () => {
    expect(translateExpression('1.5e3 * width + .5', ids)).toBe('1.5e3 * width + .5');
  });

  it('returns null for an unknown identifier', () => {
    expect(translateExpression('width + missing', ids)).toBeNull();
  });

  it('returns null for characters outside the grammar', () => {
    expect(translateExpression('width ^ 2', ids)).toBeNull();
    expect(translateExpression('width, 2', ids)).toBeNull();
    expect(translateExpression('width % 2', ids)).toBeNull();
  });

  it('returns null for an empty expression', () => {
    expect(translateExpression('   ', ids)).toBeNull();
    expect(translateExpression('', ids)).toBeNull();
  });
});

describe('parameters', () => {
  it('orders parameters so each follows the ones it references and keeps literals as values', () => {
    let doc = createEmptyDocument();
    doc = run(doc, 'set_parameter', { name: 'a', expression: 'b * 2' });
    doc = run(doc, 'set_parameter', { name: 'b', expression: '3' });
    doc = run(doc, 'set_parameter', { name: 'c', expression: 'a + b' });
    const p = program(doc);
    expect(p.parameters.map((x) => x.name)).toEqual(['b', 'a', 'c']);
    expect(p.parameters.find((x) => x.name === 'b')).toEqual({
      name: 'b',
      identifier: 'b',
      value: 3,
    });
    expect(p.parameters.find((x) => x.name === 'a')?.expression).toBe('b * 2');
    expect(p.parameters.find((x) => x.name === 'c')?.expression).toBe('a + b');
  });

  it('allocates unique, safe identifiers (reserved words, spaces, digits, collisions)', () => {
    const parameters: CadDocument['parameters'] = {
      len: { name: 'len', expression: '1', value: 1 },
      'my width': { name: 'my width', expression: '2', value: 2 },
      my_width: { name: 'my_width', expression: '3', value: 3 },
      '3d': { name: '3d', expression: '4', value: 4 },
      '!!!': { name: '!!!', expression: '5', value: 5 },
      box: { name: 'box', expression: '6', value: 6 },
      cut: { name: 'cut', expression: '7', value: 7 },
    };
    const p = program({ ...createEmptyDocument(), parameters });
    const idOf = (name: string): string => p.parameters.find((x) => x.name === name)!.identifier;
    expect(idOf('len')).toBe('len_1');
    expect(idOf('my width')).toBe('my_width');
    expect(idOf('my_width')).toBe('my_width_2');
    expect(idOf('3d')).toBe('n_3d');
    expect(idOf('!!!')).toBe('item');
    expect(idOf('box')).toBe('box_1');
    expect(idOf('cut')).toBe('cut_1');
    expect(new Set(p.parameters.map((x) => x.identifier)).size).toBe(p.parameters.length);
  });

  it('exports errored parameters as plain values and survives dependency cycles', () => {
    const parameters: CadDocument['parameters'] = {
      broken: { name: 'broken', expression: 'zzz', value: 0, error: 'unknown identifier' },
      x: { name: 'x', expression: 'y + 1', value: 0 },
      y: { name: 'y', expression: 'x + 1', value: 0 },
      weird: { name: 'weird', expression: 'pow(2, 3)', value: 8 },
    };
    const p = program({ ...createEmptyDocument(), parameters });
    expect(p.parameters).toHaveLength(4);
    expect(p.parameters.find((x) => x.name === 'broken')).toEqual({
      name: 'broken',
      identifier: 'broken',
      value: 0,
    });
    // Unsupported grammar (function call) degrades to the value.
    expect(p.parameters.find((x) => x.name === 'weird')).toEqual({
      name: 'weird',
      identifier: 'weird',
      value: 8,
    });
  });

  it('avoids collisions between entity variables and parameter identifiers (snapshot)', () => {
    let doc = run(createEmptyDocument(), 'set_parameter', { name: 'Plate', expression: '1' });
    doc = run(doc, 'add_box', { size: [1, 1, 1] });
    doc = run(doc, 'add_box', { size: [2, 2, 2] });
    doc = run(doc, 'set_entity_name', { id: doc.order[0], name: 'Plate' });
    doc = run(doc, 'set_entity_name', { id: doc.order[1], name: 'Plate' });
    const p = program({ ...doc, featureHistory: [] });
    expect(p.source).toBe('snapshot');
    expect(p.parameters[0]?.identifier).toBe('Plate');
    expect(p.features.map((f) => f.variable)).toEqual(['Plate_2', 'Plate_3']);
    expect(p.outputs.map((o) => o.name)).toEqual(['Plate', 'Plate']);
  });
});

describe('history lowering', () => {
  it('lowers primitives, booleans, translate, label and outputs in history order', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [4, 4, 4], color: '#111111' });
    doc = run(doc, 'add_cylinder', { radius: 1, height: 9 });
    const [boxId, cylinderId] = doc.order as [string, string];
    doc = run(doc, 'boolean_subtract', { a: boxId, b: cylinderId });
    const cutId = doc.order[0]!;
    doc = run(doc, 'move_entity', { id: cutId, delta: [1, 2, 3] });
    doc = run(doc, 'set_entity_name', { id: cutId, name: 'Block' });
    const p = program(doc);
    expect(p.source).toBe('history');
    expect(p.features.map((f) => `${f.op}:${f.variable}`)).toEqual([
      'solid:box_1',
      'solid:cylinder_1',
      'boolean:box_1',
      'translate:box_1',
      'label:box_1',
    ]);
    expect(p.features.map((f) => f.step)).toEqual([1, 2, 3, 4, 5]);
    expect(p.features.map((f) => f.command)).toEqual([
      'add_box',
      'add_cylinder',
      'boolean_subtract',
      'move_entity',
      'set_entity_name',
    ]);
    const boolean = p.features[2] as Extract<Feature, { op: 'boolean' }>;
    expect(boolean).toMatchObject({ kind: 'cut', left: 'box_1', right: 'cylinder_1' });
    expect(p.outputs).toEqual([{ variable: 'box_1', color: '#111111', name: 'Block' }]);
    expect(p.notes).toEqual([]);
  });

  it('binds an =expr only when it evaluates to the entity value (binding guard)', () => {
    const doc = project(createEmptyDocument(), [
      { command: 'set_parameter', params: { name: 'width', expression: '80' } },
      // anchor "min" shifts the stored position by size/2, so '=width' no longer equals the value.
      {
        command: 'add_box',
        params: { size: ['=width', 2, 2], position: ['=width', 0, 0], anchor: 'min' },
      },
    ]);
    const feature = program(doc).features[0] as Extract<Feature, { op: 'solid' }>;
    const shape = feature.shape as Extract<ShapeSpec, { kind: 'box' }>;
    expect(shape.size[0]).toEqual({ value: 80, expression: 'width' });
    expect(feature.position[0]).toEqual({ value: 120 });
    expect(feature.position[0].expression).toBeUndefined();
  });

  it('translates compound parameter expressions and keeps plain numbers literal', () => {
    const doc = project(createEmptyDocument(), [
      { command: 'set_parameter', params: { name: 'width', expression: '80' } },
      { command: 'add_box', params: { size: ['=(width + 20) / 2', 1, 1] } },
    ]);
    const feature = program(doc).features[0] as Extract<Feature, { op: 'solid' }>;
    const shape = feature.shape as Extract<ShapeSpec, { kind: 'box' }>;
    expect(shape.size[0]).toEqual({ value: 50, expression: '(width + 20) / 2' });
    expect(shape.size[1]).toEqual({ value: 1 });
  });

  it('turns a metadata-only change into a label feature (no remove/solid)', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    doc = run(doc, 'set_entity_name', { id: doc.order[0], name: 'Lid' });
    const p = program(doc);
    expect(p.features.map((f) => f.op)).toEqual(['solid', 'label']);
    expect(p.features[1]).toMatchObject({ op: 'label', name: 'Lid', variable: 'box_1' });
  });

  it('lowers a geometry modification (scale / rotate) as remove + re-created solid', () => {
    for (const [command, params] of [
      ['scale_entity', { factor: 2 }],
      ['rotate_entity', { delta: [0, 0, Math.PI / 2] }],
    ] as const) {
      let doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
      doc = run(doc, command, { id: doc.order[0], ...params });
      const p = program(doc);
      expect(p.features.map((f) => f.op)).toEqual(['solid', 'remove', 'solid']);
      expect(p.features[2]).toMatchObject({ command, variable: 'box_1' });
      expect(p.outputs).toHaveLength(1);
    }
  });

  it('keeps the scaled size and rotation in the re-created solid', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    doc = run(doc, 'scale_entity', { id: doc.order[0], factor: 3 });
    doc = run(doc, 'rotate_entity', { id: doc.order[0], delta: [0, 0, Math.PI / 2] });
    const last = program(doc).features.at(-1) as Extract<Feature, { op: 'solid' }>;
    expect(last.rotation[2].value).toBeCloseTo(Math.PI / 2, 9);
  });

  it('lowers delete_entity as a remove and drops the solid from the outputs', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    doc = run(doc, 'add_sphere', { radius: 1 });
    doc = run(doc, 'delete_entity', { id: doc.order[0] });
    const p = program(doc);
    expect(p.features.map((f) => f.op)).toEqual(['solid', 'solid', 'remove']);
    expect(p.features[2]?.variable).toBe('box_1');
    expect(p.outputs.map((o) => o.variable)).toEqual(['sphere_1']);
  });

  it('lowers move_entity as a translate with its numeric delta', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    doc = run(doc, 'move_entity', { id: doc.order[0], delta: [1, 0, 0] });
    const move = program(doc).features[1] as Extract<Feature, { op: 'translate' }>;
    expect(move.op).toBe('translate');
    expect(move.delta.map((d) => d.value)).toEqual([1, 0, 0]);
  });

  it('binds a move delta to a parameter expression', () => {
    const doc = project(createEmptyDocument(), [
      { command: 'set_parameter', params: { name: 'dx', expression: '7' } },
      { command: 'add_box', as: 'b', params: { size: [1, 1, 1] } },
      { command: 'move_entity', params: { id: '$b', delta: ['=dx', 0, 0] } },
    ]);
    const move = program(doc).features[1] as Extract<Feature, { op: 'translate' }>;
    expect(move.delta[0]).toEqual({ value: 7, expression: 'dx' });
  });

  it('skips suppressed history steps', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    doc = run(doc, 'add_sphere', { radius: 1 });
    doc = run(doc, 'set_step_suppressed', { stepId: doc.featureHistory[1]!.id, suppressed: true });
    const p = program(doc);
    expect(p.source).toBe('history');
    expect(p.features.map((f) => f.command)).toEqual(['add_box']);
  });

  it('falls back to a snapshot with a note when replay does not reproduce the solids', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    doc = run(doc, 'add_sphere', { radius: 1 });
    const broken: CadDocument = { ...doc, featureHistory: doc.featureHistory.slice(0, 1) };
    const p = program(broken);
    expect(p.source).toBe('snapshot');
    expect(p.features).toHaveLength(2);
    expect(p.features.every((f) => f.step === null)).toBe(true);
    expect(p.notes[0]).toContain('replays to 1 solid(s) but the document has 2');
  });

  it('exports a mesh with a note when the history creates a mesh', () => {
    const doc = run(createEmptyDocument(), 'import_mesh', {
      bodies: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }],
    });
    const p = program(doc);
    const solid = p.features[0] as Extract<Feature, { op: 'solid' }>;
    expect(solid.shape.kind).toBe('mesh');
    expect(solid.position.map((x) => x.value)).toEqual([0, 0, 0]);
    expect(p.notes[0]).toContain("mesh '");
  });

  it('is pure: the document is not mutated', () => {
    const doc = project(createEmptyDocument(), [
      { command: 'set_parameter', params: { name: 'w', expression: '3' } },
      { command: 'add_box', params: { size: ['=w', 1, 1] } },
    ]);
    const before = JSON.stringify(doc);
    program(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('format helpers', () => {
  it('formats numbers and degrees', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(Number.NaN)).toBe('0');
    expect(formatNumber(1e-13)).toBe('0');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatTerm(t(3, 'w'))).toBe('w');
    expect(formatTerm(t(3))).toBe('3');
    expect(formatDegrees(t(Math.PI), 'math.pi')).toBe('180');
    expect(formatDegrees(t(0), 'PI')).toBe('0');
    expect(formatDegrees(t(1, 'a + b'), 'math.pi')).toBe('(a + b) * 180 / math.pi');
  });

  it('packs numbers into rows and numbers step headings', () => {
    expect(numberRows([1, 2, 3, 4, 5], 2)).toEqual(['1, 2', '3, 4', '5']);
    const a: Feature = { op: 'remove', step: 2, command: 'x', variable: 'v' };
    const b: Feature = { op: 'remove', step: 3, command: 'y', variable: 'v' };
    const snap: Feature = { op: 'remove', step: null, command: 'box', variable: 'v' };
    expect(stepHeading(a, undefined)).toBe('step 2 · x');
    expect(stepHeading(a, a)).toBeNull();
    expect(stepHeading(b, a)).toBe('step 3 · y');
    expect(stepHeading(snap, a)).toBe('box');
  });
});

// ---------------------------------------------------------------------------
// Emitters, driven by hand-built programs covering every ShapeSpec kind
// ---------------------------------------------------------------------------

const origin3 = [t(0), t(0), t(0)] as const;
const profile = [
  [t(1), t(0)],
  [t(3), t(0)],
  [t(3), t(2, 'h')],
] as const;

const shapes: ShapeSpec[] = [
  { kind: 'box', size: [t(1), t(2), t(3, 'd')] },
  { kind: 'cylinder', radius: t(1), height: t(2) },
  { kind: 'sphere', radius: t(1) },
  { kind: 'cone', radius: t(1), height: t(2) },
  { kind: 'torus', ringRadius: t(5), tubeRadius: t(1) },
  { kind: 'wedge', size: [t(1), t(2), t(3)] },
  { kind: 'pyramid', baseWidth: t(2, 'w'), baseDepth: t(3), height: t(4) },
  { kind: 'extrusion', profile, depth: t(5) },
  { kind: 'revolution', profile, axis: 'x', angle: t(Math.PI), segments: 16 },
  { kind: 'revolution', profile, axis: 'y', angle: t(Math.PI), segments: 16 },
  { kind: 'revolution', profile, axis: 'z', angle: t(1, 'h'), segments: 16 },
  { kind: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
];

function handProgram(rotation: readonly [Term, Term, Term]): FeatureProgram {
  const features: Feature[] = shapes.map(
    (shape, i): Feature => ({
      op: 'solid',
      step: i + 1,
      command: 'add_x',
      variable: `s${i}`,
      shape,
      position: [t(1), t(0), t(0)],
      rotation,
      color: '#aabbcc',
      ...(i === 0 ? { name: 'First "one"' } : {}),
    }),
  );
  features.push(
    {
      op: 'boolean',
      step: 20,
      command: 'boolean_union',
      variable: 's0',
      kind: 'union',
      left: 's0',
      right: 's1',
    },
    {
      op: 'boolean',
      step: 21,
      command: 'boolean_subtract',
      variable: 's0',
      kind: 'cut',
      left: 's0',
      right: 's2',
    },
    {
      op: 'boolean',
      step: 22,
      command: 'boolean_intersect',
      variable: 's0',
      kind: 'intersect',
      left: 's0',
      right: 's3',
    },
    {
      op: 'translate',
      step: 23,
      command: 'move_entity',
      variable: 's4',
      delta: [t(1, 'w'), t(0), t(0)],
    },
    { op: 'remove', step: 24, command: 'delete_entity', variable: 's5' },
    { op: 'label', step: 25, command: 'set_entity_name', variable: 's6', name: 'L' },
  );
  return {
    units: 'mm',
    source: 'history',
    parameters: [
      { name: 'w', identifier: 'w', value: 2 },
      { name: 'h', identifier: 'h', value: 2, expression: 'w' },
      { name: 'd', identifier: 'd', value: 3 },
    ],
    features,
    outputs: [
      { variable: 's0', color: '#aabbcc', name: 'First' },
      { variable: 's6', color: '#000000' },
    ],
    notes: ['a note'],
  };
}

describe('emitters', () => {
  const plain = handProgram(origin3);
  const rotated = handProgram([t(Math.PI / 2), t(0, 'a'), t(Math.PI, 'h')]);

  it('emits Python for every shape kind, with names, notes and rotation degrees', () => {
    for (const backend of ['cadquery', 'build123d'] as const) {
      const text = emitPython(plain, backend);
      expect(text).toContain('a note');
      expect(text).toContain('w = param("w", 2)');
      expect(text).toContain('h = param("h", w)');
      expect(text).toContain(
        's0 = box((1, 2, d), position=(1, 0, 0), color="#aabbcc", name="First \\"one\\"")',
      );
      expect(text).toContain('s1 = cylinder(1, 2, position=(1, 0, 0)');
      expect(text).toContain('s2 = sphere(1,');
      expect(text).toContain('s3 = cone(1, 2,');
      expect(text).toContain('s4 = torus(5, 1,');
      expect(text).toContain('s5 = wedge((1, 2, 3),');
      expect(text).toContain('s6 = pyramid(w, 3, 4,');
      expect(text).toContain('s7 = extrude([(1, 0), (3, 0), (3, h)], 5,');
      expect(text).toContain(
        's8 = revolve([(1, 0), (3, 0), (3, h)], axis="x", angle=180, segments=16',
      );
      expect(text).toContain('axis="y"');
      expect(text).toContain('angle=(h) * 180 / math.pi, segments=16');
      expect(text).toContain('s11 = mesh([\n    0, 0, 0, 1, 0, 0, 0, 1, 0,\n], color="#aabbcc")');
      expect(text).toContain('s0 = union(s0, s1)');
      expect(text).toContain('s0 = cut(s0, s2)');
      expect(text).toContain('s0 = intersect(s0, s3)');
      expect(text).toContain('s4 = translate(s4, (w, 0, 0))');
      expect(text).toContain('remove(s5)');
      expect(text).toContain('label(s6, "L")');
      expect(text.split('# ── MODEL')[1]).not.toContain('rotation=');
      const spun = emitPython(rotated, backend);
      expect(spun).toContain('rotation=(90, (a) * 180 / math.pi, (h) * 180 / math.pi)');
    }
  });

  it('emits OpenSCAD for every shape kind, nesting rotations Rz then Ry then Rx', () => {
    const text = emitOpenScad(plain);
    expect(text).toContain('module s0_v1() translate([1, 0, 0]) cube([1, 2, d], center = true);');
    expect(text).toContain('cylinder(h = 2, r = 1, center = true)');
    expect(text).toContain('sphere(r = 1)');
    expect(text).toContain('cylinder(h = 2, r1 = 1, r2 = 0)');
    expect(text).toContain('rotate_extrude() translate([5, 0]) circle(r = 1)');
    expect(text).toContain(
      'rotate([90, 0, 90]) linear_extrude(height = 1) polygon([[0, 0], [2, 0], [0, 3]])',
    );
    expect(text).toContain('[-(w) / 2, -1.5, 0]');
    expect(text).toContain('[(w) / 2, 1.5, 0]');
    expect(text).toContain('linear_extrude(height = 5) polygon([[1, 0], [3, 0], [3, h]])');
    expect(text).toContain('rotate([90, 0, 90]) rotate_extrude(angle = 180)');
    expect(text).toContain('rotate([-90, 0, 0]) rotate_extrude(angle = -(180))');
    expect(text).toContain('rotate_extrude(angle = (h) * 180 / PI)');
    expect(text).toContain(
      'polyhedron(points = [\n    [0, 0, 0],\n    [1, 0, 0],\n    [0, 1, 0]\n  ], faces = [[0, 2, 1]])',
    );
    expect(text).toContain('module s0_v2() union() { s0_v1(); s1_v1(); }');
    expect(text).toContain('difference() { s0_v2(); s2_v1(); }');
    expect(text).toContain('intersection() { s0_v3(); s3_v1(); }');
    expect(text).toContain('module s4_v2() translate([w, 0, 0]) s4_v1();');
    expect(text).toContain('// s5 removed');
    expect(text).toContain('// s6 labelled "L"');
    expect(text).toContain('color("#aabbcc") s0_v4(); // First');
    expect(text).toContain('// Note: a note');
    const spun = emitOpenScad(rotated);
    expect(spun).toContain(
      'translate([1, 0, 0]) rotate([90, 0, 0]) rotate([0, (a) * 180 / PI, 0]) rotate([0, 0, (h) * 180 / PI]) cube(',
    );
  });

  it('emits a FreeCAD macro for every shape kind', () => {
    const text = emitFreeCad(plain);
    expect(text).toContain('w = 2  # w');
    expect(text).toContain('h = w  # h');
    expect(text).toContain('s0 = box((1, 2, d), position=(1, 0, 0))');
    expect(text).toContain('s1 = cylinder(1, 2, position=(1, 0, 0))');
    expect(text).toContain('s2 = sphere(1, position=(1, 0, 0))');
    expect(text).toContain('s3 = cone(1, 2,');
    expect(text).toContain('s4 = torus(5, 1,');
    expect(text).toContain('s5 = wedge((1, 2, 3),');
    expect(text).toContain('s6 = pyramid(w, 3, 4,');
    expect(text).toContain('s7 = extrude([(1, 0), (3, 0), (3, h)], 5,');
    expect(text).toContain('s8 = revolve([(1, 0), (3, 0), (3, h)], axis="x", angle=180,');
    expect(text).toContain('s11 = mesh([\n    0, 0, 0, 1, 0, 0, 0, 1, 0,\n])');
    expect(text).toContain('s0 = s0.fuse(s1).removeSplitter()');
    expect(text).toContain('s0 = s0.cut(s2).removeSplitter()');
    expect(text).toContain('s0 = s0.common(s3).removeSplitter()');
    expect(text).toContain('s4 = s4.translated(_vec(w, 0, 0))');
    expect(text).toContain('s5 = None');
    expect(text).toContain('# s6 labelled "L"');
    expect(text).toContain('show(s0, "First", "#aabbcc")');
    expect(text).toContain('show(s6, "solid_2", "#000000")');
    expect(emitFreeCad(rotated)).toContain(
      'rotation=(90, (a) * 180 / math.pi, (h) * 180 / math.pi)',
    );
  });
});
