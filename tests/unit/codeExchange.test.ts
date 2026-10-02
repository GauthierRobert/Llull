import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BoxEntity, CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { stripOuterParens } from '@core/commands/code_trace';
import { MAX_TRACE_FEATURES } from '@core/commands/limits';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { createManifoldKernel } from '@core/geometry/manifoldKernel';
import { __resetIdCounter } from '@lib/id';

interface CodeData {
  format: string;
  language: string;
  fileName: string;
  source: string;
  parameterCount: number;
  featureCount: number;
  solidCount: number;
  notes: string[];
  text: string;
}

function codeOf(doc: CadDocument, language: string, name?: string): CodeData {
  const result = execute(doc, 'export_code', { language, ...(name ? { name } : {}) });
  return result.data as CodeData;
}

/** A model that touches every ShapeSpec kind plus boolean / label / translate. */
function buildRichDoc(): CadDocument {
  const result = execute(createEmptyDocument(), 'build_project', {
    actions: [
      { command: 'set_parameter', params: { name: 'width', expression: '80' } },
      { command: 'set_parameter', params: { name: 'thickness', expression: 'width / 10' } },
      { command: 'set_parameter', params: { name: 'len', expression: '3' } },
      {
        command: 'add_box',
        as: 'plate',
        params: { size: ['=width', 40, '=thickness'], color: '#112233' },
      },
      {
        command: 'add_cylinder',
        as: 'hole',
        params: { radius: 5, height: 50, position: [10, 0, 0] },
      },
      { command: 'boolean_subtract', as: 'cutPlate', params: { a: '$plate', b: '$hole' } },
      { command: 'set_entity_name', params: { id: '$cutPlate', name: 'Plate' } },
      { command: 'move_entity', params: { id: '$cutPlate', delta: ['=width', 0, 0] } },
      { command: 'add_cone', params: { radius: 3, height: 4, rotation: [0.5, 0, '=len'] } },
      { command: 'add_torus', params: { ringRadius: 10, tubeRadius: 2 } },
      { command: 'add_wedge', params: { size: [1, 2, 3] } },
      { command: 'add_pyramid', params: { baseWidth: 2, baseDepth: 3, height: 4 } },
      { command: 'add_sphere', params: { radius: 2 } },
      {
        command: 'extrude_profile',
        params: {
          profile: [
            [0, 0],
            [4, 0],
            [4, '=len'],
          ],
          depth: 5,
        },
      },
      {
        command: 'revolve_profile',
        params: {
          profile: [
            [1, 0],
            [3, 0],
            [3, 2],
          ],
          axis: 'y',
          angle: 3,
        },
      },
    ],
  });
  expect(result.data).toMatchObject({ ok: true });
  return result.document;
}

const cannedMesh: MeshData = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
};

const fakeKernel: GeometryKernel = {
  booleanOp: () => cannedMesh,
  filletEdges: () => null,
  chamferEdges: () => null,
  shellSolid: () => null,
  tessellate: () => null,
};

beforeEach(() => {
  __resetIdCounter();
  setGeometryKernel(fakeKernel);
});

afterEach(() => {
  setGeometryKernel(null);
});

describe('export_code', () => {
  it('exports a CadQuery script with parameters, expressions and ordered features', () => {
    const doc = buildRichDoc();
    const data = codeOf(doc, 'cadquery');
    expect(data).toMatchObject({
      format: 'code',
      language: 'cadquery',
      fileName: 'model.py',
      source: 'history',
      parameterCount: 3,
      solidCount: 8,
    });
    const text = data.text;
    expect(text).toContain('width = param("width", 80)');
    expect(text).toContain('thickness = param("thickness", width / 10)');
    expect(text).toContain('box((width, 40, thickness)');
    expect(text).toContain('cut(');
    expect(text).toContain('label(');
    expect(text).toContain('"Plate"');
    expect(text).toContain('translate(');
    expect(text).toContain('(width, 0, 0)');
    expect(text).toContain('cone(3, 4');
    expect(text).toContain('torus(10, 2');
    expect(text).toContain('wedge((1, 2, 3)');
    expect(text).toContain('pyramid(2, 3, 4');
    expect(text).toContain('sphere(2');
    expect(text).toContain('extrude([(0, 0), (4, 0), (4, len_1)], 5');
    expect(text).toContain('revolve([(1, 0), (3, 0), (3, 2)], axis="y"');
    expect(text).toContain('result = finish()');
    // Expression-driven rotation is emitted symbolically, in degrees.
    expect(text).toContain('(len_1) * 180 / math.pi');
    // Parameters are defined before the model that uses them.
    expect(text.indexOf('width = param')).toBeLessThan(text.indexOf('thickness = param'));
    expect(text.indexOf('thickness = param')).toBeLessThan(text.indexOf('# ── MODEL'));
  });

  it('keeps reserved parameter names as variables but the original name in param()', () => {
    const text = codeOf(buildRichDoc(), 'cadquery').text;
    expect(text).toContain('len_1 = param("len", 3)');
    expect(text).not.toMatch(/^len = /m);
  });

  it('exports build123d with the same model section', () => {
    const data = codeOf(buildRichDoc(), 'build123d');
    expect(data.language).toBe('build123d');
    expect(data.fileName).toBe('model.py');
    expect(data.text).toContain('build123d');
    expect(data.text).toContain('width = param("width", 80)');
    expect(data.text).toContain('box((width, 40, thickness)');
  });

  it('exports OpenSCAD with modules, difference() and centered cubes', () => {
    const data = codeOf(buildRichDoc(), 'openscad');
    expect(data.fileName).toBe('model.scad');
    const text = data.text;
    expect(text).toContain('width = 80; // width');
    expect(text).toContain('thickness = width / 10; // thickness');
    expect(text).toContain('cube([width, 40, thickness], center = true)');
    expect(text).toContain('difference()');
    expect(text).toContain('labelled "Plate"');
    expect(text).toContain('translate([width, 0, 0])');
    expect(text).toContain('rotate_extrude() translate([10, 0]) circle(r = 2)');
    expect(text).toContain('polyhedron(');
    expect(text).toContain('linear_extrude(height = 5)');
    expect(text).toContain('rotate([-90, 0, 0]) rotate_extrude(angle = -(');
    expect(text).toContain('(len_1) * 180 / PI');
    expect(text).toContain('color("#112233")');
  });

  it('exports a FreeCAD macro with .cut( and named results', () => {
    const data = codeOf(buildRichDoc(), 'freecad');
    expect(data.fileName).toBe('model.FCMacro');
    expect(data.text).toContain('.cut(');
    expect(data.text).toContain('box((width, 40, thickness))');
    expect(data.text).toContain('show(box_1, "Plate", "#112233")');
    expect(data.text).toContain('doc.recompute()');
  });

  it('supports union and intersect booleans in every language', () => {
    const build = (command: string): CadDocument =>
      execute(createEmptyDocument(), 'build_project', {
        actions: [
          { command: 'add_box', as: 'a', params: { size: [2, 2, 2] } },
          { command: 'add_box', as: 'b', params: { size: [1, 1, 1], position: [1, 0, 0] } },
          { command, params: { a: '$a', b: '$b' } },
        ],
      }).document;
    const union = build('boolean_union');
    expect(codeOf(union, 'cadquery').text).toContain('= union(box_1, box_2)');
    expect(codeOf(union, 'openscad').text).toContain('union() {');
    expect(codeOf(union, 'freecad').text).toContain('.fuse(');
    const intersect = build('boolean_intersect');
    expect(codeOf(intersect, 'cadquery').text).toContain('= intersect(box_1, box_2)');
    expect(codeOf(intersect, 'openscad').text).toContain('intersection() {');
    expect(codeOf(intersect, 'freecad').text).toContain('.common(');
  });

  it('removes deleted solids from the outputs and records the removal', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const id = doc.order[0]!;
    doc = execute(doc, 'add_sphere', { radius: 1 }).document;
    doc = execute(doc, 'delete_entity', { id }).document;
    const data = codeOf(doc, 'cadquery');
    expect(data.solidCount).toBe(1);
    expect(data.text).toContain('remove(box_1)');
    expect(codeOf(doc, 'openscad').text).toContain('// box_1 removed');
    expect(codeOf(doc, 'freecad').text).toContain('box_1 = None');
  });

  it('falls back to a mesh with a note for geometry that has no analytic form', () => {
    const imported = execute(createEmptyDocument(), 'import_mesh', {
      bodies: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], name: 'Tri' }],
    });
    const doc = imported.document;
    const cq = codeOf(doc, 'cadquery');
    expect(cq.source).toBe('history');
    expect(cq.text).toContain('mesh([');
    expect(cq.notes.join(' ')).toContain('triangle mesh');
    const result = execute(doc, 'export_code', { language: 'cadquery' });
    expect(result.summary).toContain('Notes:');
    expect(codeOf(doc, 'openscad').text).toContain('polyhedron(points');
    expect(codeOf(doc, 'freecad').text).toContain('mesh([');
  });

  it('exports the current geometry as a snapshot when there is no history', () => {
    const built = execute(createEmptyDocument(), 'add_box', {
      size: [1, 2, 3],
      position: [4, 0, 0],
      rotation: [0, 0, Math.PI / 2],
    });
    const named = execute(built.document, 'set_entity_name', {
      id: built.affected[0]!,
      name: 'Block',
    });
    const doc: CadDocument = { ...named.document, featureHistory: [] };
    const data = codeOf(doc, 'cadquery');
    expect(data.source).toBe('snapshot');
    expect(data.solidCount).toBe(1);
    expect(data.text).toContain('Block = box((1, 2, 3), position=(4, 0, 0), rotation=(0, 0, 90)');
    expect(data.text).toContain('name="Block"');
    const scad = codeOf(doc, 'openscad').text;
    expect(scad).toContain(
      'translate([4, 0, 0]) rotate([0, 0, 90]) cube([1, 2, 3], center = true)',
    );
    expect(codeOf(doc, 'freecad').text).toContain('rotation=(0, 0, 90)');
  });

  it('uses the snapshot and explains why when replaying the history does not reproduce the model', () => {
    const built = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const extra = execute(built.document, 'add_sphere', { radius: 1 });
    // Drop the sphere step but keep its entity: replay yields 1 solid, the document has 2.
    const doc: CadDocument = {
      ...extra.document,
      featureHistory: extra.document.featureHistory.slice(0, 1),
    };
    const data = codeOf(doc, 'cadquery');
    expect(data.source).toBe('snapshot');
    expect(data.solidCount).toBe(2);
    expect(data.notes.join(' ')).toContain('replays to 1 solid(s) but the document has 2');
    expect(data.text).toContain('sphere(1');
  });

  it('ignores suppressed steps when they are the only ones', () => {
    const built = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const doc: CadDocument = {
      ...built.document,
      featureHistory: built.document.featureHistory.map((s) => ({ ...s, suppressed: true })),
    };
    expect(codeOf(doc, 'cadquery').source).toBe('snapshot');
  });

  it('sanitizes the file name', () => {
    const data = codeOf(buildRichDoc(), 'cadquery', 'my part/../x y');
    expect(data.fileName).toBe('my_part_.._x_y.py');
    expect(codeOf(buildRichDoc(), 'openscad', '///').fileName).toBe('model.scad');
    expect(codeOf(buildRichDoc(), 'cadquery', '.hidden').fileName).toBe('hidden.py');
    expect(codeOf(buildRichDoc(), 'cadquery', '').fileName).toBe('model.py');
  });

  it('is a no-op with a summary for an unknown language', () => {
    const doc = buildRichDoc();
    const result = execute(doc, 'export_code', { language: 'fortran' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.data).toBeUndefined();
    expect(result.summary).toContain('export_code rejected: invalid params');
  });

  it('exports an empty document without error', () => {
    const data = codeOf(createEmptyDocument(), 'cadquery');
    expect(data).toMatchObject({ source: 'snapshot', solidCount: 0, featureCount: 0 });
    expect(data.text).toContain('# (none)');
    expect(codeOf(createEmptyDocument(), 'openscad').text).toContain('// (none)');
    expect(codeOf(createEmptyDocument(), 'freecad').text).toContain('# (none)');
  });

  it('is read-only: same document reference, no history appended, affected empty', () => {
    const doc = buildRichDoc();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'export_code', { language: 'cadquery' });
    expect(result.document).toBe(doc);
    expect(result.document.featureHistory).toHaveLength(doc.featureHistory.length);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('export_code (cadquery): 3 parameter(s)');
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('stripOuterParens', () => {
  it('removes parentheses that enclose the whole expression', () => {
    expect(stripOuterParens('(a + b)')).toBe('a + b');
    expect(stripOuterParens(' ((a)) ')).toBe('a');
  });

  it('keeps parentheses that do not enclose the whole expression', () => {
    expect(stripOuterParens('(a) + (b)')).toBe('(a) + (b)');
    expect(stripOuterParens('a * (b + c)')).toBe('a * (b + c)');
  });
});

// ---------------------------------------------------------------------------
// apply_code_trace
// ---------------------------------------------------------------------------

/** What the generated CadQuery runtime records for: width/thickness params, box, cylinder, cut, name. */
function plateTrace(): unknown {
  return {
    parameters: [
      { name: 'width', expression: '80' },
      { name: 'thickness', expression: '(width / 10)' },
    ],
    features: [
      {
        command: 'add_box',
        ref: 'f1',
        params: {
          size: [
            { value: 80, expression: 'width' },
            { value: 40 },
            { value: 8, expression: '(width / 10)' },
          ],
          position: [{ value: 0 }, { value: 0 }, { value: 0 }],
          rotation: [{ value: 0 }, { value: 0 }, { value: 0 }],
          color: '#112233',
        },
      },
      {
        command: 'add_cylinder',
        ref: 'f2',
        params: {
          radius: { value: 5 },
          height: { value: 50 },
          position: [{ value: 10 }, { value: 0 }, { value: 0 }],
        },
      },
      {
        command: 'boolean_subtract',
        ref: 'f3',
        name: 'Plate',
        params: { a: { ref: 'f1' }, b: { ref: 'f2' } },
      },
    ],
  };
}

function solids(doc: CadDocument): number {
  return doc.order.filter((id) => doc.entities[id]?.kind !== undefined).length;
}

describe('apply_code_trace', () => {
  it('rebuilds parameters, features, booleans and names from a trace', () => {
    const result = execute(createEmptyDocument(), 'apply_code_trace', { trace: plateTrace() });
    expect(result.summary).toContain(
      'apply_code_trace (replace): 2 parameter(s) [width, thickness]',
    );
    expect(result.summary).toContain('3 feature(s) → 1 solid(s)');
    expect(result.affected).toHaveLength(1);
    const doc = result.document;
    expect(doc.parameters.width?.value).toBe(80);
    expect(doc.parameters.thickness?.expression).toBe('width / 10');
    expect(doc.order).toEqual(result.affected);
    const plate = doc.entities[result.affected[0]!]!;
    expect(plate.kind).toBe('mesh');
    expect(plate.name).toBe('Plate');
    const names = doc.featureHistory.map((s) => s.name);
    expect(names).toEqual(['add_box', 'add_cylinder', 'boolean_subtract', 'set_entity_name']);
  });

  it('records parameter-driven terms as =expr and resolves refs to entity ids', () => {
    const doc = execute(createEmptyDocument(), 'apply_code_trace', {
      trace: plateTrace(),
    }).document;
    const boxStep = doc.featureHistory[0]!;
    const params = boxStep.params as { size: unknown[]; color: string };
    expect(params.size).toEqual(['=width', 40, '=width / 10']);
    const subtract = doc.featureHistory[2]!.params as { a: string; b: string };
    expect(subtract.a).toBe(doc.featureHistory[0]!.affected![0]);
    expect(subtract.b).toBe(doc.featureHistory[1]!.affected![0]);
  });

  it('regenerates after set_parameter + replay_history', () => {
    let doc = execute(createEmptyDocument(), 'apply_code_trace', {
      trace: {
        parameters: [{ name: 'width', expression: '80' }],
        features: [
          {
            command: 'add_box',
            ref: 'f1',
            params: { size: [{ value: 80, expression: 'width' }, { value: 4 }, { value: 4 }] },
          },
        ],
      },
    }).document;
    const id = doc.order[0]!;
    expect((doc.entities[id] as BoxEntity).size[0]).toBe(80);
    doc = execute(doc, 'set_parameter', { name: 'width', expression: '120' }).document;
    doc = execute(doc, 'replay_history', {}).document;
    expect(doc.order).toHaveLength(1);
    expect((doc.entities[doc.order[0]!] as BoxEntity).size[0]).toBe(120);
  });

  it('keeps a literal when the expression references a non-parameter or is not parseable', () => {
    const result = execute(createEmptyDocument(), 'apply_code_trace', {
      trace: {
        parameters: [],
        features: [
          {
            command: 'add_sphere',
            ref: 'f1',
            params: { radius: { value: 3, expression: 'missing * 2' } },
          },
          { command: 'add_sphere', ref: 'f2', params: { radius: { value: 4, expression: '2 +' } } },
          {
            command: 'add_sphere',
            ref: 'f3',
            params: { radius: { value: 5, expression: '3 + 2' } },
          },
        ],
      },
    });
    expect(result.affected).toHaveLength(3);
    expect(
      result.document.featureHistory.map((s) => (s.params as { radius: unknown }).radius),
    ).toEqual([3, 4, 5]);
  });

  it('replaces by default and keeps view/organisation state; append adds on top', () => {
    const base = execute(createEmptyDocument(), 'add_sphere', { radius: 1 }).document;
    const replaced = execute(base, 'apply_code_trace', { trace: plateTrace() });
    expect(replaced.document.order).toHaveLength(1);
    expect(replaced.document.order).not.toContain(base.order[0]);
    expect(replaced.document.units).toBe(base.units);
    expect(replaced.document.layers).toBe(base.layers);

    const appended = execute(base, 'apply_code_trace', { trace: plateTrace(), mode: 'append' });
    expect(appended.summary).toContain('apply_code_trace (append)');
    expect(appended.document.order).toHaveLength(2);
    expect(appended.document.order).toContain(base.order[0]);
    expect(appended.document.featureHistory.length).toBeGreaterThan(base.featureHistory.length);
  });

  it('imports mesh bodies, translates, deletes and renames through refs', () => {
    const result = execute(createEmptyDocument(), 'apply_code_trace', {
      trace: {
        parameters: [],
        features: [
          {
            command: 'import_mesh',
            ref: 'f1',
            name: 'Tri',
            params: { bodies: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }] },
          },
          { command: 'add_sphere', ref: 'f2', params: { radius: { value: 1 } } },
          {
            command: 'move_entity',
            params: { id: { ref: 'f2' }, delta: [{ value: 1 }, { value: 0 }, { value: 0 }] },
          },
          { command: 'delete_entity', params: { id: { ref: 'f2' } } },
        ],
      },
    });
    expect(result.affected).toHaveLength(1);
    const mesh = result.document.entities[result.affected[0]!]!;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.name).toBe('Tri');
    expect(result.document.order).toEqual(result.affected);
  });

  it('accepts a trace with no features and no parameters', () => {
    const result = execute(createEmptyDocument(), 'apply_code_trace', {
      trace: { parameters: [], features: [] },
    });
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('0 feature(s) → 0 solid(s): none');
  });

  it('is pure: the input document is untouched', () => {
    const base = execute(createEmptyDocument(), 'add_sphere', { radius: 1 }).document;
    const before = JSON.stringify(base);
    execute(base, 'apply_code_trace', { trace: plateTrace() });
    execute(base, 'apply_code_trace', { trace: plateTrace(), mode: 'append' });
    expect(JSON.stringify(base)).toBe(before);
  });

  it('is a meta-history command: it does not append itself to featureHistory', () => {
    const result = execute(createEmptyDocument(), 'apply_code_trace', { trace: plateTrace() });
    expect(result.document.featureHistory.some((s) => s.name === 'apply_code_trace')).toBe(false);
  });

  describe('failures leave the document unchanged', () => {
    const base = (): CadDocument =>
      execute(createEmptyDocument(), 'add_sphere', { radius: 1 }).document;

    function expectAbort(trace: unknown, reason: string, mode?: 'append' | 'replace'): void {
      const doc = base();
      const before = JSON.stringify(doc);
      const result = execute(doc, 'apply_code_trace', { trace, ...(mode ? { mode } : {}) });
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain('apply_code_trace:');
      expect(result.summary).toContain(reason);
      expect(result.summary).toContain('document unchanged');
      expect(JSON.stringify(doc)).toBe(before);
    }

    it('rejects a non-object trace', () => {
      for (const trace of ['nope', null, []]) {
        const doc = createEmptyDocument();
        const result = execute(doc, 'apply_code_trace', { trace });
        expect(result.document).toBe(doc);
        expect(result.affected).toEqual([]);
        expect(result.summary).toContain('apply_code_trace rejected: invalid params');
      }
    });

    it('rejects a trace without parameters/features arrays', () => {
      expectAbort({ parameters: [] }, 'needs "parameters" and "features" arrays');
      expectAbort({ features: [] }, 'needs "parameters" and "features" arrays');
    });

    it('rejects too many features', () => {
      const features = Array.from({ length: MAX_TRACE_FEATURES + 1 }, () => ({
        command: 'add_sphere',
        params: {},
      }));
      expectAbort({ parameters: [], features }, 'exceeds MAX_TRACE_FEATURES');
    });

    it('rejects a bad parameter name or expression', () => {
      expectAbort(
        { parameters: [{ name: '1bad', expression: '3' }], features: [] },
        'name must be an identifier',
      );
      expectAbort({ parameters: ['x'], features: [] }, 'parameter 0');
      expectAbort(
        { parameters: [{ name: 'a', expression: '  ' }], features: [] },
        'expression must be a non-empty string',
      );
      expectAbort(
        { parameters: [{ name: 'a', expression: 3 }], features: [] },
        'expression must be a non-empty string',
      );
    });

    it('rejects a parameter whose expression does not evaluate', () => {
      expectAbort(
        { parameters: [{ name: 'a', expression: 'zzz + 1' }], features: [] },
        'parameter a = zzz + 1',
      );
    });

    it('rejects malformed features', () => {
      expectAbort(
        { parameters: [], features: [{ command: 'add_box' }] },
        'feature 0: needs { command, params }',
      );
      expectAbort({ parameters: [], features: [null] }, 'feature 0: needs { command, params }');
      expectAbort(
        { parameters: [], features: [{ command: 3, params: {} }] },
        'needs { command, params }',
      );
    });

    it('rejects commands outside the trace whitelist', () => {
      expectAbort(
        { parameters: [], features: [{ command: 'clear_document', params: {} }] },
        'command "clear_document" is not allowed in a code trace',
      );
      expectAbort(
        { parameters: [], features: [{ command: 'build_project', params: { actions: [] } }] },
        'not allowed',
        'append',
      );
    });

    it('rejects an unknown ref', () => {
      expectAbort(
        {
          parameters: [],
          features: [{ command: 'delete_entity', params: { id: { ref: 'f9' } } }],
        },
        'unknown solid reference "f9"',
      );
    });

    it('rejects non-finite numbers', () => {
      expectAbort(
        {
          parameters: [],
          features: [
            { command: 'add_sphere', params: { radius: { value: Number.POSITIVE_INFINITY } } },
          ],
        },
        'non-finite number',
      );
      expectAbort(
        { parameters: [], features: [{ command: 'add_sphere', params: { radius: Number.NaN } }] },
        'non-finite number',
      );
    });

    it('rolls back fully when a later feature fails', () => {
      expectAbort(
        {
          parameters: [{ name: 'w', expression: '5' }],
          features: [
            { command: 'add_sphere', ref: 'f1', params: { radius: { value: 1 } } },
            {
              command: 'add_box',
              ref: 'f2',
              params: { size: [{ value: -1 }, { value: 1 }, { value: 1 }] },
            },
          ],
        },
        'feature 1 (add_box) failed',
        'append',
      );
    });
  });

  it('turns a trace shaped like the Python runtime output into the same model as the commands', () => {
    const direct = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'add_box', as: 'a', params: { size: [4, 4, 4] } },
        { command: 'add_cylinder', as: 'b', params: { radius: 1, height: 10 } },
        { command: 'boolean_subtract', params: { a: '$a', b: '$b' } },
      ],
    }).document;
    const traced = execute(createEmptyDocument(), 'apply_code_trace', {
      trace: {
        parameters: [],
        features: [
          {
            command: 'add_box',
            ref: 'f1',
            params: {
              size: [{ value: 4 }, { value: 4 }, { value: 4 }],
              position: [{ value: 0 }, { value: 0 }, { value: 0 }],
              rotation: [{ value: 0 }, { value: 0 }, { value: 0 }],
            },
          },
          {
            command: 'add_cylinder',
            ref: 'f2',
            params: {
              radius: { value: 1 },
              height: { value: 10 },
              position: [{ value: 0 }, { value: 0 }, { value: 0 }],
              rotation: [{ value: 0 }, { value: 0 }, { value: 0 }],
            },
          },
          {
            command: 'boolean_subtract',
            ref: 'f3',
            params: { a: { ref: 'f1' }, b: { ref: 'f2' } },
          },
        ],
      },
    }).document;
    expect(traced.featureHistory.map((s) => s.name)).toEqual(
      direct.featureHistory.map((s) => s.name),
    );
    expect(solids(traced)).toBe(solids(direct));
  });
});

describe('with the real Manifold kernel', () => {
  it('round-trips export → hand-built trace and keeps booleans exact', async () => {
    setGeometryKernel(await createManifoldKernel());
    const doc = buildRichDoc();
    expect(codeOf(doc, 'cadquery').solidCount).toBe(8);
    const result = execute(createEmptyDocument(), 'apply_code_trace', { trace: plateTrace() });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]?.kind).toBe('mesh');
  });
});
