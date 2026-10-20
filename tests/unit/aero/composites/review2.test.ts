import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { PartSurface } from '@core/model/composites';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import type { FaceQueryPort } from '@core/geometry/kernelPorts';
import type { Vec2, Vec3 } from '@core/model/types';
import { boundaryDistance } from '@aero/composites/geometry2d';
import { toFlat } from '@aero/composites/surface';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { ROSETTE, T300, panel, panelPart, withMaterials } from './fixtures';

const csvOf = (doc: Parameters<typeof data>[0], part: string): string =>
  data<{ files: { content: string }[] }>(doc, 'export_ply_table', { part }).files[0]?.content ?? '';
const orientationOf = (doc: Parameters<typeof data>[0], name: string): number | undefined =>
  Object.values(doc.composites?.plies ?? {}).find((ply) => ply.name === name)?.orientation;

describe('ply rosettes in edit_ply and the ply table', () => {
  const { doc, part } = panelPart();
  const withR = apply(doc, 'define_rosette', { name: 'R90', origin: [0, 0, 0], axis0: [0, 1, 0], normal: [0, 0, 1] });
  const base = { part, name: 'A', material: 'T300_5208', rosette: 'R90', boundary: { kind: 'whole_face' } } as const;

  it('keeps edit_ply angles relative to the ply rosette', () => {
    const added = apply(withR, 'add_ply', { ...base, orientation: 0 });
    expect(orientationOf(added, 'A')).toBe(90);
    const edited = apply(added, 'edit_ply', { part, ply: 'A', orientation: 10 });
    expect(orientationOf(edited, 'A')).toBe(-80);
    const unchanged = apply(added, 'edit_ply', { part, ply: 'A', sequence: 'Z' });
    expect(orientationOf(unchanged, 'A')).toBe(90);
  });

  it('writes and reads the angle relative to the ply rosette (round trip)', () => {
    const added = apply(withR, 'add_ply', { ...base, orientation: 20 });
    const csv = csvOf(added, part);
    expect(csv.split('\n')[1]).toContain(',20,R90,');
    const second = ok(added, 'create_composite_part', {
      name: 'Second',
      rosette: 'R0',
      toolSurface: { entityId: Object.keys(added.entities)[0], faceNear: [300, 200, 0] },
    });
    const imported = apply(second.document, 'import_ply_table', { part: 'Second', csv });
    expect(orientationOf(imported, 'A')).toBe(
      Object.values(imported.composites?.plies ?? {}).find((ply) => ply.partId === part)?.orientation,
    );
    expect(csvOf(imported, 'Second')).toBe(csv);
  });

  it('refuses a ply rosette that is degenerate on the face, or foreign to a curved part', () => {
    const vertical = apply(doc, 'define_rosette', { name: 'Rn', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0] });
    expectRefusal(
      vertical,
      'import_ply_table',
      { part, csv: 'ply,material,orientation,rosette\nA,T300_5208,0,Rn\n' },
      'CMP_ROSETTE_DEGENERATE',
    );
  });

  it('refuses a non-part rosette on a cylinder part', () => {
    let cyl = apply(withMaterials(), 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    cyl = apply(cyl, 'define_rosette', ROSETTE);
    const tool = ok(cyl, 'add_cylinder', { radius: 10, height: 20 });
    const made = ok(tool.document, 'create_composite_part', {
      name: 'Cyl',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [10, 0, 0] },
    });
    expectRefusal(
      made.document,
      'import_ply_table',
      { part: 'Cyl', csv: 'ply,material,orientation,rosette\nA,T300_5208,0,R0\n' },
      'CMP_PARAM_INVALID',
    );
    expect(
      execute(made.document, 'import_ply_table', { part: 'Cyl', csv: 'ply,material,orientation,rosette\nA,T300_5208,0,Rax\n' }).rejected,
    ).toBeUndefined();
  });
});

describe('ply table input hygiene', () => {
  const { doc, part } = panelPart();

  it('refuses blank orientation and order cells', () => {
    expectRefusal(doc, 'import_ply_table', { part, csv: 'ply,material,orientation\nA,T300_5208,\n' }, 'CMP_CSV_PARSE');
    expectRefusal(doc, 'import_ply_table', { part, csv: 'ply,material,orientation,order\nA,T300_5208,0,\n' }, 'CMP_CSV_PARSE');
  });

  it('guards spreadsheet formulas on export and restores them on import', () => {
    let next = apply(doc, 'add_ply', {
      part,
      name: '=HYPERLINK("x")',
      material: 'T300_5208',
      orientation: -45,
      sequence: '@s',
      boundary: { kind: 'whole_face' },
    });
    next = apply(next, 'add_ply', {
      part,
      name: "'=already",
      material: 'T300_5208',
      orientation: 45,
      sequence: '+1',
      boundary: { kind: 'whole_face' },
    });
    const csv = csvOf(next, part);
    const lines = csv.trimEnd().split('\n');
    expect(lines[1]?.startsWith(`"'=HYPERLINK(""x"")",'@s,0,T300_5208,-45,`)).toBe(true);
    expect(lines[2]?.startsWith("''=already,'+1,1,")).toBe(true);
    const second = ok(next, 'create_composite_part', {
      name: 'Second',
      rosette: 'R0',
      toolSurface: { entityId: Object.keys(next.entities)[0], faceNear: [300, 200, 0] },
    });
    const imported = apply(second.document, 'import_ply_table', { part: 'Second', csv });
    const names = Object.values(imported.composites?.plies ?? {})
      .filter((ply) => ply.partId === second.affected[0])
      .map((ply) => ply.name);
    expect(names).toEqual(['=HYPERLINK("x")', "'=already"]);
    expect(csvOf(imported, 'Second')).toBe(csv);
  });

  it('ignores a byte order mark and refuses more than 5000 rows', () => {
    const bom = `\uFEFFply,material,orientation\nA,T300_5208,0\n`;
    expect(execute(doc, 'import_ply_table', { part, csv: bom }).rejected).toBeUndefined();
    const many = `ply,material,orientation\n${Array.from({ length: 5001 }, (_, i) => `P${i},T300_5208,0`).join('\n')}\n`;
    expectRefusal(doc, 'import_ply_table', { part, csv: many }, 'CMP_CSV_PARSE');
  });
});

describe('kernel cone faces with a sector above pi', () => {
  function build(kernelAxis: Vec3, kernelY: Vec3): { created: ReturnType<typeof execute>; point: (p: Vec2) => Vec3 } {
    const apex: Vec3 = [0, 0, 300];
    const semiAngle = 0.77;
    const down: Vec3 = [0, 0, -1];
    const point = ([u, v]: Vec2): Vec3 => {
      const rho = 150 + v;
      const radial: Vec3 = [Math.cos(u), Math.sin(u) * kernelY[1], 0];
      return [rho * Math.sin(semiAngle) * radial[0], rho * Math.sin(semiAngle) * radial[1], apex[2] + rho * Math.cos(semiAngle) * down[2]];
    };
    const nothing = (): null => null;
    const faceQuery = {
      faceDetails: nothing,
      faceContains: nothing,
      faceGraph: nothing,
      faceGeometry: () => ({
        surface: { type: 'cone', apex, axis: kernelAxis, xDir: [1, 0, 0], semiAngle },
        uvBounds: [
          [Math.PI, 0],
          [2 * Math.PI, 100],
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
    const sphere = ok(apply(withMaterials(), 'define_rosette', ROSETTE), 'add_sphere', { radius: 10 });
    const created = execute(
      sphere.document,
      'create_composite_part',
      { name: 'K', rosette: 'R0', toolSurface: { entityId: sphere.affected[0], faceNear: [0, 0, 10] } },
      { ...defaultContext(), kernel },
    );
    return { created, point };
  }

  it.each([
    ['axis towards the solid, counter-clockwise azimuth (mirrored in the part frame)', [0, 0, -1] as Vec3, [0, -1, 0] as Vec3],
    ['axis towards the apex, azimuth the part way', [0, 0, 1] as Vec3, [0, 1, 0] as Vec3],
  ])('puts the face boundary on the outline: %s', (_label, axis, y) => {
    const { created, point } = build(axis, y);
    expect(created.rejected).toBeUndefined();
    const part = created.document.composites?.parts[created.affected[0] as string];
    for (const p of [
      [Math.PI, 0],
      [1.5 * Math.PI, 0],
      [2 * Math.PI, 0],
      [Math.PI, 100],
      [1.5 * Math.PI, 100],
      [2 * Math.PI, 100],
    ] as Vec2[])
      expect(boundaryDistance(toFlat(part?.surface as PartSurface, point(p)).uv, part?.outline ?? []), `${p}`).toBeLessThan(0.5);
  });
});

describe('LaRC03 inputs and cost', () => {
  const extra = { alpha1: -0.3e-6, alpha2: 28e-6, beta1: 0, beta2: 0.3, GIc: 0.2, GIIc: 0.8 };

  it('refuses strength ratios for which the kink angle is undefined', () => {
    const odd = apply(withMaterials(), 'create_lamina_material', { ...T300, name: 'odd', Xc: 100, ...extra });
    expectRefusal(
      odd,
      'analyze_laminate',
      { laminate: '[0/90]s', material: 'odd', loads: { Nx: 1 }, criteria: ['larc03'] },
      'CMP_MATERIAL_ALLOWABLE_MISSING',
    );
  });

  it('solves a hygrothermal LaRC03 ratio with one bisection per point', () => {
    const doc = apply(withMaterials(), 'create_lamina_material', { ...T300, name: 'HT', ...extra });
    const started = Date.now();
    const result = data<{ firstPlyFailure: { larc03: { R: number | null } } }>(doc, 'analyze_laminate', {
      laminate: '[0/45/-45/90]s',
      material: 'HT',
      loads: { Nx: 1 },
      criteria: ['larc03'],
      environment: { deltaT: -100 },
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.firstPlyFailure.larc03.R).not.toBeNull();
  });

  it('explains an environment without mechanical loads', () => {
    const doc = apply(withMaterials(), 'create_lamina_material', { ...T300, name: 'HT', ...extra });
    const result = data<{ firstPlyFailure: { max_stress: { R: number | null; note?: string } } }>(doc, 'analyze_laminate', {
      laminate: '[0/90]s',
      material: 'HT',
      environment: { deltaT: -100 },
    });
    expect(result.firstPlyFailure.max_stress.note).toContain('residual');
  });
});

describe('stored sections are validated on load', () => {
  const made = apply(panel().doc, 'create_laminate_sections', { part: panel().part });
  const text = serializeDocument(made);
  const corrupt = (edit: (section: Record<string, unknown>) => void): string => {
    const parsed = JSON.parse(text) as { document: { composites: { sections: Record<string, Record<string, unknown>> } } };
    edit(Object.values(parsed.document.composites.sections)[0] as Record<string, unknown>);
    return JSON.stringify(parsed);
  };

  it('rejects an inconsistent thickness, name, side, zone or material', () => {
    expect(() => deserializeDocument(text)).not.toThrow();
    expect(() => deserializeDocument(corrupt((s) => (s['thickness'] = 5)))).toThrow(/sum of its plies/);
    expect(() => deserializeDocument(corrupt((s) => (s['name'] = '')))).toThrow(/name/);
    expect(() => deserializeDocument(corrupt((s) => (s['laminateSide'] = 'up')))).toThrow(/laminateSide/);
    expect(() => deserializeDocument(corrupt((s) => (s['zoneId'] = 'ghost')))).toThrow(/missing zone/);
    expect(() => deserializeDocument(corrupt((s) => ((s['plies'] as Record<string, unknown>[])[0]!['material'] = 'ghost')))).toThrow(
      /missing material/,
    );
  });
});
