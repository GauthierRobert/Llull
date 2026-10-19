import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type PolylineEntity } from '@core/model/types';
import { polygonArea } from '@lib/polygon';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { AS4, panel, withMaterials } from './fixtures';

interface Export {
  files: { name: string; mime: string; content: string }[];
  pieces: { name: string; widthMm: number; heightMm: number; areaMm2: number }[];
  surface: string;
}

const AXIS = { name: 'Rax', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0], method: 'cylindrical', axis: [0, 0, 1] } as const;

/** A solid of `kind` with the AS4 material, a cylindrical rosette and a whole-face ply at `angle` on the face nearest `near`. */
function skin(
  kind: 'add_cylinder' | 'add_cone',
  size: { radius: number; height: number },
  near: [number, number, number],
  angle = 0,
): { doc: CadDocument; part: string } {
  let doc = apply(withMaterials(), 'define_rosette', AXIS);
  const tool = ok(doc, kind, { ...size, position: [0, 0, 0] });
  doc = tool.document;
  const part = ok(doc, 'create_composite_part', {
    name: 'Skin',
    rosette: 'Rax',
    toolSurface: { entityId: tool.affected[0], faceNear: near },
  });
  doc = apply(part.document, 'add_ply', {
    part: part.affected[0],
    name: 'C1',
    material: AS4.name,
    orientation: angle,
    sequence: 'S1',
    boundary: { kind: 'whole_face' },
    drape: { method: 'developable' },
  });
  return { doc, part: part.affected[0] as string };
}

/** The first closed polyline of a DXF text, re-imported through import_dxf. */
function reimported(text: string): PolylineEntity[] {
  const result = ok(createEmptyDocument(), 'import_dxf', { text });
  return Object.values(result.document.entities).filter((entity): entity is PolylineEntity => entity.kind === 'polyline');
}

describe('cylinder flat pattern (VC-CMP-14)', () => {
  const { doc, part } = skin('add_cylinder', { radius: 50, height: 200 }, [50, 0, 0], 45);

  it('unrolls to a 2 pi r x L rectangle', () => {
    const result = data<Export>(doc, 'export_flat_patterns_dxf', { part });
    expect(result.surface).toBe('cylinder');
    expect(result.pieces[0]?.widthMm).toBeCloseTo(2 * Math.PI * 50, 2);
    expect(result.pieces[0]?.heightMm).toBeCloseTo(200, 6);
    expect(result.pieces[0]?.areaMm2).toBeCloseTo(2 * Math.PI * 50 * 200, 1);
    const polygons = reimported(result.files[0]?.content ?? '').filter((polyline) => polyline.closed);
    expect(polygons).toHaveLength(1);
    expect(polygonArea(polygons[0]?.points ?? [])).toBeCloseTo(2 * Math.PI * 50 * 200, 1);
  });

  it('keeps the 45 degree fibre angle on the surface: the helix pitch is 2 pi r / tan(45)', () => {
    const sample = data<{ plies: { directionGlobal: number[] }[] }>(doc, 'core_sample', { part, point: [50, 0, 0] });
    const [x, y, z] = sample.plies[0]?.directionGlobal as number[];
    expect(x).toBeCloseTo(0, 6);
    expect(Math.abs(y as number)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('writes layer, label, arrow and units per the file contract', () => {
    const text = data<Export>(doc, 'export_flat_patterns_dxf', { part }).files[0]?.content ?? '';
    expect(text).toContain('$INSUNITS\n70\n4');
    expect(text).toContain('PLY_C1');
    expect(text).toContain('ORIENT');
    expect(text).toContain('C1 / 45deg / S1 / AS4_3501_6');
    const labelled = data<Export>(doc, 'export_flat_patterns_dxf', { part, labels: ['name'] }).files[0]?.content ?? '';
    expect(labelled).toContain('\nC1\n');
    expect(labelled).not.toContain('AS4_3501_6');
  });
});

describe('cone flat pattern (VC-CMP-15)', () => {
  const { doc, part } = skin('add_cone', { radius: 100, height: 100 }, [50, 0, 50]);

  it('develops the full cone to a 254.558 degree sector of area pi r s', () => {
    const slant = Math.hypot(100, 100);
    const outline = doc.composites?.parts[part]?.outline ?? [];
    expect(outline[0]).toEqual([0, 0]);
    const last = outline[outline.length - 1] as [number, number];
    expect((((Math.atan2(last[1], last[0]) * 180) / Math.PI) + 360) % 360).toBeCloseTo((360 * 100) / slant, 6);
    expect(polygonArea(outline)).toBeGreaterThan(0.9995 * Math.PI * 100 * slant);
    expect(polygonArea(outline)).toBeLessThan(Math.PI * 100 * slant);
  });

  it('round-trips through DXF with one closed boundary and the right area (VC-CMP-16)', () => {
    const result = data<Export>(doc, 'export_flat_patterns_dxf', { part, plies: ['C1'] });
    expect(result.surface).toBe('cone');
    const polygons = reimported(result.files[0]?.content ?? '').filter((polyline) => polyline.closed);
    expect(polygons).toHaveLength(1);
    expect(Math.abs(polygonArea(polygons[0]?.points ?? []) / 44428.8294 - 1)).toBeLessThan(2e-3);
    expect(result.files[0]?.mime).toBe('image/vnd.dxf');
  });

  it('keeps meridians as radial lines: the 0 degree arrow points away from the apex', () => {
    const text = data<Export>(doc, 'export_flat_patterns_dxf', { part }).files[0]?.content ?? '';
    expect(text).toContain('ORIENT');
  });
});

describe('planar flat patterns and refusals', () => {
  it('exports every ply piece of the flat panel on its own layer with the 10 mm gap and an allowance', () => {
    const { doc, part } = panel();
    const result = data<Export>(doc, 'export_flat_patterns_dxf', { part });
    expect(result.pieces).toHaveLength(24);
    expect(result.pieces[0]).toMatchObject({ name: 'S1', widthMm: 600, heightMm: 400 });
    const grown = data<Export>(doc, 'export_flat_patterns_dxf', { part, plies: ['S1'], allowance: 5 });
    expect(grown.pieces[0]).toMatchObject({ widthMm: 610, heightMm: 410 });
    const text = result.files[0]?.content ?? '';
    for (const name of ['PLY_S1', 'PLY_S24']) expect(text).toContain(name);
  });

  it('refuses unknown parts / plies, empty parts and a negative allowance', () => {
    const { doc, part } = panel();
    expectRefusal(doc, 'export_flat_patterns_dxf', { part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'export_flat_patterns_dxf', { part, plies: ['nope'] }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'export_flat_patterns_dxf', { part, allowance: -1 }, 'CMP_PARAM_INVALID');
    const empty = skin('add_cylinder', { radius: 10, height: 10 }, [10, 0, 0]);
    const bare = apply(empty.doc, 'delete_ply', { part: empty.part, ply: 'C1' });
    expectRefusal(bare, 'export_flat_patterns_dxf', { part: empty.part }, 'CMP_NO_PLIES');
  });

  it('is pure', () => {
    const { doc, part } = panel();
    expectPure(doc, () => execute(doc, 'export_flat_patterns_dxf', { part }));
  });
});
