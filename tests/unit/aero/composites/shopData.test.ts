import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { panel, panelPart } from './fixtures';

interface Section {
  id: string;
  name: string;
  zoneId?: string;
  thickness: number;
  plies: { material: string; thickness: number; angleDeg: number }[];
}
interface Files {
  files: { name: string; mime: string; content: string }[];
}

const { doc, part } = panel();

describe('laminate sections for analysis (VC-CMP-26)', () => {
  const made = ok(doc, 'create_laminate_sections', { part });
  const sections = Object.values(made.document.composites?.sections ?? {}) as Section[];

  it('stores one section per zone whose plies equal the core sample of that zone', () => {
    expect(made.affected).toHaveLength(3);
    expect(sections.map((section) => section.name)).toEqual(['Z-base', 'Z-pad', 'Z-hole']);
    expect(sections.map((section) => section.plies.length)).toEqual([8, 16, 24]);
    expect(sections.map((section) => section.thickness)).toEqual([1, 2, 3]);
    const base = data<{ plies: { angleRosetteDeg: number }[] }>(doc, 'core_sample', { part, point: [50, 50, 0] });
    expect(sections[0]?.plies.map((ply) => ply.angleDeg)).toEqual(base.plies.map((ply) => ply.angleRosetteDeg));
    expect(sections[0]?.plies.every((ply) => ply.material === 'T300_5208' && ply.thickness === 0.125)).toBe(true);
    expect(sections.every((section) => /^section-\d+\.\d+$/.test(section.id))).toBe(true);
  });

  it('replaces the sections of the part on a second run and survives save / load', () => {
    const again = apply(made.document, 'create_laminate_sections', { part });
    expect(Object.keys(again.composites?.sections ?? {})).toHaveLength(3);
    expect(Object.keys(again.composites?.sections ?? {})).not.toEqual(Object.keys(made.document.composites?.sections ?? {}));
    const loaded = deserializeDocument(serializeDocument(made.document));
    expect(loaded.composites?.sections).toEqual(made.document.composites?.sections);
  });

  it('exports solver-neutral JSON with the lamina records used', () => {
    const result = data<Files & { sections: Section[]; materials: Record<string, { E1: number; density: number }> }>(
      made.document,
      'export_laminate_sections',
      { part },
    );
    expect(result.sections).toHaveLength(3);
    expect(result.materials['T300_5208']?.E1).toBe(181000);
    const file = JSON.parse(result.files[0]?.content ?? '{}') as { format: string; lengthUnit: string; sections: unknown[] };
    expect(file).toMatchObject({ format: 'llull-laminate-sections', lengthUnit: 'mm' });
    expect(file.sections).toHaveLength(3);
    expect(result.files[0]?.mime).toBe('application/json');
  });

  it('refuses unknown parts, parts without plies or sections, and malformed stored sections', () => {
    expectRefusal(doc, 'create_laminate_sections', { part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(panelPart().doc, 'create_laminate_sections', { part: panelPart().part }, 'CMP_NO_PLIES');
    expectRefusal(doc, 'export_laminate_sections', { part }, 'CMP_NO_PLIES');
    expectRefusal(doc, 'export_laminate_sections', { part: 'nope' }, 'CMP_REF_MISSING');
    const text = serializeDocument(made.document);
    const broken = JSON.parse(text) as { document: { composites: { sections: Record<string, { plies: unknown; partId: string }> } } };
    const id = Object.keys(broken.document.composites.sections)[0] as string;
    (broken.document.composites.sections[id] as { plies: unknown }).plies = [{ material: 'x' }];
    expect(() => deserializeDocument(JSON.stringify(broken))).toThrow(/sections/);
    (broken.document.composites.sections[id] as { partId: string }).partId = 'ghost';
    expect(() => deserializeDocument(JSON.stringify(broken))).toThrow(/missing part/);
  });

  it('builds a section for a part without zones and is pure', () => {
    const { doc: bare, part: p } = panelPart();
    const plied = apply(bare, 'add_ply', { part: p, name: 'A', material: 'T300_5208', orientation: 45, boundary: { kind: 'whole_face' } });
    const single = Object.values(apply(plied, 'create_laminate_sections', { part: p }).composites?.sections ?? {});
    expect(single).toHaveLength(1);
    expect(single[0]?.zoneId).toBeUndefined();
    expectPure(doc, () => execute(doc, 'create_laminate_sections', { part }));
    expectPure(made.document, () => execute(made.document, 'export_laminate_sections', { part }));
  });
});

describe('ply table CSV (VC-CMP-29) and ply book data (VC-CMP-28)', () => {
  const csvOf = (document: typeof doc, partRef: string): string =>
    data<Files>(document, 'export_ply_table', { part: partRef }).files[0]?.content ?? '';

  it('writes one row per ply with area in mm^2 and mass', () => {
    const lines = csvOf(doc, part).trimEnd().split('\n');
    expect(lines[0]).toBe('ply,sequence,order,material,orientation,rosette,zones,area_mm2,mass');
    expect(lines).toHaveLength(25);
    expect(lines[1]).toBe('S1,S1,0,T300_5208,45,R0,Z-base|Z-pad|Z-hole,240000,48');
    expect(Number(lines[24]?.split(',')[7])).toBe(240000);
    expect(Number(lines[12]?.split(',')[7])).toBeGreaterThan(6400);
  });

  it('round-trips a whole-face part byte for byte through import_ply_table', () => {
    const { doc: bare, part: first } = panelPart();
    let source = bare;
    for (const [name, angle] of [
      ['A', 45],
      ['B, "quoted"', -45],
      ['C', 0],
    ] as const)
      source = apply(source, 'add_ply', {
        part: first,
        name,
        material: 'T300_5208',
        orientation: angle,
        sequence: `Q-${name.length}`,
        boundary: { kind: 'whole_face' },
      });
    const text = csvOf(source, first);
    expect(text).toContain('"B, ""quoted"""');
    const second = ok(source, 'create_composite_part', {
      name: 'Second',
      rosette: 'R0',
      toolSurface: { entityId: Object.keys(source.entities)[0], faceNear: [300, 200, 0] },
    });
    const imported = ok(second.document, 'import_ply_table', { part: 'Second', csv: text });
    expect(imported.affected).toHaveLength(3);
    expect(csvOf(imported.document, 'Second')).toBe(text);
    const replaced = apply(imported.document, 'import_ply_table', { part: 'Second', csv: text, replace: true });
    expect(Object.values(replaced.composites?.plies ?? {}).filter((ply) => ply.partId === second.affected[0])).toHaveLength(3);
  });

  it('sorts rows by order, fills defaults and refuses bad tables', () => {
    const { doc: bare, part: p } = panelPart();
    const csv = 'ply,material,orientation,order\nTop,T300_5208,90,1\nBottom,T300_5208,0,0\n';
    const result = apply(bare, 'import_ply_table', { part: p, csv });
    const plies = Object.values(result.composites?.plies ?? {}).sort((a, b) => a.order - b.order);
    expect(plies.map((ply) => ply.name)).toEqual(['Bottom', 'Top']);
    expect(plies.map((ply) => ply.sequence)).toEqual(['S1', 'S2']);
    expectRefusal(result, 'import_ply_table', { part: p, csv }, 'CMP_PARAM_INVALID');
    expectRefusal(bare, 'import_ply_table', { part: 'nope', csv }, 'CMP_REF_MISSING');
    expectRefusal(bare, 'import_ply_table', { part: p, csv: '' }, 'CMP_CSV_PARSE');
    expectRefusal(bare, 'import_ply_table', { part: p, csv: 'a,"b\n' }, 'CMP_CSV_PARSE');
    expectRefusal(bare, 'import_ply_table', { part: p, csv: 'ply,material\nA,T300_5208\n' }, 'CMP_CSV_PARSE');
    expectRefusal(bare, 'import_ply_table', { part: p, csv: 'ply,material,orientation\n' }, 'CMP_CSV_PARSE');
    expectRefusal(bare, 'import_ply_table', { part: p, csv: 'ply,material,orientation\nA,T300_5208,x\n' }, 'CMP_CSV_PARSE');
    expectRefusal(bare, 'import_ply_table', { part: p, csv: 'ply,material,orientation\nA,nope,0\n' }, 'CMP_REF_MISSING');
    expectRefusal(bare, 'import_ply_table', { part: p, csv: 'ply,material,orientation,rosette\nA,T300_5208,0,nope\n' }, 'CMP_REF_MISSING');
    expectRefusal(
      bare,
      'import_ply_table',
      { part: p, csv: 'ply,material,orientation\nA,T300_5208,0\nA,T300_5208,90\n' },
      'CMP_NAME_TAKEN',
    );
    expect(execute(bare, 'import_ply_table', { part: p, csv: 'ply,material,orientation\r\nA,T300_5208,0\r\n' }).rejected).toBeUndefined();
    expectRefusal(bare, 'export_ply_table', { part: p }, 'CMP_NO_PLIES');
    expectRefusal(bare, 'export_ply_table', { part: 'nope' }, 'CMP_REF_MISSING');
    expectPure(bare, () => execute(bare, 'import_ply_table', { part: p, csv }));
  });

  it('groups the plies of each sequence with area, pieces and boundary length', () => {
    const book = data<{
      sequences: { sequence: string; plies: { id: string; areaMm2: number; flatPieceIds: string[]; boundaryLengthMm: number }[] }[];
      reviewRequired: boolean;
      unverified: boolean;
    }>(doc, 'ply_book_data', { part });
    expect(book.sequences).toHaveLength(24);
    expect(book.sequences[0]?.plies[0]).toMatchObject({ areaMm2: 240000, boundaryLengthMm: 2000 });
    expect(book.sequences[0]?.plies[0]?.flatPieceIds[0]).toMatch(/^ply-\d+\.\d+\.o0$/);
    expect(book.reviewRequired).toBe(true);
    expect(book.unverified).toBe(false);
    expectRefusal(doc, 'ply_book_data', { part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(panelPart().doc, 'ply_book_data', { part: panelPart().part }, 'CMP_NO_PLIES');
    expectPure(doc, () => execute(doc, 'ply_book_data', { part }));
  });
});
