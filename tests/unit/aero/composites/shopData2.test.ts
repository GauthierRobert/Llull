import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { MeshSolidEntity } from '@core/model/types';
import { meshVolume } from '@aero/composites/plySolid';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { AS4, ROSETTE, T300, panel, panelPart, withMaterials } from './fixtures';
import { WOVEN, spherePart } from './drapeFixtures';

interface Laser {
  files: { name: string; content: string }[];
  pieces: { points: number; maxGapMm: number }[];
}
interface Book {
  sheets: { sequence: string; plies: { name: string; areaMm2: number }[] }[];
  files: { name: string; mime: string; content: string }[];
  reviewRequired: boolean;
}
interface Solids {
  solids: { id: string; ply: string; volume: number }[];
  totalVolume: number;
}

const blocks = (text: string): { header: string; points: number[][] }[] => {
  const out: { header: string; points: number[][] }[] = [];
  let current: { header: string; points: number[][] } | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('PLY ')) current = { header: line, points: [] };
    else if (line === 'END' && current !== null) {
      out.push(current);
      current = null;
    } else if (current !== null && line !== '') current.points.push(line.split(' ').map(Number));
  }
  return out;
};

const signedArea = (points: number[][]): number =>
  points.reduce(
    (sum, p, k) =>
      sum +
      (p[0] as number) * ((points[(k + 1) % points.length] as number[])[1] as number) -
      ((points[(k + 1) % points.length] as number[])[0] as number) * (p[1] as number),
    0,
  ) / 2;

describe('export_laser_projection (VC-CMP-17)', () => {
  const { doc, part } = panel();

  it('lists every ply piece with ordered 3D points at most `spacing` apart and every corner', () => {
    const result = data<Laser>(doc, 'export_laser_projection', { part });
    const text = result.files[0]?.content ?? '';
    expect(text.startsWith('# llull laser projection v1   units=mm   frame=tool   part=Skin_panel')).toBe(true);
    const parsed = blocks(text);
    expect(parsed.length).toBe(result.pieces.length);
    expect(parsed.length).toBeGreaterThanOrEqual(24);
    for (const block of parsed) {
      expect(block.header).toMatch(/^PLY \S+ SEQ \S+ MATERIAL T300_5208 ANGLE -?\d+ POINTS \d+$/);
      const n = Number((block.header.match(/POINTS (\d+)/) as RegExpMatchArray)[1]);
      expect(block.points).toHaveLength(n);
      expect(signedArea(block.points)).toBeGreaterThan(0);
      for (const [k, p] of block.points.entries()) {
        const q = block.points[(k + 1) % n] as number[];
        expect(Math.hypot((p[0] as number) - (q[0] as number), (p[1] as number) - (q[1] as number))).toBeLessThanOrEqual(75 + 1e-6);
        expect(p[2]).toBeCloseTo(0, 6);
      }
    }
    const whole = parsed.find((block) => block.points.some((p) => p[0] === 0 && p[1] === 0));
    for (const corner of [
      [0, 0],
      [600, 0],
      [600, 400],
      [0, 400],
    ])
      expect(whole?.points.some((p) => p[0] === corner[0] && p[1] === corner[1])).toBe(true);
  });

  it('honours a tighter spacing and a ply selection', () => {
    const tight = data<Laser>(doc, 'export_laser_projection', { part, plies: ['S1'], spacing: 20 });
    expect(tight.pieces).toHaveLength(1);
    expect(tight.pieces[0]?.maxGapMm).toBeLessThanOrEqual(20 + 1e-6);
    expect(tight.pieces[0]?.points).toBeGreaterThan(20);
  });

  it('follows the tool face of a cylinder and reverses the winding for the inward side', () => {
    let cyl = apply(withMaterials(), 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    const tool = ok(cyl, 'add_cylinder', { radius: 50, height: 200, position: [0, 0, 0] });
    cyl = tool.document;
    const created = ok(cyl, 'create_composite_part', {
      name: 'Tube',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 0] },
    });
    cyl = apply(created.document, 'add_ply', {
      part: created.affected[0],
      name: 'C1',
      material: AS4.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const text = data<Laser>(cyl, 'export_laser_projection', { part: created.affected[0] }).files[0]?.content ?? '';
    for (const p of blocks(text).flatMap((block) => block.points)) expect(Math.hypot(p[0] as number, p[1] as number)).toBeCloseTo(50, 3);
    const inward = apply(created.document, 'create_composite_part', {
      name: 'In',
      rosette: 'Rax',
      laminateSide: 'negative_normal',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 0] },
    });
    const inwardPart = Object.values(inward.composites?.parts ?? {}).find((p) => p.name === 'In');
    expect(inwardPart?.laminateSide).toBe('negative_normal');
  });

  it('refuses bad input and does not change the document', () => {
    expectRefusal(doc, 'export_laser_projection', { part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'export_laser_projection', { part, plies: ['nope'] }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'export_laser_projection', { part, spacing: -1 }, 'CMP_PARAM_INVALID');
    expectRefusal(doc, 'export_laser_projection', { part, cornerAngle: 0 }, 'CMP_PARAM_INVALID');
    expectRefusal(panelPart().doc, 'export_laser_projection', { part: panelPart().part }, 'CMP_NO_PLIES');
    expectPure(doc, () => execute(doc, 'export_laser_projection', { part }));
  });
});

describe('export_ply_book (VC-CMP-28)', () => {
  const { doc, part } = panel();

  it('writes one SVG sheet per sequence with the table area matching the DXF piece area', () => {
    const book = data<Book>(doc, 'export_ply_book', { part });
    const sequences = new Set(Object.values(doc.composites?.plies ?? {}).map((ply) => ply.sequence));
    expect(book.files).toHaveLength(sequences.size);
    expect(book.sheets).toHaveLength(sequences.size);
    expect(book.reviewRequired).toBe(true);
    for (const file of book.files) {
      expect(file.mime).toBe('image/svg+xml');
      expect(file.content.startsWith('<svg')).toBe(true);
      expect(file.content).toContain('<path');
      expect(file.content).toContain('not approved');
    }
    const dxf = data<{ pieces: { name: string; areaMm2: number }[] }>(doc, 'export_ply_flat_patterns_dxf', { part });
    for (const sheet of book.sheets)
      for (const row of sheet.plies) {
        const expected = dxf.pieces.filter((piece) => piece.name === row.name).reduce((sum, piece) => sum + piece.areaMm2, 0);
        expect(Math.abs(row.areaMm2 / expected - 1)).toBeLessThan(0.002);
      }
  });

  it('accepts a sheet size and refuses a part without plies', () => {
    expect(data<Book>(doc, 'export_ply_book', { part, sheetSize: 'A4' }).files[0]?.content).toContain('width="297mm"');
    expectRefusal(doc, 'export_ply_book', { part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(panelPart().doc, 'export_ply_book', { part: panelPart().part }, 'CMP_NO_PLIES');
    expectPure(doc, () => execute(doc, 'export_ply_book', { part }));
  });

  it('flattens sphere-cap plies through the drape and notes locked ones', () => {
    const base = spherePart();
    const cap = Array.from({ length: 32 }, (_, k): [number, number] => [
      100 * (0.35 * Math.cos((2 * Math.PI * k) / 32)),
      100 * (0.35 * Math.sin((2 * Math.PI * k) / 32)),
    ]);
    let laid = apply(base.doc, 'add_ply', {
      part: base.part,
      name: 'Cap',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'polygon', polygons: [cap] },
      drape: { stepLength: 3 },
    });
    laid = apply(laid, 'add_ply', {
      part: base.part,
      name: 'Whole',
      material: WOVEN.name,
      orientation: 0,
      sequence: 'S9',
      boundary: { kind: 'whole_face' },
      drape: { stepLength: 5 },
    });
    const book = data<Book>(laid, 'export_ply_book', { part: base.part });
    expect(book.files).toHaveLength(2);
    expect(book.files.some((file) => file.content.includes('no flat pattern'))).toBe(true);
    expect(book.files.some((file) => file.content.includes('Cap 0deg'))).toBe(true);
  });
});

describe('create_ply_solids (VC-CMP-30)', () => {
  const { doc, part } = panel();

  it('creates one closed mesh solid per ply piece with volume = area x thickness and stacked heights', () => {
    const result = ok(doc, 'create_ply_solids', { part, plies: ['S1', 'S2'] });
    const info = result.data as Solids;
    expect(info.solids).toHaveLength(2);
    const areas = data<{ pieces: { name: string; areaMm2: number }[] }>(doc, 'export_ply_flat_patterns_dxf', {
      part,
      plies: ['S1', 'S2'],
    }).pieces;
    for (const [k, solid] of info.solids.entries())
      expect(Math.abs(solid.volume / ((areas[k]?.areaMm2 ?? 0) * 0.125) - 1)).toBeLessThan(0.005);
    const entities = result.affected.map((id) => result.document.entities[id] as MeshSolidEntity);
    expect(entities.every((entity) => entity.kind === 'mesh' && meshVolume(entity.mesh) > 0)).toBe(true);
    const zs = entities.map((entity) => {
      const values = entity.mesh.positions.filter((_, i) => i % 3 === 2);
      return [Math.min(...values), Math.max(...values)];
    });
    expect(zs[0]).toEqual([0, 0.125].map((v) => expect.closeTo(v, 6)));
    expect(zs[1]).toEqual([0.125, 0.25].map((v) => expect.closeTo(v, 6)));
    const stl = data<{ stl: string; triangleCount: number }>(result.document, 'export_stl', {
      entityIds: result.affected,
      perEntity: true,
    });
    expect(stl.stl.match(/endsolid/g)).toHaveLength(2);
  });

  it('meshes a ramped panel ply on the plies below it', () => {
    const result = ok(doc, 'create_ply_solids', { part });
    const info = result.data as Solids;
    expect(info.solids.length).toBeGreaterThanOrEqual(24);
    const areas = data<{ pieces: { areaMm2: number }[] }>(doc, 'export_ply_flat_patterns_dxf', { part }).pieces;
    const expected = areas.reduce((sum, piece) => sum + piece.areaMm2, 0) * 0.125;
    expect(Math.abs(info.totalVolume / expected - 1)).toBeLessThan(0.005);
    const top = Math.max(
      ...result.affected.flatMap((id) => (result.document.entities[id] as MeshSolidEntity).mesh.positions.filter((_, i) => i % 3 === 2)),
    );
    expect(top).toBeCloseTo(24 * 0.125, 6);
  });

  it('meshes cylinder and sphere cap plies within the shell volume formula', () => {
    let cyl = apply(withMaterials(), 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    const tool = ok(cyl, 'add_cylinder', { radius: 50, height: 200, position: [0, 0, 0] });
    cyl = tool.document;
    const created = ok(cyl, 'create_composite_part', {
      name: 'Tube',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 0] },
    });
    cyl = apply(created.document, 'add_ply', {
      part: created.affected[0],
      name: 'C1',
      material: T300.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const tube = (ok(cyl, 'create_ply_solids', { part: created.affected[0], maxEdge: 4 }).data as Solids).solids[0];
    const shell = Math.PI * (50.125 ** 2 - 50 ** 2) * 200;
    expect(Math.abs((tube?.volume ?? 0) / shell - 1)).toBeLessThan(0.01);
    const dome = spherePart();
    const cap = Array.from({ length: 48 }, (_, k): [number, number] => [
      100 * 0.3 * Math.cos((2 * Math.PI * k) / 48),
      100 * 0.3 * Math.sin((2 * Math.PI * k) / 48),
    ]);
    const laid = apply(dome.doc, 'add_ply', {
      part: dome.part,
      name: 'Cap',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'polygon', polygons: [cap] },
    });
    const solid = (ok(laid, 'create_ply_solids', { part: dome.part, maxEdge: 3 }).data as Solids).solids[0];
    const spherical = ((2 * Math.PI * (100.25 ** 3 - 100 ** 3)) / 3) * (1 - Math.cos(0.3));
    expect(Math.abs((solid?.volume ?? 0) / spherical - 1)).toBeLessThan(0.03);
  });

  it('winds outward on the inward laminate side too', () => {
    let inside = apply(withMaterials(), 'define_rosette', ROSETTE);
    const tool = ok(inside, 'add_box', { size: [100, 100, 10], anchor: 'min', position: [0, 0, -10] });
    inside = tool.document;
    const created = ok(inside, 'create_composite_part', {
      name: 'Neg',
      rosette: 'R0',
      laminateSide: 'negative_normal',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 50, 0] },
    });
    inside = apply(created.document, 'add_ply', {
      part: created.affected[0],
      name: 'P',
      material: T300.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const solid = ok(inside, 'create_ply_solids', { part: created.affected[0] });
    const mesh = (solid.document.entities[solid.affected[0] as string] as MeshSolidEntity).mesh;
    expect(meshVolume(mesh)).toBeCloseTo(100 * 100 * 0.125, 4);
    const zs = mesh.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(0, 6);
    expect(Math.min(...zs)).toBeCloseTo(-0.125, 6);
  });

  it('refuses bad input', () => {
    expectRefusal(doc, 'create_ply_solids', { part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'create_ply_solids', { part, plies: ['nope'] }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'create_ply_solids', { part, maxEdge: 0 }, 'CMP_PARAM_INVALID');
    expectRefusal(panelPart().doc, 'create_ply_solids', { part: panelPart().part }, 'CMP_NO_PLIES');
    expectPure(doc, () => execute(doc, 'create_ply_solids', { part, plies: ['S1'] }));
  });
});
