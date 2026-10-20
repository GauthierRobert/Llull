/** ap242Import: composite AP242 export / import (06 CMP M5), split from the former ap242.test.ts. Fixtures in ap242Support.ts. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { apply, ok } from '../../../helpers/commandAssertions';
import { readComposite } from '@aero/composites/ap242/reader';
import { withoutCompositeUsages } from '@aero/composites/ap242/standardReader';
import { createEmptyDocument } from '@core/model/types';
import { fakeStepText } from '../../../helpers/fakeXdeKernel';
import { WOVEN } from './drapeFixtures';
import type { CadDocument } from '@core/model/types';
import { AS4, withMaterials } from './fixtures';
import { ctxOf, exportOf, importOf, modelOf, panelDoc, pliesOfPart, treeOf, type Imported } from './ap242Support';

const PANEL_VOLUMES = { 'P1 piece 1': 5000, 'P2 piece 1': 1600, 'P3 piece 1': 1200 };

describe('import_composite_ap242', () => {
  const exported = (): { doc: CadDocument; step: string; names: string[] } => {
    const { doc } = panelDoc();
    const { data } = exportOf(doc);
    return { doc, step: data.step, names: ['Panel tool', 'P1 piece 1', 'P2 piece 1', 'P3 piece 1'] };
  };

  it('rebuilds the part, plies, rosette and unverified materials; attaches the part to the imported tool solid', () => {
    const { doc, step, names } = exported();
    const result = importOf(createEmptyDocument(), { text: step }, { stepImport: treeOf(names, PANEL_VOLUMES) });
    expect(result.rejected).toBeUndefined();
    const data = result.data as Imported;
    expect(data.validation.band).toBe('green');
    expect(data.validation.findings.filter((finding) => finding.band !== 'green')).toEqual([]);
    expect(data.validation.findings.length).toBeGreaterThan(60);
    expect(data.tool.imported).toBe(true);
    expect(data.solids.imported).toHaveLength(4);
    expect(data.solids.unlinked).toBe(0);
    expect(data.materials.created.sort()).toEqual([AS4.name, WOVEN.name].sort());
    expect(data.rosettes.created).toEqual(['R0']);
    expect(data.reviewRequired).toEqual({ value: true, reasons: ['composite_import_unverified'] });
    const back = pliesOfPart(result.document, 'Panel');
    const original = pliesOfPart(doc, 'Panel');
    expect(back.plies.map((ply) => [ply.name, ply.order, ply.orientation, ply.materialName, ply.sequence, ply.boundary])).toEqual(
      original.plies.map((ply) => [ply.name, ply.order, ply.orientation, ply.materialName, ply.sequence, ply.boundary]),
    );
    expect(back.part.outline).toEqual(original.part.outline);
    expect(back.part.surface).toEqual(original.part.surface);
    expect(back.part.toolFaces[0]?.entityId).toBe(data.tool.entityId);
    expect(result.document.entities[data.tool.entityId]?.name).toBe('Panel tool');
    expect(Object.values(modelOf(result.document).materials).every((material) => material.basis === 'unknown')).toBe(true);
    expect(result.affected).toEqual(expect.arrayContaining([data.part]));
    expect(result.summary).toContain('Review required');
  });

  it('builds the part without solids (importSolids false), keeping the tool id of the file; reuses materials and rosettes the document has', () => {
    const { doc, step } = exported();
    const result = importOf(doc, { stepBase64: Buffer.from(step).toString('base64'), name: 'Panel copy', importSolids: false });
    expect(result.rejected).toBeUndefined();
    const data = result.data as Imported;
    expect(data.tool.imported).toBe(false);
    expect(data.solids.imported).toEqual([]);
    expect(data.materials.reused.sort()).toEqual([AS4.name, WOVEN.name].sort());
    expect(data.rosettes.created).toEqual([]);
    expect(pliesOfPart(result.document, 'Panel copy').plies).toHaveLength(3);
    expect(Object.keys(modelOf(result.document).materials)).toHaveLength(Object.keys(modelOf(doc).materials).length);
    expectPure(doc, () => importOf(doc, { text: step, importSolids: false, name: 'Another' }));
  });

  it('flags a tampered ply area red, a small deviation yellow and a removed property not checkable; the import still completes for review', () => {
    const { step } = exported();
    const areaRecord = /#(\d+)=MEASURE_REPRESENTATION_ITEM\('ply area',AREA_MEASURE\(12800\.\),#\d+\);/.exec(step);
    expect(areaRecord, 'the P2 area record').not.toBeNull();
    const tampered = (value: string): string => step.replace(`'ply area',AREA_MEASURE(12800.)`, `'ply area',AREA_MEASURE(${value})`);
    const findingOf = (text: string, property: string, subject: string): { band: string } | undefined =>
      (
        (importOf(createEmptyDocument(), { text, importSolids: false }).data as Imported).validation.findings as {
          property: string;
          subject: string;
          band: string;
        }[]
      ).find((finding) => finding.property === property && finding.subject === subject);
    const red = importOf(createEmptyDocument(), { text: tampered('15000.'), importSolids: false });
    expect(red.rejected).toBeUndefined();
    expect((red.data as Imported).validation.band).toBe('red');
    expect((red.data as Imported).reviewRequired.reasons).toContain('validation_red');
    expect(findingOf(tampered('12800.5'), 'ply area', 'P2')?.band).toBe('yellow');
    const removed = step.replaceAll("'llull composite validation','ply area'", "'llull composite validation','other'");
    expect(findingOf(removed, 'ply area', 'P2')?.band).toBe('not_checkable');
  });

  it('refuses bad input: no text, other-system files, damaged records, a taken name, solids the kernel cannot import', () => {
    const { step } = exported();
    const empty = createEmptyDocument();
    expect(execute(empty, 'import_composite_ap242', {}, ctxOf().ctx).error?.code).toBe('CMP_PARAM_INVALID');
    const plain = fakeStepText([{ name: 'Plate', volume: 1, area: 1, centroid: [0, 0, 0] }]);
    expect(importOf(empty, { text: plain, importSolids: false }).error?.code).toBe('CMP_AP242_NO_COMPOSITE');
    expect(importOf(empty, { text: 'not a step file', importSolids: false }).error?.code).toBe('CMP_AP242_NO_COMPOSITE');
    const damaged: [string, (text: string) => string][] = [
      ['an unknown encoding', (text) => text.replace('llull-composite-2', 'llull-composite-9')],
      ['no tool name', (text) => text.replace("DESCRIPTIVE_REPRESENTATION_ITEM('tool'", "DESCRIPTIVE_REPRESENTATION_ITEM('toll'")],
      ['no part frame', (text) => text.replace('{"surface":', '{"surfacx":')],
      [
        'no rosette method',
        (text) => text.replace("DESCRIPTIVE_REPRESENTATION_ITEM('method'", "DESCRIPTIVE_REPRESENTATION_ITEM('methode'"),
      ],
      ['a rosette without axis0', (text) => text.replace("DIRECTION('axis0'", "DIRECTION('axisx'")],
      ['unreadable material data', (text) => text.replace('"source":"', '"source":')],
      [
        'a ply without orientation',
        (text) => text.replace("MEASURE_REPRESENTATION_ITEM('orientation'", "MEASURE_REPRESENTATION_ITEM('orientatio'"),
      ],
      [
        'a degenerate ply boundary',
        (text) => text.replace(/POLYLINE\('ply boundary 1',\((#\d+),(#\d+),#\d+,#\d+\)\)/, "POLYLINE('ply boundary 1',($1,$2))"),
      ],
      [
        'a part rosette the file lacks',
        (text) =>
          text.replace("DESCRIPTIVE_REPRESENTATION_ITEM('part rosette','R0')", "DESCRIPTIVE_REPRESENTATION_ITEM('part rosette','R9')"),
      ],
    ];
    for (const [what, damage] of damaged) {
      const text = damage(step);
      expect(text, what).not.toBe(step);
      expect(importOf(empty, { text, importSolids: false }).error?.code, what).toBe('CMP_AP242_MALFORMED');
    }
    const taken = importOf(empty, { text: step, importSolids: false });
    expect(taken.rejected).toBeUndefined();
    const again = importOf(taken.document, { text: step, importSolids: false });
    expect(again.error?.code).toBe('CMP_NAME_TAKEN');
    expectNoOp(again, taken.document);
    const noKernel = execute(empty, 'import_composite_ap242', { text: step }, { ...defaultContext(), kernel: null });
    expect(noKernel.rejected).toBe(true);
    const failing = importOf(empty, { text: step }, { stepImport: { error: 'no_solid', detail: 'nothing' } });
    expect(failing.error?.code).toBe('CMP_AP242_SOLIDS_FAILED');
    expectNoOp(failing, empty);
  });

  it('turns a ply solid the file lists but the import did not yield, a missing tool solid and a wrong ply solid volume into red findings for review', () => {
    const { step } = exported();
    const missing = importOf(createEmptyDocument(), { text: step }, { stepImport: treeOf(['Panel tool', 'P1 piece 1'], PANEL_VOLUMES) });
    expect(missing.rejected).toBeUndefined();
    const data = missing.data as Imported;
    expect(data.solids.unlinked).toBe(2);
    expect(data.validation.band).toBe('red');
    expect(data.reviewRequired.reasons).toEqual(expect.arrayContaining(['solids_unlinked', 'validation_red']));
    expect(
      data.validation.findings.filter((finding) => finding.property === 'structure: ply solids linked' && finding.band === 'red'),
    ).toHaveLength(2);

    const noTool = importOf(
      createEmptyDocument(),
      { text: step },
      { stepImport: treeOf(['P1 piece 1', 'P2 piece 1', 'P3 piece 1'], PANEL_VOLUMES) },
    );
    const toolData = noTool.data as Imported;
    expect(toolData.tool.imported).toBe(false);
    expect(toolData.reviewRequired.reasons).toEqual(expect.arrayContaining(['tool_not_imported', 'validation_red']));
    expect(toolData.validation.findings.find((finding) => finding.property === 'structure: tool solid imported')?.band).toBe('red');

    const names = ['Panel tool', 'P1 piece 1', 'P2 piece 1', 'P3 piece 1'];
    const wrong = importOf(createEmptyDocument(), { text: step }, { stepImport: treeOf(names, { ...PANEL_VOLUMES, 'P2 piece 1': 1640 }) });
    const volume = (wrong.data as Imported).validation.findings.filter((finding) => finding.property === 'structure: ply solid volume');
    expect(volume.map((finding) => [finding.subject, finding.band])).toEqual([
      ['P1', 'green'],
      ['P2', 'yellow'],
      ['P3', 'green'],
    ]);
    const far = importOf(createEmptyDocument(), { text: step }, { stepImport: treeOf(names, { ...PANEL_VOLUMES, 'P3 piece 1': 99999 }) });
    expect((far.data as Imported).validation.band).toBe('red');
    // without importSolids none of the solid checks applies
    const none = importOf(createEmptyDocument(), { text: step, importSolids: false });
    expect((none.data as Imported).validation.findings.some((finding) => finding.property.startsWith('structure: ply solid'))).toBe(false);
    expect((none.data as Imported).reviewRequired.reasons).toEqual(['composite_import_unverified']);
  });

  it('refuses imported composite data that the document would not accept: a lamina without E1, nu12 out of range, a surface without radius, an unknown rosette method', () => {
    const { step } = exported();
    const empty = createEmptyDocument();
    const damaged: [string, string][] = [
      ['missing E1', step.replace('"E1":', '"EX":')],
      ['nu12 out of range', step.replace(/"nu12":[0-9.]+/, '"nu12":7')],
      [
        'unknown rosette method',
        step.replace("DESCRIPTIVE_REPRESENTATION_ITEM('method','translational')", "DESCRIPTIVE_REPRESENTATION_ITEM('method','spin')"),
      ],
    ];
    let tube = apply(withMaterials(), 'create_lamina_material', WOVEN);
    tube = apply(tube, 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    const tool = ok(tube, 'add_cylinder', { radius: 50, height: 200, position: [0, 0, 0] });
    const part = ok(tool.document, 'create_composite_part', {
      name: 'Tube',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 0] },
    });
    tube = apply(part.document, 'add_ply', {
      part: 'Tube',
      name: 'T1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const tubeStep = exportOf(tube, { part: 'Tube' }).data.step;
    damaged.push(['surface without radius', tubeStep.replace('"radius":', '"radiux":')]);
    for (const [what, text] of damaged) {
      expect(text, what).not.toBe(step);
      const result = importOf(empty, { text, importSolids: false });
      expect(result.error?.code, what).toBe('CMP_AP242_MALFORMED');
      expectNoOp(result, empty);
    }
    const message = importOf(empty, { text: damaged[0]![1], importSolids: false }).summary;
    expect(message).toContain('composites.materials');
    expect(importOf(empty, { text: damaged[0]![1], importSolids: false }).error?.paths.length).toBeGreaterThan(0);
  });

  it('refuses an oversized base64 file before decoding it and a boundary with too many vertices', () => {
    const huge = importOf(createEmptyDocument(), { stepBase64: 'A'.repeat(90 * 1024 * 1024) });
    expect(huge.error?.code).toBe('CMP_PARAM_INVALID');
    const { step } = exported();
    const points = Array.from({ length: 50_001 }, () => '#1').join(',');
    const crowded = step.replace(/POLYLINE\('ply boundary 1',\([^)]*\)\)/, `POLYLINE('ply boundary 1',(${points}))`);
    expect(crowded).not.toBe(step);
    expect(importOf(createEmptyDocument(), { text: crowded, importSolids: false }).error?.code).toBe('CMP_AP242_MALFORMED');
  });

  it('reads a hostile file in linear time: a megabyte of digits in a point, a measure and a name, and a megabyte of # in a string', () => {
    const { step } = exported();
    const digits = '9'.repeat(1_000_000);
    const hostile: [string, string][] = [
      ['point', step.replace("CARTESIAN_POINT('',(", `CARTESIAN_POINT('',(${digits},`)],
      ['measure', step.replace("'thickness',LENGTH_MEASURE(0.25)", `'thickness',LENGTH_MEASURE(${digits})`)],
      [
        'integer',
        step.replace("INTEGER_REPRESENTATION_ITEM('number of plies',3.)", `INTEGER_REPRESENTATION_ITEM('number of plies',${digits})`),
      ],
      [
        'string',
        step.replace(
          "DESCRIPTIVE_REPRESENTATION_ITEM('sequence name','S2')",
          `DESCRIPTIVE_REPRESENTATION_ITEM('sequence name','${'#'.repeat(1_000_000)}')`,
        ),
      ],
      ['spaces', `${step}\n#9999999 ${' '.repeat(1_000_000)}=NEXT_ASSEMBLY_USAGE_OCCURRENCE(\n`],
    ];
    for (const [what, text] of hostile) {
      expect(text, what).not.toBe(step);
      const started = performance.now();
      const read = readComposite(text);
      withoutCompositeUsages(text);
      const elapsed = performance.now() - started;
      expect(elapsed, `${what}: ${elapsed} ms`).toBeLessThan(1000);
      expect(typeof read.ok).toBe('boolean');
    }
  });

  it('keeps a ply rosette other than the part rosette and an unknown ply rosette falls back to the part rosette', () => {
    const { doc } = panelDoc();
    const withSecond = apply(doc, 'define_rosette', {
      name: 'R90',
      origin: [0, 0, 0],
      axis0: [0, 1, 0],
      normal: [0, 0, 1],
      method: 'translational',
    });
    const { data } = exportOf(withSecond);
    const result = importOf(createEmptyDocument(), { text: data.step.replace("'rosette','R0'", "'rosette','R404'"), importSolids: false });
    expect(result.rejected).toBeUndefined();
    const rosettes = Object.values(modelOf(result.document).rosettes);
    expect(rosettes.map((rosette) => rosette.name)).toEqual(['R0']);
    expect(pliesOfPart(result.document, 'Panel').plies.every((ply) => ply.rosetteId === rosettes[0]?.id)).toBe(true);
  });
});
