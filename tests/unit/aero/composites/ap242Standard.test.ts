/** ap242Standard: composite AP242 export / import (06 CMP M5), split from the former ap242.test.ts. Fixtures in ap242Support.ts. */

import { describe, expect, it } from 'vitest';
import { readComposite } from '@aero/composites/ap242/reader';
import { readStandard, withoutCompositeUsages } from '@aero/composites/ap242/standardReader';
import { spherePatch } from './drapeFixtures';
import { apply, ok } from '../../../helpers/commandAssertions';
import { createEmptyDocument } from '@core/model/types';
import { WOVEN } from './drapeFixtures';
import type { CadDocument } from '@core/model/types';
import { withMaterials } from './fixtures';
import { exportOf, importOf, panelDoc, type Imported } from './ap242Support';

describe('the CAx-IF structure of the file', () => {
  const exportedText = (): string => exportOf(panelDoc().doc).data.step;

  it('writes the practice identification, the ply laminate table with ordered sequences, plies with material / angle / thickness and the practice validation property names', () => {
    const step = exportedText();
    expect(step).toContain("'CAx-IF Rec.Pracs.---Composite Materials---4.3---2025-10-02'");
    for (const entity of [
      'PLY_LAMINATE_TABLE(',
      'PLY_LAMINATE_SEQUENCE_DEFINITION(',
      'MAKE_FROM_USAGE_OPTION(',
      'NEXT_ASSEMBLY_USAGE_OCCURRENCE(',
      'REINFORCEMENT_ORIENTATION_BASIS(',
      'PLY_ORIENTATION_ANGLE(',
      'PLY_ANGLE_REPRESENTATION(',
      'CARTESIAN_11()',
      'ITEM_IDENTIFIED_REPRESENTATION_USAGE(',
      'ROW_REPRESENTATION_ITEM(',
      'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION(',
    ])
      expect(step, entity).toContain(entity);
    for (const category of ['part', 'ply_laminate', 'ply', 'woven_assembly', 'filament_assembly'])
      expect(step).toContain(`PRODUCT_RELATED_PRODUCT_CATEGORY('${category}'`);
    for (const name of [
      'number of tables',
      'number of sequences',
      'number of plies',
      'number of cores',
      'number of materials',
      'number of orientations',
      'number of rosettes',
      'total ply surface area',
      'ordered list of orientation values',
      'ordered sequences per laminate table',
      'curve length measure',
      'number of ply pieces per ply',
      'total boundary curve length',
    ])
      expect(step, name).toContain(`'${name}'`);
    expect(step).toMatch(/INTEGER_REPRESENTATION_ITEM\('number of plies',3\.\)/);
    expect(step).toContain("'ordered list of orientation values','-45 0 45'");
    const std = readComposite(step);
    if (!std.ok) throw new Error(std.reason);
    expect(std.standard.present).toBe(true);
    expect(std.standard.recPracId).toBe(true);
    expect(std.standard.table).toBe('Panel');
    expect(std.standard.sequences.map((sequence) => [sequence.name, sequence.plies])).toEqual([
      ['S1', ['P1']],
      ['S2', ['P2']],
      ['S3', ['P3']],
    ]);
    expect(std.standard.plies.map((ply) => [ply.name, ply.material, ply.rosette, ply.angle, ply.thickness, ply.pieces])).toEqual([
      ['P1', 'Woven', 'R0', 0, 0.25, ['P1 piece 1']],
      ['P2', 'AS4_3501_6', 'R0', 45, 0.125, ['P2 piece 1']],
      ['P3', 'Woven', 'R0', -45, 0.25, ['P3 piece 1']],
    ]);
    expect(std.standard.rosettes).toEqual(['R0']);
  });

  it('flags a changed number of plies, a changed ply angle and a changed sequence name red, and a removed property not checkable', () => {
    const step = exportedText();
    const bandOf = (text: string, property: string): string | undefined => {
      const bands = (importOf(createEmptyDocument(), { text, importSolids: false }).data as Imported).validation.findings
        .filter((finding) => finding.property === property)
        .map((finding) => finding.band);
      return bands.includes('red') ? 'red' : bands.includes('not_checkable') ? 'not_checkable' : bands[0];
    };
    const tamper = (from: string | RegExp, to: string): string => {
      const text = step.replace(from, to);
      expect(text).not.toBe(step);
      return text;
    };
    expect(
      bandOf(
        tamper("INTEGER_REPRESENTATION_ITEM('number of plies',3.)", "INTEGER_REPRESENTATION_ITEM('number of plies',4.)"),
        'number of plies',
      ),
    ).toBe('red');
    expect(
      bandOf(
        tamper(
          /MEASURE_REPRESENTATION_ITEM\('orientation',PLANE_ANGLE_MEASURE\(45\.\)/,
          "MEASURE_REPRESENTATION_ITEM('orientation',PLANE_ANGLE_MEASURE(40.)",
        ),
        'structure: ply orientation angle',
      ),
    ).toBe('red');
    expect(
      bandOf(
        tamper("DESCRIPTIVE_REPRESENTATION_ITEM('sequence name','S2')", "DESCRIPTIVE_REPRESENTATION_ITEM('sequence name','SX')"),
        'ordered sequences per laminate table',
      ),
    ).toBe('red');
    expect(
      bandOf(
        tamper("'ordered list of orientation values','-45 0 45'", "'ordered list of orientation values','-45 0 46'"),
        'ordered list of orientation values',
      ),
    ).toBe('red');
    expect(bandOf(tamper("'total ply surface area'", "'total ply surface areas'"), 'total ply surface area')).toBe('not_checkable');
    expect(bandOf(step, 'structure: ply material')).toBe('green');
  });

  it('reads files of the first encoding (no CAx-IF structure) and answers no structure for text without a table', () => {
    const step = exportedText();
    const legacy = step
      .replace('llull-composite-2', 'llull-composite-1')
      .replaceAll("'llull composite validation'", "'composite validation property'");
    const read = readComposite(legacy);
    expect(read.ok && read.embedded.plyCount).toBe(3);
    const stripped = legacy
      .split('\n')
      .filter((line) => !/PLY_LAMINATE|REINFORCEMENT_ORIENTATION|PLY_ORIENTATION_ANGLE|PLY_ANGLE_REP/.test(line))
      .join('\n');
    expect(readStandard(stripped).present).toBe(false);
    expect(readStandard('not a step file').present).toBe(false);
    const result = importOf(createEmptyDocument(), { text: stripped, importSolids: false });
    expect(result.rejected).toBeUndefined();
    expect((result.data as Imported).validation.band).toBe('green');
    expect(withoutCompositeUsages("ISO-10303-21;\nDATA;\n#1=PRODUCT('a','a','',());\nENDSEC;\n")).toContain('PRODUCT');
    expect(withoutCompositeUsages(step)).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  });

  it('writes the base surface of plane, cylinder, cone and sphere tools and none for a NURBS sheet; a radial rosette is a polar_11', () => {
    const surfaceOf = (doc: CadDocument, part: string): string => exportOf(doc, { part }).data.step;
    const panel = surfaceOf(panelDoc().doc, 'Panel');
    expect(panel).toMatch(/PLANE\('base_surface'/);
    expect(panel).toContain("DIRECTION('material side'");

    let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
    doc = apply(doc, 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    const tube = ok(doc, 'add_cylinder', { radius: 50, height: 200, position: [0, 0, 0] });
    const withTube = ok(tube.document, 'create_composite_part', {
      name: 'Tube',
      rosette: 'Rax',
      toolSurface: { entityId: tube.affected[0], faceNear: [50, 0, 0] },
    });
    doc = apply(withTube.document, 'add_ply', {
      part: 'Tube',
      name: 'T1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    expect(surfaceOf(doc, 'Tube')).toMatch(/CYLINDRICAL_SURFACE\('base_surface'/);

    const cone = ok(doc, 'add_cone', { radius: 100, height: 100, position: [0, 0, 0] });
    const withCone = ok(cone.document, 'create_composite_part', {
      name: 'Funnel',
      rosette: 'Rax',
      toolSurface: { entityId: cone.affected[0], faceNear: [50, 0, 50] },
    });
    doc = apply(withCone.document, 'add_ply', {
      part: 'Funnel',
      name: 'F1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    expect(surfaceOf(doc, 'Funnel')).toMatch(/CONICAL_SURFACE\('base_surface'/);

    let dome = apply(withMaterials(), 'create_lamina_material', WOVEN);
    dome = apply(dome, 'define_rosette', { name: 'R0', origin: [0, 0, 0], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'radial' });
    const ball = ok(dome, 'add_sphere', { radius: 100, position: [0, 0, 0] });
    const withBall = ok(ball.document, 'create_composite_part', {
      name: 'Dome',
      rosette: 'R0',
      toolSurface: { entityId: ball.affected[0], faceNear: [0, 0, 100] },
    });
    dome = apply(withBall.document, 'add_ply', {
      part: 'Dome',
      name: 'D1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const domeText = surfaceOf(dome, 'Dome');
    expect(domeText).toMatch(/SPHERICAL_SURFACE\('base_surface'/);
    expect(domeText).toContain('POLAR_11()');

    let sheet = apply(withMaterials(), 'create_lamina_material', WOVEN);
    sheet = apply(sheet, 'define_rosette', { name: 'R0', origin: [0, 0, 0], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'translational' });
    const patch = ok(sheet, 'create_nurbs_surface', spherePatch(100, 30, 90));
    const near = [100 * Math.sin(Math.PI / 3) * Math.SQRT1_2, 100 * Math.sin(Math.PI / 3) * Math.SQRT1_2, 50];
    const onPatch = ok(patch.document, 'create_composite_part', {
      name: 'Skin',
      rosette: 'R0',
      toolSurface: { entityId: patch.affected[0], faceNear: near },
    });
    sheet = apply(onPatch.document, 'add_ply', {
      part: 'Skin',
      name: 'K1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const nurbsText = surfaceOf(sheet, 'Skin');
    expect(nurbsText).not.toContain("'base_surface'");
    expect(nurbsText).toContain('PLY_LAMINATE_TABLE(');
  });
});
