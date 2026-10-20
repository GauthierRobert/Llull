/**
 * The composite records of export_composite_ap242 against the AP242 ed4 MIM long form (ISO/TS 10303-442, EXPRESS file published by ISO / the CAx-IF; not
 * stored in the repo): set LLULL_AP242_MIM to the path of `mim_lf.exp` to run it. Checks entity names, attribute counts, OPTIONAL attributes and the
 * entity types of references, for EVERY record of the exported text (the writer's own records included, which also tests the checker). WHERE rules,
 * UNIQUE rules, derived / redeclared attributes and literal ranges are not evaluated (tests/helpers/expressSchema.ts).
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { parseRecords } from '@lib/step21/records';
import { type ExpressSchema, checkRecords, loadSchema } from '../../../helpers/expressSchema';
import { apply, ok } from '../../../helpers/commandAssertions';
import { ctxOf, panelDoc } from './ap242Support';
import { WOVEN } from './drapeFixtures';
import { ROSETTE, withMaterials } from './fixtures';
import type { CadDocument } from '@core/model/types';

const path = process.env['LLULL_AP242_MIM'];
const available = path !== undefined && path !== '' && existsSync(path);

/** The exported text and the ids of the records the composite writer appended (the last `records` ones: the writer's own base text is renumbered densely). */
const exportText = (doc: CadDocument, part: string): { text: string; appended: number[] } => {
  const result = execute(doc, 'export_composite_ap242', { part, acceptUnverified: { nonce: 'composites' } }, ctxOf().ctx);
  expect(result.rejected, result.summary).toBeUndefined();
  const data = result.data as { step: string; records: number };
  const last = Math.max(...parseRecords(data.step).bodies.keys());
  return { text: data.step, appended: Array.from({ length: data.records }, (_, k) => last - k) };
};

function cylinderDoc(): CadDocument {
  let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
  const tool = ok(doc, 'add_cylinder', { radius: 50, height: 200, position: [0, 0, 0] });
  doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: 'Tube tool' });
  doc = apply(doc, 'define_rosette', {
    name: 'Rax',
    origin: [0, 0, 0],
    axis0: [0, 0, 1],
    normal: [1, 0, 0],
    method: 'cylindrical',
    axis: [0, 0, 1],
  });
  const part = ok(doc, 'create_composite_part', {
    name: 'Tube',
    rosette: 'Rax',
    toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 0] },
  });
  doc = apply(part.document, 'add_ply', {
    part: 'Tube',
    name: 'T1',
    material: WOVEN.name,
    orientation: 0,
    boundary: { kind: 'whole_face' },
  });
  return apply(doc, 'add_ply', { part: 'Tube', name: 'T2', material: WOVEN.name, orientation: 90, boundary: { kind: 'whole_face' } });
}

function coneDoc(): CadDocument {
  let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
  const tool = ok(doc, 'add_cone', { radius: 100, height: 100, position: [0, 0, 0] });
  doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: 'Funnel tool' });
  doc = apply(doc, 'define_rosette', { name: 'Rax', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0], method: 'radial' });
  const part = ok(doc, 'create_composite_part', {
    name: 'Funnel',
    rosette: 'Rax',
    toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 50] },
  });
  return apply(part.document, 'add_ply', {
    part: 'Funnel',
    name: 'F1',
    material: WOVEN.name,
    orientation: 0,
    boundary: { kind: 'whole_face' },
  });
}

function sphereDoc(): CadDocument {
  let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
  const tool = ok(doc, 'add_sphere', { radius: 100, position: [0, 0, 0] });
  doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: 'Dome tool' });
  doc = apply(doc, 'define_rosette', { ...ROSETTE, name: 'Rad', method: 'radial' });
  const part = ok(doc, 'create_composite_part', {
    name: 'Dome',
    rosette: 'Rad',
    toolSurface: { entityId: tool.affected[0], faceNear: [0, 0, 100] },
  });
  return apply(part.document, 'add_ply', {
    part: 'Dome',
    name: 'D1',
    material: WOVEN.name,
    orientation: 30,
    boundary: { kind: 'whole_face' },
  });
}

describe.skipIf(!available)('composite records against the AP242 ed4 MIM long form', () => {
  const schema = (): ExpressSchema => loadSchema(path as string);
  const texts = (): [string, ReturnType<typeof exportText>][] => [
    ['panel (plane, exact ply solids as triangles in the fake kernel)', exportText(panelDoc().doc, 'Panel')],
    ['tube (cylinder, cylindrical rosette)', exportText(cylinderDoc(), 'Tube')],
    ['funnel (cone, radial rosette)', exportText(coneDoc(), 'Funnel')],
    ['dome (sphere, radial rosette)', exportText(sphereDoc(), 'Dome')],
  ];

  it('every record has a known entity, the schema attribute count, $ only on OPTIONAL attributes and references of the declared entity type', () => {
    const loaded = schema();
    for (const [label, { text, appended }] of texts()) {
      const { bodies } = parseRecords(text);
      const { checked, violations } = checkRecords(loaded, bodies, appended);
      expect(checked, label).toBeGreaterThan(100);
      expect(violations.slice(0, 10), label).toEqual([]);
    }
  });

  it('the checker rejects a record with a missing argument, a $ on a mandatory attribute and a reference of the wrong entity type', () => {
    const loaded = schema();
    const { text } = exportText(panelDoc().doc, 'Panel');
    const { bodies } = parseRecords(text);
    const table = [...bodies].find(([, body]) => body.startsWith('PLY_LAMINATE_TABLE('));
    const orientation = [...bodies].find(([, body]) => body.startsWith('PLY_ORIENTATION_ANGLE('));
    expect(table).toBeDefined();
    expect(orientation).toBeDefined();
    const tableId = (table as [number, string])[0];
    const orientationId = (orientation as [number, string])[0];
    const broken = new Map(bodies);
    broken.set(tableId, (table as [number, string])[1].replace(/,#\d+\)$/, ')'));
    expect(checkRecords(loaded, broken, [tableId]).violations[0]?.message).toContain('arguments');
    broken.set(tableId, (table as [number, string])[1].replace(/^PLY_LAMINATE_TABLE\('[^']*'/, 'PLY_LAMINATE_TABLE($'));
    expect(checkRecords(loaded, broken, [tableId]).violations[0]?.message).toContain('not OPTIONAL');
    broken.set(orientationId, (orientation as [number, string])[1].replace(/#\d+,#(\d+)\)$/, `#${tableId},#$1)`));
    expect(checkRecords(loaded, broken, [orientationId]).violations.some((violation) => violation.message.includes('refers to'))).toBe(
      true,
    );
  });
});
