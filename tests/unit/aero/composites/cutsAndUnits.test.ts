import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { Vec2 } from '@core/model/types';
import { cutFaces, cutPieces } from '@aero/composites/cutPieces';
import { polygonArea } from '@lib/polygon';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { AS4, ROSETTE, T300, panelPart, withMaterials } from './fixtures';
import { WOVEN } from './drapeFixtures';

const RECT: Vec2[] = [
  [0, 0],
  [100, 0],
  [100, 50],
  [0, 50],
];
const areas = (pieces: readonly (readonly Vec2[])[]): number[] => pieces.map((piece) => polygonArea(piece)).sort((a, b) => a - b);

describe('cutPieces and cutFaces', () => {
  it('a splice across a rectangle divides it in two, with a stable order', () => {
    const pieces = cutPieces(
      [RECT],
      [
        {
          kind: 'splice',
          path: [
            [40, -10],
            [40, 60],
          ],
        },
      ],
    );
    expect(areas(pieces)).toEqual([2000, 3000]);
    expect(pieces[0]?.some(([x]) => x === 0)).toBe(true);
  });

  it('keeps the boundary for no cuts and for a lone dart', () => {
    expect(areas(cutPieces([RECT], []))).toEqual([5000]);
    expect(
      areas(
        cutPieces(
          [RECT],
          [
            {
              kind: 'dart',
              path: [
                [50, -5],
                [50, 25],
              ],
            },
          ],
        ),
      ),
    ).toEqual([5000]);
  });

  it('two darts meeting inside divide the rectangle (a chord through a shared vertex)', () => {
    const pieces = cutPieces(
      [RECT],
      [
        {
          kind: 'dart',
          path: [
            [50, -5],
            [50, 25],
          ],
        },
        {
          kind: 'dart',
          path: [
            [50, 25],
            [50, 60],
          ],
        },
      ],
    );
    expect(areas(pieces)).toEqual([2500, 2500]);
  });

  it('grows the piece on the left of the path by the overlap, clipped to the neighbour', () => {
    const pieces = cutPieces(
      [RECT],
      [
        {
          kind: 'splice',
          path: [
            [40, -10],
            [40, 60],
          ],
          overlap: 5,
        },
      ],
    );
    expect(areas(pieces)).toEqual([2250 + 0, 3000].sort((a, b) => a - b));
    const concave = [
      [0, 0],
      [100, 0],
      [100, 50],
      [60, 50],
      [60, 20],
      [40, 20],
      [40, 50],
      [0, 50],
    ] as Vec2[];
    expect(
      cutPieces(
        [concave],
        [
          {
            kind: 'splice',
            path: [
              [80, -10],
              [80, 60],
            ],
            overlap: 5,
          },
        ],
      ).length,
    ).toBe(2);
  });

  it('nests concentric loops as holes of the enclosing face', () => {
    const inner: [number, number][] = [
      [20, 10],
      [80, 10],
      [80, 40],
      [20, 40],
      [20, 10],
    ];
    const faces = cutFaces([RECT], [{ kind: 'splice', path: inner }]);
    expect(faces).toHaveLength(2);
    const outer = faces.find((face) => face.holes.length === 1);
    expect(polygonArea(outer?.outer ?? [])).toBe(5000);
    expect(polygonArea(outer?.holes[0] ?? [])).toBe(1800);
  });
});

describe('split_ply on a flat part', () => {
  const base = panelPart();
  const laid = apply(base.doc, 'add_ply', {
    part: base.part,
    name: 'P1',
    material: T300.name,
    orientation: 0,
    boundary: { kind: 'whole_face' },
  });

  it('adds a splice with overlap, grows the area and re-derives the pieces', () => {
    const cut = apply(laid, 'split_ply', {
      ply: 'P1',
      part: base.part,
      kind: 'splice',
      path: [
        [300, -10],
        [300, 410],
      ],
      overlap: 8,
    });
    const ply = Object.values(cut.composites?.plies ?? {})[0];
    expect(ply?.cuts).toHaveLength(1);
    const dxf = data<{ pieces: { areaMm2: number }[] }>(cut, 'export_ply_flat_patterns_dxf', { part: base.part });
    expect(dxf.pieces).toHaveLength(2);
    expect(Math.round(dxf.pieces.reduce((sum, piece) => sum + piece.areaMm2, 0))).toBe(600 * 400 + 8 * 400);
    const outlines = Object.keys(cut.entities).filter((id) => id.startsWith('ply-') && id.includes('.o'));
    expect(outlines).toHaveLength(2);
  });

  it('resolves a curve entity projected on the tool face and refuses unsuitable ones', () => {
    const line = ok(laid, 'draw_polyline', {
      points: [
        [200, -10],
        [200, 410],
      ],
    });
    const cut = apply(line.document, 'split_ply', { ply: 'P1', part: base.part, kind: 'splice', curveId: line.affected[0] });
    expect(Object.values(cut.composites?.plies ?? {})[0]?.cuts?.[0]?.path).toHaveLength(2);
    const circle = ok(laid, 'draw_point', { position: [0, 0, 0] });
    expectRefusal(
      circle.document,
      'split_ply',
      { ply: 'P1', part: base.part, kind: 'dart', curveId: circle.affected[0] },
      'CMP_REF_MISSING',
    );
    expectRefusal(laid, 'split_ply', { ply: 'P1', part: base.part, kind: 'dart', curveId: 'nope' }, 'CMP_REF_MISSING');
  });

  it('refuses closed cuts inside the ply and overlaps that cannot be applied', () => {
    const loop: [number, number][] = [
      [100, 100],
      [200, 100],
      [200, 200],
      [100, 200],
      [100, 100],
    ];
    expectRefusal(laid, 'split_ply', { ply: 'P1', part: base.part, kind: 'dart', path: loop }, 'CMP_CUT_INVALID');
    expectRefusal(
      laid,
      'split_ply',
      {
        ply: 'P1',
        part: base.part,
        kind: 'dart',
        path: [
          [0, 0],
          [1, 1],
        ],
        overlap: 2,
      },
      'CMP_CUT_INVALID',
    );
    expect(
      execute(laid, 'split_ply', {
        ply: 'P1',
        part: base.part,
        kind: 'splice',
        path: [
          [Number.NaN, 0],
          [300, 400],
        ],
      }).rejected,
    ).toBe(true);
    const concave = apply(laid, 'edit_ply', {
      part: base.part,
      ply: 'P1',
      boundary: {
        kind: 'polygon',
        polygons: [
          [
            [0, 0],
            [600, 0],
            [600, 400],
            [300, 400],
            [300, 150],
            [250, 150],
            [250, 400],
            [0, 400],
          ],
        ],
      },
    });
    expectRefusal(
      concave,
      'split_ply',
      {
        ply: 'P1',
        part: base.part,
        kind: 'splice',
        path: [
          [450, 410],
          [450, -10],
        ],
        overlap: 4,
      },
      'CMP_CUT_INVALID',
    );
  });
});

describe('create_lamina_material stress units', () => {
  const base = apply(withMaterials(), 'set_units', { units: 'in' });
  const record = (extra: Record<string, unknown>): Record<string, unknown> => ({
    name: 'US',
    form: 'ud_tape',
    E1: 26.25,
    E2: 1.494,
    G12: 1.04,
    nu12: 0.28,
    Xt: 217557,
    plyThickness: 0.005,
    basis: 'b_basis',
    source: 'test (US customary data)',
    ...extra,
  });

  it('stores moduli and strengths in MPa whatever the unit they were given in', () => {
    const msi = apply(base, 'create_lamina_material', record({ stressUnit: 'Msi', Xt: (217.557 * 1000) / 1000, Xc: undefined }));
    const stored = msi.composites?.materials['US'];
    expect(stored?.E1).toBeCloseTo(26.25 * 6894.757293168, 3);
    const psi = apply(base, 'create_lamina_material', record({ stressUnit: 'psi', E1: 26.25e6, E2: 1.494e6, G12: 1.04e6 }));
    expect(psi.composites?.materials['US']?.E1).toBeCloseTo(26.25 * 6894.757293168, 3);
    expect(psi.composites?.materials['US']?.Xt).toBeCloseTo(217557 * 0.006894757293168, 6);
    expect(psi.composites?.materials['US']?.plyThickness).toBe(0.005);
    const gpa = apply(base, 'create_lamina_material', record({ stressUnit: 'GPa', E1: 181, E2: 10.3, G12: 7.17, Xt: 1.5 }));
    expect(gpa.composites?.materials['US']?.E1).toBe(181000);
    expect(gpa.composites?.materials['US']?.Xt).toBe(1500);
    const plain = apply(base, 'create_lamina_material', record({ E1: 181000, E2: 10300, G12: 7170, Xt: 1500 }));
    expect(plain.composites?.materials['US']?.E1).toBe(181000);
  });

  it('analyses in N-mm-MPa with the thickness converted from inches', () => {
    const doc = apply(
      base,
      'create_lamina_material',
      record({
        stressUnit: 'GPa',
        E1: 181,
        E2: 10.3,
        G12: 7.17,
        Xt: 1.5,
        Xc: 1.5,
        Yt: 0.04,
        Yc: 0.246,
        S: 0.068,
        plyThickness: 0.125 / 25.4,
      }),
    );
    const analysis = data<{ thicknessMm: number; constantsMembrane: { Ex: number } }>(doc, 'analyze_laminate', {
      angles: [0, 0, 0, 0],
      material: 'US',
    });
    expect(analysis.thicknessMm).toBeCloseTo(0.5, 9);
    expect(analysis.constantsMembrane.Ex).toBeCloseTo(181000, 3);
  });

  it('rejects unknown units and keeps the positivity checks', () => {
    expect(execute(base, 'create_lamina_material', record({ stressUnit: 'bar' })).rejected).toBe(true);
    expectRefusal(base, 'create_lamina_material', record({ stressUnit: 'GPa', E1: -1 }), 'CMP_MATERIAL_NOT_POSITIVE');
  });
});

describe('kinematic drape of developable faces (VC-CMP-27)', () => {
  const AXIS = { name: 'Rax', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0], method: 'cylindrical', axis: [0, 0, 1] } as const;
  const tube = (): { doc: ReturnType<typeof withMaterials>; part: string } => {
    let doc = apply(apply(withMaterials(), 'create_lamina_material', WOVEN), 'define_rosette', AXIS);
    const tool = ok(doc, 'add_cylinder', { radius: 50, height: 200, position: [0, 0, 0] });
    doc = tool.document;
    const part = ok(doc, 'create_composite_part', {
      name: 'Tube',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 0] },
    });
    return { doc: part.document, part: part.affected[0] as string };
  };

  const shear = (doc: ReturnType<typeof withMaterials>, part: string, ply: string, stepLength: number): number =>
    data<{ maxShearDeg: number }>(doc, 'drape_ply', { ply, part, stepLength }).maxShearDeg;

  it('shows no shear on a cylinder along the axis and a chord-discretisation shear that falls with the step at other angles', () => {
    const { doc, part } = tube();
    const laid = (angle: number): ReturnType<typeof withMaterials> =>
      apply(doc, 'add_ply', {
        part,
        name: `W${angle}`,
        material: WOVEN.name,
        orientation: angle,
        boundary: { kind: 'whole_face' },
        drape: { method: 'kinematic' },
      });
    expect(shear(laid(0), part, 'W0', 4)).toBeLessThan(1e-6);
    const helix = laid(45);
    const [coarse, fine, finest] = [shear(helix, part, 'W45', 4), shear(helix, part, 'W45', 2), shear(helix, part, 'W45', 1)];
    expect(coarse).toBeGreaterThan(fine);
    expect(coarse / fine).toBeGreaterThan(1.7);
    expect(fine / finest).toBeGreaterThan(1.7);
    expect(finest).toBeLessThan(1);
    expect(data<{ nodesOverLock: number }>(helix, 'drape_ply', { ply: 'W45', part, stepLength: 4 }).nodesOverLock).toBe(0);
  });

  it('check_producibility treats a plain developable ply as exact and a kinematic one as draped', () => {
    const { doc, part } = tube();
    const plain = apply(doc, 'add_ply', { part, name: 'D', material: WOVEN.name, orientation: 0, boundary: { kind: 'whole_face' } });
    const exact = data<{ plies: { method: string; maxShearDeg: number }[] }>(plain, 'check_producibility', { part });
    expect(exact.plies[0]).toMatchObject({ method: 'developable', maxShearDeg: 0 });
    const kin = apply(doc, 'add_ply', {
      part,
      name: 'K',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
      drape: { method: 'kinematic' },
    });
    expect(data<{ plies: { method: string }[] }>(kin, 'check_producibility', { part, stepLength: 5 }).plies[0]?.method).toBe('fishnet');
  });

  it('drapes a cone and a plane too', () => {
    let doc = apply(apply(withMaterials(), 'create_lamina_material', WOVEN), 'define_rosette', AXIS);
    const cone = ok(doc, 'add_cone', { radius: 50, height: 100, position: [0, 0, 0] });
    doc = cone.document;
    const coneTool = cone.affected[0] as string;
    const created = ok(doc, 'create_composite_part', {
      name: 'Cone',
      rosette: 'Rax',
      toolSurface: { entityId: coneTool, faceNear: [25, 0, 50] },
    });
    doc = apply(created.document, 'add_ply', {
      part: created.affected[0],
      name: 'K',
      material: WOVEN.name,
      orientation: 0,
      boundary: {
        kind: 'polygon',
        polygons: [
          [
            [45, 20],
            [85, 20],
            [85, 50],
            [45, 50],
          ],
        ],
      },
      drape: { method: 'kinematic' },
    });
    const [coarse, fine] = [shear(doc, created.affected[0] as string, 'K', 6), shear(doc, created.affected[0] as string, 'K', 3)];
    expect(coarse).toBeGreaterThan(fine);
    expect(fine).toBeLessThan(1);
    let flat = apply(withMaterials(), 'create_lamina_material', WOVEN);
    flat = apply(flat, 'define_rosette', ROSETTE);
    const box = ok(flat, 'add_box', { size: [100, 100, 10], anchor: 'min', position: [0, 0, -10] });
    const plate = ok(box.document, 'create_composite_part', {
      name: 'Plate',
      rosette: 'R0',
      toolSurface: { entityId: box.affected[0], faceNear: [50, 50, 0] },
    });
    flat = apply(plate.document, 'add_ply', {
      part: plate.affected[0],
      name: 'K',
      material: AS4.name,
      orientation: 30,
      boundary: { kind: 'whole_face' },
      drape: { method: 'kinematic' },
    });
    expectRefusal(flat, 'drape_ply', { ply: 'K', part: plate.affected[0] }, 'CMP_DRAPE_LIMIT_MISSING');
    expect(
      data<{ maxShearDeg: number }>(flat, 'drape_ply', { ply: 'K', part: plate.affected[0], lockingAngle: 40, stepLength: 5 }).maxShearDeg,
    ).toBeLessThan(1e-6);
  });
});
