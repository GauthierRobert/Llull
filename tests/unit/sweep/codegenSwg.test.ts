/**
 * 02 SWG code export (DES-2c): every sweep / loft variant is lowered to a traced `sweep_profile(...)` / `loft_sections(...)` call whose build is
 * the library's own construction where it maps faithfully (pipe shell, exact helix, mitre, thru-sections) and fitted B-spline faces (kept in a
 * DATA section) otherwise; what no target can express keeps the exact triangle mesh with a named SWG_CODEGEN_UNSUPPORTED reason.
 * The generated code is executed in server/tests/sweepLoftCodeExecution.integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { skinShape } from '@core/codegen/skinLowering';
import { tracedCall } from '@core/codegen/paramTree';
import { type CadDocument, type Entity, type LoftEntity, type SweepEntity, type Vec2, createEmptyDocument } from '@core/model/types';
import { runSwgPlan, swgPlan } from '../../helpers/swgPack';

type Language = 'cadquery' | 'build123d' | 'freecad' | 'openscad';

interface Exported {
  readonly text: string;
  readonly notes: string[];
}

function exported(doc: CadDocument, language: Language): Exported {
  const result = execute(doc, 'export_code', { language });
  const data = result.data as { text: string; notes: string[] };
  expect(data.text.length, result.summary).toBeGreaterThan(0);
  return data;
}

function created(doc: CadDocument, command: string, params: unknown): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return { doc: result.document, id: result.affected[0] as string };
}

/** The document with one entity replaced by `edit(entity)` (the history then no longer regenerates it: the export is the snapshot). */
function edited(doc: CadDocument, id: string, edit: (entity: Entity) => Entity): CadDocument {
  return { ...doc, entities: { ...doc.entities, [id]: edit(doc.entities[id] as Entity) } };
}

const squareProfile = [
  [-3, -2],
  [3, -2],
  [3, 2],
  [-3, 2],
];
const bar = {
  path: [
    [0, 0, 0],
    [0, 0, 40],
  ],
  section: squareProfile,
};
const L = [
  [0, 0, 0],
  [60, 0, 0],
  [60, 60, 0],
];
const CALLS = ['cadquery', 'build123d', 'freecad'] as const;

describe('sweeps with laws, rails, stations or non-round sections on bent paths are fitted faces in a DATA section', () => {
  const twisted = created(createEmptyDocument(), 'sweep_profile', {
    ...bar,
    twist: { type: 'linear', start: 0, end: Math.PI / 2 },
    scale: { type: 'linear', start: 1, end: 0.5 },
  });

  it.each(CALLS)('%s: one traced sweep_profile call carries the params, the faces are keyed data before the model', (language) => {
    const { text, notes } = exported(twisted.doc, language);
    expect(text).toMatch(
      /^sweep = sweep_profile\(\("faces", "sweep 'swp-1\.1'", "sweep", True, [\d.e-]+\), \{"path": \[0, 0, 0, 0, 0, 40\], /m,
    );
    expect(text).toContain(', path=[[0, 0, 0], [0, 0, 40]], section=');
    expect(text).toContain("# sweep 'swp-1.1': no keyword is read here; every other keyword is only recorded for import_code");
    expect(text).toContain('twist={"type": "linear", "start": 0, "end": 1.57079632679}');
    expect(text).toContain('scale={"type": "linear", "start": 1, "end": 0.5}');
    expect(text.indexOf('_SWG_FACES = {')).toBeGreaterThan(text.indexOf('# ── PARAMETERS'));
    expect(text.indexOf('_SWG_FACES = {')).toBeLessThan(text.indexOf('# ── MODEL'));
    expect(text).toMatch(/_SWG_FACES = \{\n"sweep": \(\n\[\n {2}\(\d, 3, \[\n/);
    expect(text).not.toContain('# SWG_CODEGEN_UNSUPPORTED:');
    expect(notes.join(' ')).not.toContain('SWG_CODEGEN');
  });

  it('OpenSCAD: the exact result as a polyhedron (no freeform call, no data section)', () => {
    const scad = exported(twisted.doc, 'openscad').text;
    expect(scad).toContain('polyhedron(points = [');
    expect(scad).not.toContain('sweep_profile(');
    expect(scad).not.toContain('_SWG_FACES');
  });

  it('a closed non-round path is built without caps; rational round sections with laws carry their weights', () => {
    const ring = created(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 50 });
    const squareRing = created(ring.doc, 'sweep_profile', { pathId: ring.id, section: squareProfile });
    // the path is another entity: the call cannot be replayed from the code alone, so it is the untraced swept(...)
    expect(exported(squareRing.doc, 'cadquery').text).toMatch(/^sweep = swept\(\("faces", "sweep 'swp-[^']+'", "[^"]+", False, /m);
    const wobbly = created(ring.doc, 'sweep_profile', {
      pathId: ring.id,
      radius: 5,
      scale: { type: 'expression', expression: '1 + 0.25*sin(2*pi*t)' },
    });
    expect(exported(wobbly.doc, 'cadquery').text).toMatch(/, \[\[1, [\d.]+, 1, /);
  });

  it('a closed smooth round ring is the library pipe (no fit), traced', () => {
    const ring = created(createEmptyDocument(), 'sweep_profile', {
      path: [
        [20, 0, 0],
        [0, 20, 0],
        [-20, 0, 0],
        [0, -20, 0],
      ],
      smooth: true,
      closed: true,
      radius: 2,
    });
    for (const language of CALLS) {
      const { text } = exported(ring.doc, language);
      expect(text, language).toMatch(/^sweep = sweep_profile\(\("pipe", "sweep 'swp-1\.1'", /m);
      expect(text, language).not.toContain('_SWG_FACES = {');
    }
  });

  it('every sweep of the pack plans lowers (laws, frames, rails, stations)', () => {
    const plans = [
      ['target_twist_scale_orientation', 9],
      ['target_rails_and_surface_mode', 3],
    ] as const;
    for (const [name, solids] of plans) {
      const actions = swgPlan(name).filter(
        (a) => !['check_sweep_loft', 'inspect_sweep', 'sweep_surface', 'measure_area'].includes(a.command),
      );
      const { text, notes } = exported(runSwgPlan(actions).document, 'cadquery');
      expect(text.match(/= (sweep_profile|swept)\(\("/g), name).toHaveLength(solids);
      expect(notes.join(' '), name).not.toContain('SWG_CODEGEN');
    }
  });

  it('a hollow tube with laws is its outer skin with the bore skin cut out of the same data entry', () => {
    const tube = created(createEmptyDocument(), 'sweep_profile', {
      path: [
        [0, 0, 0],
        [0, 0, 50],
      ],
      radius: 5,
      innerRadius: 3,
      scale: { type: 'linear', start: 1, end: 0.5 },
    });
    for (const language of ['cadquery', 'freecad'] as const) {
      const { text } = exported(tube.doc, language);
      expect(text).toMatch(/\],\s*\[\n {2}\(2, 3, \[/);
      expect(text).toContain('innerRadius=3');
    }
  });
});

describe("plain sweeps use the library's own construction", () => {
  it('a round section on a straight or bent path is a pipe shell of the exact path wire, the radius bound to its parameter', () => {
    const built = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'set_parameter', params: { name: 'r', expression: '4' } },
        {
          command: 'sweep_profile',
          params: {
            path: [
              [0, 0, 0],
              [0, 0, 50],
              [30, 0, 80],
            ],
            radius: '=r',
          },
        },
      ],
    });
    for (const language of CALLS) {
      const { text } = exported(built.document, language);
      expect(text).toMatch(/^sweep = sweep_profile\(\("pipe", "sweep 'swp-1.1'", \[\[\(0, 0, 0\), \(0, 0, 45\.0294372515\)\], /m);
      expect(text).toContain(
        '("circle", (0, 0, 0), (0, 0, 1), 4), False, None, 12), {"path": [0, 0, 0, 0, 0, 50, 30, 0, 80], "radius": [4]}, path=[[0, 0, 0], [0, 0, 50], [30, 0, 80]], radius=r',
      );
      // the bends were resolved at 3 x the exported radius: radius cannot be live (it is stale-checked instead)
      expect(text).toContain("# sweep 'swp-1.1': no keyword is read here; every other keyword is only recorded for import_code");
      expect(text).not.toContain('_SWG_FACES = {');
    }
    expect(exported(built.document, 'cadquery').text).toContain('r = param("r", 4)');
  });

  it('radius is live on a bent path only when the bends do not depend on it (explicit bendRadius)', () => {
    const bent = [
      [0, 0, 0],
      [0, 0, 50],
      [30, 0, 80],
    ];
    const explicit = created(createEmptyDocument(), 'sweep_profile', { path: bent, radius: 2, bendRadius: 10 });
    const { text } = exported(explicit.doc, 'cadquery');
    expect(text).toContain('"radius": None, "bendRadius": [10]}, path=');
    // the exported limit: the spine's bend radius; a mitre's tightest leg; none on a straight path
    expect(text).toMatch(/, False, None, 10\), \{"path"/);
    const threeLegs = created(createEmptyDocument(), 'sweep_profile', {
      path: [
        [0, 0, 0],
        [60, 0, 0],
        [60, 30, 0],
        [0, 30, 0],
      ],
      radius: 5,
      corners: 'miter',
    });
    expect(exported(threeLegs.doc, 'cadquery').text).toMatch(/, True, None, 15\), \{"path"/);
    const straight = created(createEmptyDocument(), 'sweep_profile', bar);
    expect(exported(straight.doc, 'cadquery').text).toMatch(/, False, None, None\), \{"path"/);
    expect(text).toContain("# sweep 'swp-1.1': radius (live) is read here;");
    const implicit = created(createEmptyDocument(), 'sweep_profile', { path: bent, radius: 2 });
    expect(exported(implicit.doc, 'cadquery').text).toContain('"radius": [2]}, path=');
  });

  it('a polygon section and a bore', () => {
    const plain = created(createEmptyDocument(), 'sweep_profile', bar);
    expect(exported(plain.doc, 'build123d').text).toMatch(/\("polygon", \[\(-?[\d.]+, /);
    const tube = created(createEmptyDocument(), 'sweep_profile', {
      path: [
        [0, 0, 0],
        [0, 0, 50],
      ],
      radius: 5,
      innerRadius: 3,
    });
    expect(exported(tube.doc, 'cadquery').text).toContain(
      '("circle", (0, 0, 0), (0, 0, 1), 5), False, 3, None), {"path": [0, 0, 0, 0, 0, 50], "radius": None, "innerRadius": None}, path=',
    );
  });

  it('a constant-pitch cylindrical helix with a round section is the exact helix (the library makeHelix construction)', () => {
    let doc = created(createEmptyDocument(), 'add_helix', { position: [0, 0, 0], axis: [0, 0, 1], radius: 20, pitch: 10, turns: 3 });
    doc = created(doc.doc, 'sweep_profile', { pathId: doc.id, radius: 2 });
    for (const language of CALLS) {
      const { text } = exported(doc.doc, language);
      expect(text).toMatch(
        /^sweep = swept\(\("helix", "sweep '[^']+'", \(-20, 0, 0\), \(0, 0, 1\), \(1, 0, 0\), 20, 10, 3, False, 0, \("circle"/m,
      );
    }
    expect(exported(doc.doc, 'cadquery').text).toContain('BuildCurves3d_s(edge, 1e-6, GeomAbs_C1, 14, 2000)');
    expect(exported(doc.doc, 'freecad').text).toContain('Part.makeHelix(');
  });

  it('a cone helix, a screw section and a pitch law stay fitted faces', () => {
    const plan = swgPlan('target_helix_spring_thread').filter((a) => !['check_sweep_loft', 'inspect_sweep'].includes(a.command));
    const { text } = exported(runSwgPlan(plan).document, 'cadquery');
    expect(text.match(/\("helix", /g)).toHaveLength(2);
    expect(text.match(/\("faces", /g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe('mitred sweeps are a right-corner pipe shell', () => {
  it('a round section: the legs and the circle at the start (CadQuery, build123d, FreeCAD)', () => {
    const mitred = created(createEmptyDocument(), 'sweep_profile', { path: L, radius: 5, corners: 'miter' });
    for (const language of CALLS) {
      const { text } = exported(mitred.doc, language);
      expect(text).toContain(
        'sweep = sweep_profile(("pipe", "sweep \'swp-1.1\'", [[(0, 0, 0), (60, 0, 0)], [(60, 0, 0), (60, 60, 0)]], ("circle", (0, 0, 0), (1, 0, 0), 5), True, None, 60)',
      );
      expect(text).toContain("corners='miter'".replace(/'/g, '"'));
    }
    expect(exported(mitred.doc, 'freecad').text).toContain('1 if mitre else 0');
    expect(exported(mitred.doc, 'cadquery').text).toContain('BRepBuilderAPI_RightCorner');
  });

  it('a polygon section is placed in the start frame', () => {
    const mitred = created(createEmptyDocument(), 'sweep_profile', { path: L, section: squareProfile, corners: 'miter' });
    expect(exported(mitred.doc, 'build123d').text).toMatch(/\("polygon", \[\(0, [-\d.]+, [-\d.]+\)/);
  });

  it('a mitre with a law, a bore or curved section edges is refused by name and keeps the exact mesh', () => {
    const base = created(createEmptyDocument(), 'sweep_profile', { path: L, radius: 5, corners: 'miter' });
    const variants: Array<[string, (entity: SweepEntity) => SweepEntity, RegExp]> = [
      ['a scale law', (e) => ({ ...e, scale: { type: 'linear', start: 1, end: 0.5 } }), /mitred corners with laws/],
      ['a bore', (e) => ({ ...e, section: { shape: 'circle', radius: 5, innerRadius: 2 } }), /bored or curved-edge/],
      [
        'a curved edge',
        (e) => ({
          ...e,
          section: {
            shape: 'profile',
            profile: [
              [-3, -2],
              [3, -2],
              [3, 2],
              [-3, 2],
            ],
            curves: [
              {
                type: 'arc',
                points: [
                  [-3, -2],
                  [0, -3],
                  [3, -2],
                ],
              },
            ],
          },
        }),
        /bored or curved-edge/,
      ],
    ];
    for (const [label, edit, reason] of variants) {
      const doc = edited(base.doc, base.id, (entity) => edit(entity as SweepEntity));
      for (const language of ['cadquery', 'freecad', 'openscad'] as const) {
        const { notes } = exported(doc, language);
        expect(notes.join(' '), `${label} ${language}`).toMatch(reason);
        expect(notes.join(' ')).toContain('SWG_CODEGEN_UNSUPPORTED:');
      }
      const { text } = exported(doc, 'cadquery');
      expect(text, label).toMatch(/^# SWG_CODEGEN_UNSUPPORTED: sweep '[^']+' has mitred corners/m);
      expect(text, label).toMatch(/^sweep = mesh\(\[/m);
      expect(text, label).not.toContain('("pipe", "sweep');
    }
  });
});

describe('lofts', () => {
  const rings = {
    sections: [
      { center: [0, 0, 0], radius: 1 },
      { center: [0, 0, 4], radius: 2 },
    ],
    ruled: true,
  };

  it('a ruled loft of rings is a traced thru-sections loft of its Catmull-Rom Bezier wires', () => {
    const loft = created(createEmptyDocument(), 'loft_sections', rings);
    for (const language of CALLS) {
      const { text } = exported(loft.doc, language);
      expect(text).toMatch(/^loft = loft_sections\(\("loft", "loft 'loft-1\.1'", \[\n {2}\("chain", \[\[\(/m);
      expect(text).toMatch(
        /\], True\), \{"sections": \[0, 0, 0, 1, 0, 0, 4, 2\], "ruled": \[True\]\}, sections=\[\{"center": \[0, 0, 0\], "radius": 1\}/,
      );
      expect(text).toMatch(/ruled=True/);
    }
    expect(exported(loft.doc, 'cadquery').text).toContain('BRepOffsetAPI_ThruSections(True, bool(ruled), 1e-6)');
    expect(exported(loft.doc, 'freecad').text).toContain('Part.makeLoft(');
  });

  it('a smooth loft through three sections is ruled=False', () => {
    const smooth = created(createEmptyDocument(), 'loft_sections', {
      sections: [
        { center: [0, 0, 0], radius: 1 },
        { center: [0, 0, 3], section: squareProfile.map(([x, y]) => [(x as number) / 3, (y as number) / 2]) },
        { center: [1, 0, 6], radius: 2 },
      ],
    });
    expect(exported(smooth.doc, 'build123d').text).toMatch(/\], False\), \{"sections": \[/);
  });

  it('exact NURBS sections are B-spline wires; sketch-referencing lofts are the untraced swept(...); advanced lofts are fitted faces', () => {
    const plan = runSwgPlan(swgPlan('target_loft_conditions_alignment').filter((a) => a.command !== 'check_sweep_loft'));
    const { text, notes } = exported(plan.document, 'cadquery');
    expect(text.match(/\("faces", /g)?.length).toBeGreaterThanOrEqual(3);
    expect(notes.join(' ')).not.toContain('SWG_CODEGEN');
    const curves = created(createEmptyDocument(), 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [10, -10, 0],
        [10, 10, 0],
        [-10, 10, 0],
        [-10, -10, 0],
        [10, -10, 0],
      ],
    });
    const top = created(curves.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [5, -5, 20],
        [5, 5, 20],
        [-5, 5, 20],
        [-5, -5, 20],
        [5, -5, 20],
      ],
    });
    const exact = created(top.doc, 'loft_sections', { sectionIds: [curves.id, top.id] });
    expect((exact.doc.entities[exact.id] as LoftEntity).sections).toHaveLength(2);
    for (const language of ['cadquery', 'freecad'] as const) {
      const exactText = exported(exact.doc, language).text;
      expect(exactText).toContain('loft = swept(("loft", "loft \'loft-3.1\'", [\n  ("bspline", 1, [(10, -10, 0)');
      expect(exactText).toContain('False),\n  ("bspline", 1, [(5, -5, 20)');
    }
  });

  it('a loft that is closed without exact faces keeps the mesh with its reason', () => {
    const loft = created(createEmptyDocument(), 'loft_sections', rings);
    const doc = edited(loft.doc, loft.id, (entity) => ({ ...(entity as LoftEntity), closed: true }));
    const { text, notes } = exported(doc, 'cadquery');
    expect(notes.join(' ')).toMatch(/SWG_CODEGEN_UNSUPPORTED: loft '[^']+' is closed but carries no exact faces/);
    expect(text).toMatch(/^loft = mesh\(\[/m);
  });

  it('a skin face that cannot be split at its knots keeps the mesh with its reason', () => {
    const bottle = runSwgPlan(swgPlan('target_loft_conditions_alignment').slice(0, 4)).document;
    const id = bottle.order[bottle.order.length - 1] as string;
    const broken = edited(bottle, id, (entity) => {
      const loft = entity as LoftEntity;
      const face = (loft.faces as NonNullable<LoftEntity['faces']>)[0] as NonNullable<LoftEntity['faces']>[number];
      return { ...loft, faces: [{ ...face, knotsU: [0, 0, 1], multiplicitiesU: [1, 1, 1] }] };
    });
    expect(exported(broken, 'cadquery').notes.join(' ')).toMatch(/has a face that cannot be split at its knots/);
  });
});

describe('placement and style', () => {
  it('a rotated, moved sweep is rebuilt at its rotation (untraced: rotate_entity is not a sweep_profile param) and translated', () => {
    const sweep = created(createEmptyDocument(), 'sweep_profile', bar);
    let doc = created(sweep.doc, 'rotate_entity', { id: sweep.id, delta: [0.3, 0.2, 0.5] }).doc;
    doc = created(doc, 'move_entities', { ids: [sweep.id], delta: [10, -5, 7] }).doc;
    for (const language of CALLS) {
      const { text } = exported(doc, language);
      expect(text, language).toMatch(
        /^sweep = swept\(\("pipe", .*\), rotation=\(17\.1887338539247, 11\.4591559026165, 28\.6478897565412\)/m,
      );
      expect(text, language).toMatch(/sweep = (translate\(sweep, \(10, -5, 7\)\)|sweep\.translated\(_vec\(10, -5, 7\)\))/);
    }
    expect(exported(doc, 'openscad').text).toContain('polyhedron(');
  });
});

describe('sweeps the generated code cannot rebuild keep the exact mesh and say why', () => {
  const base = created(createEmptyDocument(), 'sweep_profile', bar);

  it('a hollow tube with stations, a degenerate section arc: the fit reason is named', () => {
    const ring = (radius: number): Vec2[] =>
      Array.from({ length: 24 }, (_, k): Vec2 => [radius * Math.cos((k * Math.PI) / 12), radius * Math.sin((k * Math.PI) / 12)]);
    const stationed = edited(base.doc, base.id, (entity) => ({
      ...(entity as SweepEntity),
      section: { shape: 'circle', radius: 5, innerRadius: 3 },
      stations: [
        { at: 0, ring: ring(4) },
        { at: 1, ring: ring(3) },
      ],
    }));
    expect(exported(stationed, 'cadquery').notes.join(' ')).toContain('has a bore and stations');
    const degenerate = edited(base.doc, base.id, (entity) => ({
      ...(entity as SweepEntity),
      section: {
        shape: 'profile',
        profile: [
          [-3, -2],
          [3, -2],
          [3, 2],
        ],
        curves: [
          {
            type: 'arc',
            points: [
              [0, 0],
              [1, 0],
              [2, 0],
            ],
          },
        ],
      },
    }));
    const { text, notes } = exported(degenerate, 'build123d');
    expect(notes.join(' ')).toMatch(/has no exact faces \(SWG_FIT_UNSUPPORTED: /);
    expect(text).toMatch(/^# SWG_CODEGEN_UNSUPPORTED: sweep/m);
    expect(exported(degenerate, 'openscad').text).toContain('polyhedron(');
  });

  it('a skin of more than 100000 poles stays a mesh (the data section would be unreadable)', () => {
    const polygon = Array.from({ length: 360 }, (_, k) => [3 * Math.cos((k * Math.PI) / 180), 3 * Math.sin((k * Math.PI) / 180)]);
    const heavy = created(createEmptyDocument(), 'sweep_profile', {
      path: [
        [0, 0, 0],
        [0, 0, 40],
      ],
      section: polygon,
      twistTurns: 2,
    });
    expect(exported(heavy.doc, 'cadquery').notes.join(' ')).toMatch(/needs \d+ fitted poles \(more than 100000\)/);
  }, 240_000);
});

describe('skinShape', () => {
  it('computes the fit once per entity object (the fit is the expensive part)', () => {
    const swept = created(createEmptyDocument(), 'sweep_profile', { ...bar, twist: { type: 'linear', start: 0, end: 1 } });
    const entity = swept.doc.entities[swept.id] as SweepEntity;
    const first = skinShape(entity, swept.doc, null);
    expect(first.kind === 'swept' && first.build.kind).toBe('faces');
    const second = skinShape(entity, swept.doc, null);
    expect(second.kind === 'swept' && second.build).toBe(first.kind === 'swept' ? first.build : null);
  });
});

describe('import_code of a recorded sweep or loft', () => {
  const term = (value: number, expression?: string): { value: number; expression?: string } =>
    expression === undefined ? { value } : { value, expression };

  it('apply_code_trace rebuilds sweep_profile / loft_sections steps and keeps the parameter binding', () => {
    const trace = {
      version: 1,
      units: 'mm',
      parameters: [{ name: 'r', expression: '4' }],
      features: [
        {
          command: 'sweep_profile',
          params: {
            path: [
              [term(0), term(0), term(0)],
              [term(0), term(0), term(50)],
            ],
            radius: term(4, 'r'),
          },
          ref: 'f1',
        },
        {
          command: 'loft_sections',
          params: {
            sections: [
              { center: [term(30), term(0), term(0)], radius: term(4, 'r') },
              { center: [term(30), term(0), term(20)], radius: term(8, '(r * 2)') },
            ],
            ruled: true,
          },
          ref: 'f2',
        },
      ],
    };
    const result = execute(createEmptyDocument(), 'apply_code_trace', { trace });
    expect(result.affected, result.summary).toHaveLength(2);
    expect(result.document.featureHistory.map((step) => step.name)).toEqual(['sweep_profile', 'loft_sections']);
    expect(result.document.featureHistory[0]?.params).toMatchObject({ radius: '=r' });
    expect(result.document.featureHistory[1]?.params).toMatchObject({ sections: [{ radius: '=r' }, { radius: '=r * 2' }] });
    const edited = execute(result.document, 'set_parameter', { name: 'r', expression: '6' });
    const swept = edited.document.entities[result.affected[0] as string] as SweepEntity;
    expect(swept.section).toMatchObject({ shape: 'circle', radius: 6 });
  });
});

describe('tracedCall', () => {
  const bind = (value: number, raw: unknown): { value: number; expression?: string } =>
    typeof raw === 'string' && raw.startsWith('=') ? { value, expression: raw.slice(1) } : { value };

  it('turns numbers into bound terms and keeps text, flags and nesting; colour and name stay helper arguments', () => {
    const call = tracedCall(
      'sweep_profile',
      {
        path: [[0, 0, 5]],
        radius: 2,
        corners: 'miter',
        closed: false,
        note: null,
        extra: undefined,
        color: '#fff',
        name: 'x',
        id: 'a',
        layerId: 'l',
        law: { start: 1 },
      },
      { radius: '=r', law: { start: '=s' } },
      bind,
    );
    expect(call?.params.map(([key]) => key)).toEqual(['path', 'radius', 'corners', 'closed', 'note', 'id', 'layerId', 'law']);
    expect(call?.params.find(([key]) => key === 'radius')?.[1]).toEqual({ kind: 'term', term: { value: 2, expression: 'r' } });
    expect(call?.params.find(([key]) => key === 'law')?.[1]).toEqual({
      kind: 'map',
      entries: [['start', { kind: 'term', term: { value: 1, expression: 's' } }]],
    });
    expect(call?.params.find(([key]) => key === 'closed')?.[1]).toEqual({ kind: 'flag', value: false });
  });

  it.each([
    ['a path curve id', { pathId: 'c1' }],
    ['rail ids', { guideIds: ['a'] }],
    ['a nested section id', { sections: [{ sectionId: 's' }] }],
    ['an entity reference', { orientation: { entityId: 'e' } }],
    ['a non-finite number', { radius: Number.NaN }],
    ['a non-finite number in a list', { path: [[0, Number.POSITIVE_INFINITY]] }],
    ['a non-finite number in a map', { law: { start: Number.NaN } }],
    ['a function value', { law: () => 1 }],
  ])('%s cannot be replayed from the code alone -> null', (_label, params) => {
    expect(tracedCall('sweep_profile', params, undefined, bind)).toBeNull();
  });

  it('non-object params -> null', () => {
    expect(tracedCall('loft_sections', [1], undefined, bind)).toBeNull();
    expect(tracedCall('loft_sections', null, undefined, bind)).toBeNull();
  });
});

describe('closed round pipes need a smooth closing joint', () => {
  it('a closed kinked path with a round section is not the library pipe', () => {
    const ring = created(createEmptyDocument(), 'sweep_profile', {
      path: [
        [20, 0, 0],
        [0, 20, 0],
        [-20, 0, 0],
        [0, -20, 0],
      ],
      smooth: true,
      closed: true,
      radius: 2,
    });
    const corner = (x: number, y: number): [number, number, number] => [x, y, 0];
    const kinked = edited(ring.doc, ring.id, (entity) => ({
      ...(entity as SweepEntity),
      path: [
        { type: 'line', points: [corner(0, 0), corner(20, 0)] },
        { type: 'line', points: [corner(20, 0), corner(20, 20)] },
        { type: 'line', points: [corner(20, 20), corner(0, 0)] },
      ],
    }));
    expect(exported(kinked, 'cadquery').text).not.toContain('("pipe", "sweep');
  });
});

describe('an explicit id in a recorded step', () => {
  const num = (value: number): { value: number } => ({ value });
  const sweepFeature = {
    command: 'sweep_profile',
    params: {
      path: [
        [num(0), num(0), num(0)],
        [num(0), num(0), num(30)],
      ],
      radius: num(2),
      id: 'mine',
    },
    ref: 'f1',
  };
  const loftFeature = {
    command: 'loft_sections',
    params: {
      sections: [
        { center: [num(0), num(0), num(0)], radius: num(1) },
        { center: [num(0), num(0), num(4)], radius: num(2) },
      ],
      ruled: true,
      id: 'mine',
    },
    ref: 'f1',
  };

  it.each([
    ['sweep_profile', sweepFeature],
    ['loft_sections', loftFeature],
  ])('%s: the id is kept when free and re-minted (old -> new in the summary) when append mode finds it taken', (_command, feature) => {
    const trace = { version: 1, units: 'mm', parameters: [], features: [feature] };
    const first = execute(createEmptyDocument(), 'apply_code_trace', { trace });
    expect(first.affected).toEqual(['mine']);
    const second = execute(first.document, 'apply_code_trace', { trace, mode: 'append' });
    expect(second.affected, second.summary).toHaveLength(1);
    expect(second.affected[0]).not.toBe('mine');
    expect(second.document.order).toHaveLength(2);
    expect(second.summary).toContain(`Explicit id(s) already in use were re-minted (old → new): mine → ${second.affected[0]}.`);
  });
});
