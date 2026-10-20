/** Ply pieces (several solids per ply), names with characters that Part 21 escapes, and what the export reports as not written (06 CMP M5 review fixes). */

import { describe, expect, it } from 'vitest';
import { readComposite } from '@aero/composites/ap242/reader';
import { withoutCompositeUsages } from '@aero/composites/ap242/standardReader';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, ok } from '../../../helpers/commandAssertions';
import { WOVEN } from './drapeFixtures';
import { ROSETTE, withMaterials } from './fixtures';
import { exportOf, importOf, pliesOfPart, treeOf, type Imported } from './ap242Support';

const box = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

interface Named {
  readonly tool: string;
  readonly part: string;
  readonly plies: readonly [string, string];
}

/** A panel whose second ply covers the whole face over a smaller first ply, so the second ply is split into several solids. */
function stackedPanel(names: Named): CadDocument {
  let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
  const tool = ok(doc, 'add_box', { size: [200, 100, 10], anchor: 'min', position: [0, 0, -10] });
  doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: names.tool });
  doc = apply(doc, 'define_rosette', ROSETTE);
  const part = ok(doc, 'create_composite_part', {
    name: names.part,
    toolSurface: { entityId: tool.affected[0], faceNear: [100, 50, 0] },
    rosette: 'R0',
  });
  doc = apply(part.document, 'add_ply', {
    part: names.part,
    name: names.plies[0],
    material: WOVEN.name,
    orientation: 0,
    boundary: { kind: 'polygon', polygons: [box(20, 10, 100, 90)] },
  });
  doc = apply(doc, 'add_ply', {
    part: names.part,
    name: names.plies[1],
    material: WOVEN.name,
    orientation: 90,
    boundary: { kind: 'whole_face' },
  });
  return apply(doc, 'create_ply_solids', { part: names.part });
}

const PLAIN: Named = { tool: 'Tool', part: 'Stack', plies: ['A', 'B'] };

describe('plies with several solids', () => {
  it('writes one relationship per piece (no chain), reads them back in order, strips all of them for OpenCascade and round-trips', () => {
    const doc = stackedPanel(PLAIN);
    const { data } = exportOf(doc, { part: 'Stack' });
    const pieces = data.plies.find((ply) => ply.name === 'B')?.solids ?? [];
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    const read = readComposite(data.step);
    if (!read.ok) throw new Error(read.reason);
    expect(read.standard.plies.find((ply) => ply.name === 'B')?.pieces).toEqual(pieces);
    // every usage a piece is the related product of has the ply as its relating product: no piece -> piece chain
    const usages = data.step.split('\n').filter((line) => line.includes('NEXT_ASSEMBLY_USAGE_OCCURRENCE('));
    expect(usages.some((line) => /,'(\d+)'\);$/.test(line))).toBe(true);
    expect(withoutCompositeUsages(data.step)).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE(');

    const names = ['Tool', ...data.plies.flatMap((ply) => ply.solids)];
    const volumes = Object.fromEntries(
      data.plies.flatMap((ply) => ply.solids.map((solid) => [solid, (ply.area * ply.thickness) / ply.solids.length])),
    );
    const result = importOf(createEmptyDocument(), { text: data.step }, { stepImport: treeOf(names, volumes) });
    const imported = result.data as Imported;
    expect(imported.solids.unlinked).toBe(0);
    expect(imported.validation.findings.filter((finding) => finding.band !== 'green')).toEqual([]);
    expect(imported.validation.band).toBe('green');
  });

  it('keeps the stacking order of plies that share a sequence label', () => {
    let doc = stackedPanel(PLAIN);
    doc = apply(doc, 'edit_ply', { part: 'Stack', ply: 'A', sequence: 'S' });
    doc = apply(doc, 'edit_ply', { part: 'Stack', ply: 'B', sequence: 'S' });
    const { data } = exportOf(doc, { part: 'Stack' });
    const read = readComposite(data.step);
    if (!read.ok) throw new Error(read.reason);
    expect(read.standard.sequences).toEqual([{ name: 'S', plies: ['A', 'B'] }]);
    expect(read.standard.plies.map((ply) => ply.name)).toEqual(['A', 'B']);
  });
});

describe('names that Part 21 escapes', () => {
  it("round-trips a tool, part and ply names with #, ', \\ and non-ASCII characters through the writer, the reader and the import", () => {
    const names: Named = { tool: "Tøøl #1 'q' \\ x", part: "Pärt #7 '\\\\'", plies: ["P#1 'a' é 😀", 'B \\X2\\0041\\X0\\ #3'] };
    const doc = stackedPanel(names);
    const { result, data } = exportOf(doc, { part: names.part });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(data.selfCheck.band).toBe('green');
    const read = readComposite(data.step);
    if (!read.ok) throw new Error(read.reason);
    expect(read.record.name).toBe(names.part);
    expect(read.record.tool.name).toBe(names.tool);
    expect(read.record.plies.map((ply) => ply.name)).toEqual([...names.plies]);
    expect(read.standard.plies.map((ply) => ply.name)).toEqual([...names.plies]);
    expect(read.standard.table).toBe(names.part);

    const solids = data.plies.flatMap((ply) => ply.solids);
    const volumes = Object.fromEntries(
      data.plies.flatMap((ply) => ply.solids.map((solid) => [solid, (ply.area * ply.thickness) / ply.solids.length])),
    );
    const back = importOf(createEmptyDocument(), { text: data.step }, { stepImport: treeOf([names.tool, ...solids], volumes) });
    const imported = back.data as Imported;
    expect(imported.tool.imported).toBe(true);
    expect(imported.solids.unlinked).toBe(0);
    expect(imported.validation.band).toBe('green');
    expect(pliesOfPart(back.document, names.part).plies.map((ply) => ply.name)).toEqual([...names.plies]);
  });
});

describe('what the export does not write', () => {
  it('reports cores and lamina data of unverified basis for review', () => {
    let doc = stackedPanel(PLAIN);
    expect(exportOf(doc, { part: 'Stack' }).data.reviewRequired).toEqual({ value: false, reasons: [] });
    doc = apply(doc, 'create_lamina_material', {
      name: 'Honey',
      form: 'core_honeycomb',
      E1: 100,
      E2: 100,
      G12: 50,
      nu12: 0.1,
      plyThickness: 10,
      density: 0.00005,
      basis: 'b_basis',
      source: 'test',
    });
    doc = apply(doc, 'add_core', {
      part: 'Stack',
      boundary: box(110, 10, 190, 90),
      material: 'Honey',
      thickness: 10,
      chamferAngle: 30,
      afterPly: 'B',
    });
    const { data } = exportOf(doc, { part: 'Stack' });
    expect(data.notWritten).toEqual({ cores: 1 });
    expect(data.reviewRequired).toEqual({ value: true, reasons: ['cores_not_written'] });

    const mean = apply(doc, 'create_lamina_material', { ...WOVEN, name: 'Mean', basis: 'mean' });
    const added = apply(mean, 'add_ply', { part: 'Stack', name: 'C', material: 'Mean', orientation: 45, boundary: { kind: 'whole_face' } });
    expect(exportOf(added, { part: 'Stack' }).data.reviewRequired.reasons).toEqual(['cores_not_written', 'unverified_material_basis']);
  });
});
