/**
 * AERO-5 / 06 CMP M5: AP242 composite export and import on the native `llull-kernel` (06 TECHNICAL_SPEC §13.6).
 * A flat panel (exact ply slabs) and a hemisphere cap (faceted ply solids, sphere tool) go to AP242 with their ply table and composite validation
 * properties, and come back through `import_composite_ap242`: same plies, orientations, areas, embedded validation properties green, ply solids
 * linked by name. Skipped without the llull-kernel binary.
 */

import { existsSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { CompositePart, CompositesModel, Ply } from '@core/model/composites';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { parseRecords } from '@lib/step21/records';
import { summarizeStep21 } from '@lib/step21/summary';
import { checkRecords, loadSchema } from '../../tests/helpers/expressSchema';
import { withoutCompositeUsages } from '@aero/composites/ap242/standardReader';
import { apply, data, ok } from '../../tests/helpers/commandAssertions';
import { WOVEN } from '../../tests/unit/aero/composites/drapeFixtures';
import { AS4, ROSETTE, withMaterials } from '../../tests/unit/aero/composites/fixtures';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';

let kernel: IsolatedKernel;

interface Finding {
  readonly property: string;
  readonly band: string;
  readonly recomputed: number;
  readonly relativeDifference: number | null;
}
interface ExportData {
  readonly step: string;
  readonly selfCheck: { readonly band: string };
  readonly validation: { readonly plyCount: number };
  readonly solids: { readonly exact: number; readonly faceted: readonly string[] };
  readonly plies: readonly { readonly area: number }[];
}
interface ImportData {
  readonly validation: { readonly band: string; readonly findings: readonly Finding[] };
  readonly solids: { readonly unlinked: number; readonly perPly: readonly { readonly solids: readonly string[] }[] };
  readonly tool: { readonly imported: boolean; readonly entityId: string };
  readonly reviewRequired: { readonly value: boolean };
}

/** A flat 200 x 100 panel: tool box, three plies (a full 0, a +45 polygon and a -45 polygon), ply solids. */
function panel(): CadDocument {
  let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
  const tool = ok(doc, 'add_box', { size: [200, 100, 10], anchor: 'min', position: [0, 0, -10] });
  doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: 'Panel tool' });
  doc = apply(doc, 'define_rosette', ROSETTE);
  const part = ok(doc, 'create_composite_part', {
    name: 'Panel',
    toolSurface: { entityId: tool.affected[0], faceNear: [100, 50, 0] },
    rosette: 'R0',
  });
  doc = part.document;
  const partId = part.affected[0] as string;
  doc = apply(doc, 'add_ply', { part: partId, name: 'P1', material: WOVEN.name, orientation: 0, boundary: { kind: 'whole_face' } });
  doc = apply(doc, 'add_ply', {
    part: partId,
    name: 'P2',
    material: AS4.name,
    orientation: 45,
    boundary: {
      kind: 'polygon',
      polygons: [
        [
          [20, 10],
          [180, 10],
          [180, 90],
          [20, 90],
        ],
      ],
    },
  });
  doc = apply(doc, 'add_ply', {
    part: partId,
    name: 'P3',
    material: WOVEN.name,
    orientation: -45,
    boundary: {
      kind: 'polygon',
      polygons: [
        [
          [60, 20],
          [140, 20],
          [140, 80],
          [60, 80],
        ],
      ],
    },
  });
  return apply(doc, 'create_ply_solids', { part: partId });
}

describeNative('composite AP242 round trip on the native kernel', () => {
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel as GeometryKernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  /** Parts of the re-imported document keyed by name, with their plies in stacking order. */
  const partOf = (doc: CadDocument, name: string): { part: CompositePart; plies: Ply[] } => {
    const model = doc.composites as CompositesModel;
    const part = Object.values(model.parts).find((candidate) => candidate.name === name) as CompositePart;
    const plies = model.plyOrder
      .map((id) => model.plies[id] as Ply)
      .filter((ply) => ply.partId === part.id)
      .sort((a, b) => a.order - b.order);
    return { part, plies };
  };

  const volumeOf = (doc: CadDocument, id: string): number => data<{ volume: number }>(doc, 'mass_properties', { entityId: id }).volume;
  const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);
  const productsOf = (text: string): string[] => {
    const tree = kernel.importExchange?.('step', text, { precision: 0.01, maxTolerance: 1, heal: true, sew: true }) as unknown as {
      products?: { name: string }[];
    };
    return (tree.products ?? []).map((product) => product.name);
  };

  it('round-trips a flat panel: exact ply solids, ply table, validation properties green', () => {
    const doc = panel();
    const exported = data<ExportData>(doc, 'export_composite_ap242', { part: 'Panel' });
    expect(exported.solids).toEqual({ exact: 3, faceted: [] });
    expect(exported.selfCheck.band).toBe('green');
    expect(exported.validation.plyCount).toBe(3);
    const census = summarizeStep21(exported.step);
    expect(census.fileSchema).toContain('AP242');
    expect(census.entityCensus['MANIFOLD_SOLID_BREP']).toBe(4);
    expect(census.products).toEqual(expect.arrayContaining(['Panel tool', 'P1 piece 1', 'P2 piece 1', 'P3 piece 1']));
    expect(exported.step).toContain("'composite validation property'");

    // OpenCascade's STEP reader loses the ply solids that hang under the shapeless ply products; the import reads the solids without those usages
    expect(productsOf(exported.step)).toEqual(['Panel tool']);
    expect(productsOf(withoutCompositeUsages(exported.step))).toEqual(
      expect.arrayContaining(['Panel tool', 'P1 piece 1', 'P2 piece 1', 'P3 piece 1']),
    );
    const imported = ok(createEmptyDocument(), 'import_composite_ap242', { text: exported.step });
    const result = imported.data as ImportData;
    expect(result.validation.band).toBe('green');
    expect(result.validation.findings.filter((finding) => finding.band === 'green')).toHaveLength(result.validation.findings.length);
    expect(result.validation.findings.length).toBeGreaterThan(40);
    expect(result.solids.unlinked).toBe(0);
    expect(result.tool.imported).toBe(true);
    expect(result.reviewRequired.value).toBe(true);
    const original = partOf(doc, 'Panel');
    const back = partOf(imported.document, 'Panel');
    expect(back.plies.map((ply) => [ply.name, ply.order, ply.orientation, ply.materialName, ply.sequence])).toEqual(
      original.plies.map((ply) => [ply.name, ply.order, ply.orientation, ply.materialName, ply.sequence]),
    );
    expect(back.plies.map((ply) => ply.boundary)).toEqual(original.plies.map((ply) => ply.boundary));
    expect(back.part.outline).toEqual(original.part.outline);
    expect(back.part.surface).toEqual(original.part.surface);
    expect(back.part.toolFaces[0]?.entityId).toBe(result.tool.entityId);
    expect(imported.document.entities[result.tool.entityId]?.name).toBe('Panel tool');
    const model = imported.document.composites as CompositesModel;
    expect(Object.values(model.materials).every((material) => material.basis === 'unknown')).toBe(true);
    const volumes = result.solids.perPly.map((entry) => volumeOf(imported.document, entry.solids[0] as string));
    const expected = [200 * 100 * WOVEN.plyThickness, 160 * 80 * AS4.plyThickness, 80 * 60 * WOVEN.plyThickness];
    const worst = Math.max(...volumes.map((volume, k) => rel(volume, expected[k] as number)));
    console.warn(`panel ply solid volumes ${volumes.join(', ')} vs ${expected.join(', ')}; worst relative ${worst}`);
    expect(worst).toBeLessThan(1e-9);
  });

  it('round-trips a hemisphere cap: faceted ply solids on a sphere tool, draped plies', () => {
    let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
    const tool = ok(doc, 'add_sphere', { radius: 100, position: [0, 0, 0] });
    doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: 'Dome tool' });
    doc = apply(doc, 'define_rosette', ROSETTE);
    const part = ok(doc, 'create_composite_part', {
      name: 'Dome',
      toolSurface: { entityId: tool.affected[0], faceNear: [0, 0, 100] },
      rosette: 'R0',
    });
    doc = part.document;
    for (const [name, orientation] of [
      ['D1', 0],
      ['D2', 90],
    ] as const)
      doc = apply(doc, 'add_ply', { part: part.affected[0], name, material: WOVEN.name, orientation, boundary: { kind: 'whole_face' } });
    doc = apply(doc, 'create_ply_solids', { part: part.affected[0], maxEdge: 20 });
    const exported = data<ExportData>(doc, 'export_composite_ap242', { part: 'Dome' });
    expect(exported.selfCheck.band).toBe('green');
    expect(exported.solids.exact).toBe(0);
    expect(exported.solids.faceted.length).toBeGreaterThan(0);
    const imported = ok(createEmptyDocument(), 'import_composite_ap242', { text: exported.step });
    const result = imported.data as ImportData;
    expect(result.validation.band).toBe('green');
    const original = partOf(doc, 'Dome');
    const back = partOf(imported.document, 'Dome');
    expect(back.part.surface).toEqual(original.part.surface);
    expect(back.plies.map((ply) => [ply.name, ply.orientation, ply.drape])).toEqual(
      original.plies.map((ply) => [ply.name, ply.orientation, ply.drape]),
    );
    expect(result.solids.unlinked).toBe(0);
    const areas = exported.plies.map((ply) => ply.area);
    const recomputed = result.validation.findings.filter((finding) => finding.property === 'ply area').map((finding) => finding.recomputed);
    console.warn(`dome ply areas ${areas.join(', ')} recomputed ${recomputed.join(', ')}; faceted ${exported.solids.faceted.length}`);
    expect(Math.max(...areas.map((area, k) => rel(area, recomputed[k] as number)))).toBeLessThan(1e-9);
  });

  // LLULL_AP242_MIM = path of the ISO/TS 10303-442 MIM long form (mim_lf.exp, public); without it the check is skipped
  const mim = process.env['LLULL_AP242_MIM'];
  it.skipIf(mim === undefined || !existsSync(mim))(
    'every record of the file (OpenCascade base and composite records) conforms to the AP242 ed4 MIM',
    () => {
      const exported = data<ExportData>(panel(), 'export_composite_ap242', { part: 'Panel' });
      const { bodies } = parseRecords(exported.step);
      const { checked, violations } = checkRecords(loadSchema(mim as string), bodies, bodies.keys());
      console.warn(
        `MIM check: ${checked} records (${(exported as unknown as { records: number }).records} composite), ${exported.step.length} bytes, ${violations.length} violations ${JSON.stringify(violations.slice(0, 5))}`,
      );
      expect(checked).toBeGreaterThan(1000);
      expect(violations.slice(0, 10)).toEqual([]);
    },
  );
});
