import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { PartSurface } from '@core/model/composites';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import type { FaceQueryPort } from '@core/geometry/kernelPorts';
import type { Vec2, Vec3 } from '@core/model/types';
import { boundaryDistance } from '@aero/composites/geometry2d';
import { parseNotation } from '@aero/composites/notation';
import { fibreDirection3d, fromFlat, normalAt, toFlat } from '@aero/composites/surface';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { BASE, HOLE, PAD, ROSETTE, panelPart, withMaterials } from './fixtures';

describe('a deleted tool solid does not break the saved file', () => {
  it('reopens the document and check_layup reports CMP_TOOL_MISSING', () => {
    let doc = apply(withMaterials(), 'define_rosette', ROSETTE);
    const box = ok(doc, 'add_box', { size: [100, 100, 10], anchor: 'min', position: [0, 0, -10] });
    doc = box.document;
    const part = ok(doc, 'create_composite_part', {
      name: 'P',
      rosette: 'R0',
      toolSurface: { entityId: box.affected[0], faceNear: [50, 50, 0] },
    });
    doc = apply(part.document, 'add_ply', {
      part: 'P',
      name: 'A',
      material: 'T300_5208',
      orientation: 45,
      boundary: { kind: 'whole_face' },
    });
    doc = apply(doc, 'delete_entities', { ids: [box.affected[0]] });
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.composites?.parts[part.affected[0] as string]).toBeDefined();
    const report = data<{ status: string; findings: { code: string; ids: string[] }[] }>(loaded, 'check_layup', { part: 'P' });
    expect(report.findings.find((finding) => finding.code === 'CMP_TOOL_MISSING')?.ids).toEqual([box.affected[0]]);
    expect(report.status).toBe('fail');
    expect(data<{ plyCount: number }>(loaded, 'core_sample', { part: 'P', point: [50, 50, 0] }).plyCount).toBe(1);
  });
});

describe('cone development on wide cones', () => {
  const cone: PartSurface = { type: 'cone', apex: [0, 0, 100], axis: [0, 0, -1], xDir: [1, 0, 0], semiAngle: Math.PI / 4 };
  it('round-trips azimuths beyond pi (flat angle above pi)', () => {
    for (const azimuth of [1, 3.5, 5.5, 6.2]) {
      const rho = 70;
      const s = Math.SQRT1_2;
      const point: Vec3 = [rho * s * Math.cos(azimuth), rho * s * Math.sin(azimuth), 100 - rho * s];
      const hit = toFlat(cone, point);
      const back = fromFlat(cone, hit.uv);
      back.forEach((value, i) => expect(value).toBeCloseTo(point[i] as number, 9));
      const normal = normalAt(cone, hit.uv);
      const radial: Vec3 = [Math.cos(azimuth), Math.sin(azimuth), 0];
      expect(normal[0] * radial[0] + normal[1] * radial[1]).toBeGreaterThan(0.7);
    }
  });

  it('keeps the fibre direction continuous across the flat branch cut', () => {
    const below = fibreDirection3d(cone, [50, -1e-9], 90);
    const above = fibreDirection3d(cone, [50, 1e-9], 90);
    below.forEach((value, i) => expect(value).toBeCloseTo(above[i] as number, 6));
    const wide = fibreDirection3d(cone, [-40, -40], 0);
    expect(Math.hypot(...wide)).toBeCloseTo(1, 9);
  });
});

describe('ramp fit near the part edge', () => {
  it('accepts a zone band that touches the face edge', () => {
    const { doc, part } = panelPart();
    let next = apply(doc, 'define_zone', { part, ...BASE });
    next = apply(next, 'define_zone', {
      part,
      name: 'band',
      boundary: [
        [0, 0],
        [100, 0],
        [100, 400],
        [0, 400],
      ],
      laminate: PAD.laminate,
      priority: 1,
    });
    const generated = ok(next, 'generate_plies_from_zones', { part, material: 'T300_5208' });
    expect(generated.rejected).toBeUndefined();
    const at = (x: number): number => data<{ plyCount: number }>(generated.document, 'core_sample', { part, point: [x, 200, 0] }).plyCount;
    expect([50, 101, 150, 400].map(at)).toEqual([16, 16, 8, 8]);
  });

  it('still refuses a ramp that runs into another zone, and refuses ramps on a concave cone outline', () => {
    const { doc, part } = panelPart();
    let tight = apply(doc, 'define_zone', { part, ...BASE });
    tight = apply(tight, 'define_zone', { part, ...PAD });
    tight = apply(tight, 'define_zone', {
      part,
      ...HOLE,
      boundary: [
        [205, 105],
        [395, 105],
        [395, 295],
        [205, 295],
      ],
    });
    expectRefusal(tight, 'generate_plies_from_zones', { part, material: 'T300_5208' }, 'CMP_RAMP_CONFLICT');
    let cone = apply(withMaterials(), 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    const tool = ok(cone, 'add_cone', { radius: 100, height: 100, position: [0, 0, 0] });
    cone = tool.document;
    const created = ok(cone, 'create_composite_part', {
      name: 'C',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 50] },
    });
    cone = apply(created.document, 'define_zone', {
      part: 'C',
      name: 'thick',
      boundary: [
        [50, 0],
        [100, 0],
        [100, 50],
        [50, 50],
      ],
      laminate: '[45/-45/0/90]s',
      priority: 1,
    });
    cone = apply(cone, 'define_zone', {
      part: 'C',
      name: 'thin',
      boundary: [
        [10, 5],
        [40, 5],
        [40, 40],
        [10, 40],
      ],
      laminate: '[45/-45]s',
      priority: 0,
    });
    expectRefusal(cone, 'generate_plies_from_zones', { part: 'C', material: 'T300_5208' }, 'CMP_OUTLINE_NOT_CONVEX');
  });
});

describe('stacking notation limits', () => {
  it('rejects huge expansions quickly, zero repeats, ~ without s and accepts the overlined s', () => {
    for (const text of ['[0_200000]T', '[(0/90)_99999]T', '[+-45_99999]s', '[0/90]_99999s', '[0_0]T', '[(0/90)_0]T', '[0/90~]T', '[0/90~]'])
      expect(parseNotation(text).ok, text).toBe(false);
    const overlined = parseNotation('[45/-45/0_2/90]s̄');
    expect(overlined.ok && overlined.angles).toEqual([45, -45, 0, 0, 90, 0, 0, -45, 45]);
    expect(parseNotation('[0/90]s̄.').ok).toBe(true);
  });
});

describe('ply rosettes', () => {
  it('rotates the orientation by the ply rosette against the part rosette on a plane face', () => {
    const { doc, part } = panelPart();
    const withR = apply(doc, 'define_rosette', { name: 'R90', origin: [0, 0, 0], axis0: [0, 1, 0], normal: [0, 0, 1] });
    const plied = apply(withR, 'add_ply', {
      part,
      name: 'A',
      material: 'T300_5208',
      orientation: 0,
      rosette: 'R90',
      boundary: { kind: 'whole_face' },
    });
    expect(Object.values(plied.composites?.plies ?? {})[0]?.orientation).toBe(90);
    const vertical = apply(doc, 'define_rosette', { name: 'Rn', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0] });
    expectRefusal(
      vertical,
      'add_ply',
      { part, name: 'B', material: 'T300_5208', orientation: 0, rosette: 'Rn', boundary: { kind: 'whole_face' } },
      'CMP_ROSETTE_DEGENERATE',
    );
  });

  it('refuses a different ply rosette on curved faces', () => {
    let doc = apply(withMaterials(), 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    doc = apply(doc, 'define_rosette', ROSETTE);
    const tool = ok(doc, 'add_cylinder', { radius: 10, height: 20 });
    const part = ok(tool.document, 'create_composite_part', {
      name: 'Cyl',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [10, 0, 0] },
    });
    expectRefusal(
      part.document,
      'add_ply',
      { part: 'Cyl', name: 'A', material: 'T300_5208', orientation: 0, rosette: 'R0', boundary: { kind: 'whole_face' } },
      'CMP_PARAM_INVALID',
    );
  });
});

describe('generated ply names', () => {
  it('refuses a clash with a manual ply', () => {
    const { doc, part } = panelPart();
    let next = apply(doc, 'define_zone', { part, ...BASE });
    next = apply(next, 'add_ply', { part, name: 'S3', material: 'T300_5208', orientation: 0, boundary: { kind: 'whole_face' } });
    expectRefusal(next, 'generate_plies_from_zones', { part, material: 'T300_5208' }, 'CMP_NAME_TAKEN');
    expect(execute(next, 'generate_plies_from_zones', { part, material: 'T300_5208', sequencePrefix: 'G' }).rejected).toBeUndefined();
  });
});

describe('flexural constants', () => {
  it('reports E = 12 / (h^3 d) from D inverse beside the membrane constants', () => {
    const doc = withMaterials();
    const ud = data<{ constantsFlexural: { Ex: number; Ey: number } }>(doc, 'analyze_laminate', {
      laminate: '[0_8]T',
      material: 'T300_5208',
    });
    expect(ud.constantsFlexural.Ex).toBeCloseTo(181000, 0);
    expect(ud.constantsFlexural.Ey).toBeCloseTo(10300, 0);
    const qi = data<{ constantsFlexural: { Ex: number }; constantsMembrane: { Ex: number } }>(doc, 'analyze_laminate', {
      laminate: '[0/45/-45/90]s',
      material: 'T300_5208',
    });
    expect(qi.constantsFlexural.Ex).toBeGreaterThan(qi.constantsMembrane.Ex);
  });
});

describe('kernel cone faces whose azimuth runs the other way', () => {
  it('builds the partial outline so that the face boundary points lie on it', () => {
    const apex: Vec3 = [0, 0, 300];
    const semiAngle = Math.atan2(100, 300);
    const axis: Vec3 = [0, 0, -1];
    const y: Vec3 = [0, -1, 0]; // axis x xDir: counter-clockwise about the kernel axis
    const rho0 = 158.113883;
    const point = ([u, v]: Vec2): Vec3 => {
      const rho = rho0 + v;
      const radial: Vec3 = [Math.cos(u) * 1 + 0, Math.sin(u) * y[1], 0];
      return [
        apex[0] + rho * Math.sin(semiAngle) * radial[0],
        apex[1] + rho * Math.sin(semiAngle) * radial[1],
        apex[2] + rho * Math.cos(semiAngle) * axis[2],
      ];
    };
    const nothing = (): null => null;
    const faceQuery = {
      faceDetails: nothing,
      faceContains: nothing,
      faceGraph: nothing,
      faceGeometry: () => ({
        surface: { type: 'cone', apex, axis, xDir: [1, 0, 0], semiAngle },
        uvBounds: [
          [0.5, 0],
          [2.5, 100],
        ],
      }),
      projectOnFace: nothing,
      evaluateFace: (_s: unknown, _f: unknown, uv: readonly Vec2[]) => uv.map((p) => ({ point: point(p), normal: [0, 0, 1] })),
      tessellateFace: nothing,
      faceSamples: nothing,
      edgeSamples: nothing,
      edgeContinuity: nothing,
      distance: () => [{ distance: 0, signed: 0, face: 0 }],
      bspline: nothing,
    } as unknown as FaceQueryPort;
    const kernel: GeometryKernel = {
      supports: () => true,
      evaluate: () => ({}) as ShapeHandle,
      tessellate: () => null,
      topology: () => null,
      exportStep: () => null,
      faceQuery,
    };
    const base = apply(withMaterials(), 'define_rosette', ROSETTE);
    const sphere = ok(base, 'add_torus', { ringRadius: 10, tubeRadius: 3 });
    const result = execute(
      sphere.document,
      'create_composite_part',
      { name: 'K', rosette: 'R0', toolSurface: { entityId: sphere.affected[0], faceNear: [0, 0, 10] } },
      { ...defaultContext(), kernel },
    );
    expect(result.rejected).toBeUndefined();
    const created = result.document.composites?.parts[result.affected[0] as string];
    const surface = created?.surface as PartSurface;
    for (const p of [
      [0.5, 0],
      [1.5, 0],
      [2.5, 0],
      [0.5, 100],
      [1.5, 100],
      [2.5, 100],
      [1.5, 50],
    ] as Vec2[]) {
      const flat = toFlat(surface, point(p)).uv;
      const distance = boundaryDistance(flat, created?.outline ?? []);
      expect(distance, `${p}`).toBeLessThan(p[1] === 50 ? 60 : 0.5);
    }
  });
});
