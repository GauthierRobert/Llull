/**
 * Live OpenCascade: export_step_exact stamps entity names, group names and colors on the STEP the
 * kernel writes (the product names and solid ids the kernel would otherwise number itself).
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { liveKernels } from './kernelTestSupport';

const kernels = liveKernels();

/** x translation of the occurrence named `name`: NAUO -> placement shape -> context-dependent representation -> item transformation. */
function placementX(step: string, name: string): number {
  const flat = step.replace(/\n/g, ' ');
  const nauo = new RegExp(`#(\\d+) = NEXT_ASSEMBLY_USAGE_OCCURRENCE\\('${name}'`).exec(flat)?.[1];
  const shape = new RegExp(`#(\\d+) = PRODUCT_DEFINITION_SHAPE\\('Placement','Placement of an item',#${nauo}\\s*\\)`).exec(flat)?.[1];
  const relation = new RegExp(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION\\(#(\\d+),#${shape}\\)`).exec(flat)?.[1];
  const transformation = new RegExp(`#${relation} = [^;]*?WITH_TRANSFORMATION\\(#(\\d+)\\)`).exec(flat)?.[1];
  const transform = new RegExp(`#${transformation} = ITEM_DEFINED_TRANSFORMATION\\('','',#\\d+,#(\\d+)\\)`).exec(flat)?.[1];
  const axis = new RegExp(`#${transform} = AXIS2_PLACEMENT_3D\\('',#(\\d+),`).exec(flat)?.[1];
  const x = new RegExp(`#${axis} = CARTESIAN_POINT\\('',\\(([-\\d.E+]+),`).exec(flat)?.[1];
  return Number(x);
}

describe('occt export_step_exact labels', () => {
  it('names products after entities and styles them with the entity color', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [10, 10, 10], color: '#ff0000' }).document;
    doc = execute(doc, 'add_cylinder', { radius: 3, height: 12, color: '#0000ff' }).document;
    const [box, cylinder] = doc.order;
    doc = execute(doc, 'set_entity_name', { id: box, name: 'Bearing 1' }).document;
    doc = execute(doc, 'group_entities', { ids: [box, cylinder], name: 'Pump' }).document;

    const ctx = { ...defaultContext(), kernel: kernels.occt };
    const result = execute(doc, 'export_step_exact', {}, ctx);
    const step = (result.data as { step: string }).step;

    expect(step).toContain("PRODUCT('Bearing 1','Bearing 1','Pump'");
    expect(step).toContain(`PRODUCT('${cylinder}','${cylinder}','Pump'`);
    expect(step).not.toContain('Open CASCADE STEP translator');
    expect(step).toContain("MANIFOLD_SOLID_BREP('Bearing 1'");
    expect(step).toContain("COLOUR_RGB('',1.000,0.000,0.000)");
    expect(step).toContain("COLOUR_RGB('',0.000,0.000,1.000)");
    expect(step.match(/STYLED_ITEM\('color'/g)).toHaveLength(2);
    expect(step.indexOf('MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION')).toBeLessThan(step.lastIndexOf('ENDSEC;'));
  }, 120_000);

  it('exports component instances as one shared product placed once per instance', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
    const box = doc.order[0] ?? '';
    doc = execute(doc, 'set_entity_name', { id: box, name: 'Bolt' }).document;
    const created = execute(doc, 'create_component', { name: 'Bolt', entityIds: [box] });
    const componentId = Object.keys(created.document.components)[0] ?? '';
    const second = execute(created.document, 'insert_instance', { componentId, position: [50, 0, 0] });
    const ctx = { ...defaultContext(), kernel: kernels.occt };
    const result = execute(second.document, 'export_step_exact', {}, ctx);
    const data = result.data as { step: string; solidCount: number; skipped: string[] };
    expect(data.solidCount).toBe(2);
    expect(data.skipped).toEqual([]);
    // one shared 'Bolt' product, placed twice; the second occurrence sits 50 mm along x
    expect(data.step.match(/PRODUCT\('Bolt','Bolt'/g)).toHaveLength(1);
    expect(data.step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('Bolt [12]'/g)).toHaveLength(2);
    expect(data.step).toMatch(/CARTESIAN_POINT\('',\(50\.,0\.,0\.\)\)/);
  }, 120_000);

  it('writes components as shared products with one placed occurrence per instance (NAUO), and re-imports', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [10, 10, 10], color: '#ff0000' }).document;
    doc = execute(doc, 'add_cylinder', { radius: 2, height: 30, color: '#0000ff' }).document;
    const [box, rod] = doc.order;
    doc = execute(doc, 'add_box', { size: [5, 5, 5] }).document;
    const loose = doc.order[2] ?? '';
    doc = execute(doc, 'set_entity_name', { id: loose, name: 'Base plate' }).document;
    doc = execute(doc, 'set_entity_name', { id: box, name: 'Head' }).document;
    doc = execute(doc, 'set_entity_name', { id: rod, name: 'Shank' }).document;
    const created = execute(doc, 'create_component', { name: 'Tie rod', entityIds: [box, rod] });
    doc = created.document;
    const componentId = Object.keys(doc.components)[0] ?? '';
    for (let k = 0; k < 4; k += 1) {
      doc = execute(doc, 'insert_instance', { componentId, position: [k * 40, 0, 0], name: 'Tie rod M10' }).document;
    }
    const ctx = { ...defaultContext(), kernel: kernels.occt };
    const result = execute(doc, 'export_step_exact', {}, ctx);
    const data = result.data as { step: string; solidCount: number; assembly?: { products: number; occurrences: number } };

    expect(data.assembly).toEqual({ products: 2, occurrences: 6 });
    expect(data.solidCount).toBe(11);
    expect(result.summary).toContain('assembly, 2 product(s), 6 occurrence(s)');
    const step = data.step;
    expect(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toHaveLength(8); // 6 placed + the 2 solids inside 'Tie rod'
    for (const name of ['Tie rod 1', 'Tie rod 2', 'Tie rod 3', 'Tie rod 4', 'Tie rod 5', 'Base plate', 'Head', 'Shank'])
      expect(step).toContain(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${name}'`);
    // each occurrence carries its own placement, in input order
    expect([2, 3, 4, 5].map((k) => placementX(step, `Tie rod ${k}`))).toEqual([0, 40, 80, 120]);
    // root + 'Tie rod' written once (5 uses) + its 2 solids + 'Base plate'
    expect(step.match(/PRODUCT\('/g)).toHaveLength(5);
    expect(step).toContain("PRODUCT('Tie rod','Tie rod'");
    expect(step).toContain("PRODUCT('Assembly','Assembly'");
    expect(step).toContain("PRODUCT('Head','Head'");
    expect(step).toContain("MANIFOLD_SOLID_BREP('Shank'");
    expect(step.match(/MANIFOLD_SOLID_BREP\(/g)).toHaveLength(3);
    expect(step).toContain("COLOUR_RGB('',1.000,0.000,0.000)");
    expect(step).not.toContain('Open CASCADE STEP translator');

    const imported = execute(createEmptyDocument(), 'import_step_exact', { text: step }, ctx);
    expect(imported.summary).not.toContain('rejected');
    expect(imported.affected.length).toBeGreaterThan(0);
  }, 120_000);

  it('keeps the flat list when no instance is exported', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
    const result = execute(doc, 'export_step_exact', {}, { ...defaultContext(), kernel: kernels.occt });
    expect((result.data as { assembly?: unknown }).assembly).toBeUndefined();
    expect((result.data as { step: string }).step).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  }, 120_000);
});
