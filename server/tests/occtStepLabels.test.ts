/**
 * Live OpenCascade: export_step_ap242 stamps entity names, group names and colors on the STEP the
 * kernel writes (the product names and solid ids the kernel would otherwise number itself).
 */

import { it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { liveKernels, describeNative } from './kernelTestSupport';

const kernels = liveKernels();

/** x translation of the occurrence named `name`: NAUO -> placement shape -> context-dependent representation -> item transformation. */
function placementX(step: string, name: string): number {
  const flat = step.replace(/\n/g, ' ');
  const nauo = new RegExp(`#(\\d+) = NEXT_ASSEMBLY_USAGE_OCCURRENCE\\('\\d+','${name}'`).exec(flat)?.[1];
  const shape = new RegExp(`#(\\d+) = PRODUCT_DEFINITION_SHAPE\\('Placement','Placement of an item',#${nauo}\\s*\\)`).exec(flat)?.[1];
  const relation = new RegExp(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION\\(#(\\d+),#${shape}\\)`).exec(flat)?.[1];
  const transformation = new RegExp(`#${relation} = [^;]*?WITH_TRANSFORMATION\\(#(\\d+)\\)`).exec(flat)?.[1];
  const transform = new RegExp(`#${transformation} = ITEM_DEFINED_TRANSFORMATION\\('','',#\\d+,#(\\d+)\\)`).exec(flat)?.[1];
  const axis = new RegExp(`#${transform} = AXIS2_PLACEMENT_3D\\('',#(\\d+),`).exec(flat)?.[1];
  const x = new RegExp(`#${axis} = CARTESIAN_POINT\\('',\\(([-\\d.E+]+),`).exec(flat)?.[1];
  return Number(x);
}

describeNative('occt export_step_ap242 labels', () => {
  it('names products after entities and styles them with the entity color', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [10, 10, 10], color: '#ff0000' }).document;
    doc = execute(doc, 'add_cylinder', { radius: 3, height: 12, color: '#0000ff' }).document;
    const [box, cylinder] = doc.order;
    doc = execute(doc, 'set_entity_name', { id: box, name: 'Bearing 1' }).document;
    doc = execute(doc, 'group_entities', { ids: [box, cylinder], name: 'Pump' }).document;

    const ctx = { ...defaultContext(), kernel: kernels.occt };
    const result = execute(doc, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false }, ctx);
    const step = (result.data as { step: string }).step;

    expect(step).toContain("PRODUCT('Bearing 1','Bearing 1','Pump'");
    expect(step).toContain(`PRODUCT('${cylinder}','${cylinder}','Pump'`);
    expect(step).not.toContain('Open CASCADE STEP translator');
    // the XDE writer names pure red / blue as predefined STEP colours (any other colour is a COLOUR_RGB)
    expect(step).toContain("DRAUGHTING_PRE_DEFINED_COLOUR('red')");
    expect(step).toContain("DRAUGHTING_PRE_DEFINED_COLOUR('blue')");
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
    const result = execute(second.document, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false }, ctx);
    const data = result.data as { step: string; solidCount: number; skipped: string[] };
    expect(data.solidCount).toBe(2);
    expect(data.skipped).toEqual([]);
    // one shared 'Bolt' product, placed twice; the second occurrence sits 50 mm along x
    expect(data.step.match(/PRODUCT\('Bolt','Bolt'/g)).toHaveLength(1);
    expect(data.step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d+','Bolt [12]'/g)).toHaveLength(2);
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
      doc = execute(doc, 'insert_instance', { componentId, position: [k * 40, 0, 0] }).document;
    }
    const ctx = { ...defaultContext(), kernel: kernels.occt };
    const result = execute(doc, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false }, ctx);
    const data = result.data as { step: string; solidCount: number; assembly?: { products: number; occurrences: number } };

    expect(data.assembly).toEqual({ products: 2, occurrences: 6 });
    expect(data.solidCount).toBe(11);
    expect(result.summary).toContain('2 product(s), 6 occurrence(s)');
    const step = data.step;
    // the 6 placed uses; the two solids of 'Tie rod' are solids of one product (named sub-shapes), not occurrences
    expect(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toHaveLength(6);
    for (const name of ['Tie rod 1', 'Tie rod 2', 'Tie rod 3', 'Tie rod 4', 'Tie rod 5', 'Base plate'])
      expect(step).toMatch(new RegExp(`NEXT_ASSEMBLY_USAGE_OCCURRENCE\\('\\d+','${name}'`));
    // each occurrence carries its own placement, in input order
    expect([2, 3, 4, 5].map((k) => placementX(step, `Tie rod ${k}`))).toEqual([0, 40, 80, 120]);
    // root + 'Tie rod' written once (5 uses) + 'Base plate'
    expect(step.match(/PRODUCT\('/g)).toHaveLength(3);
    expect(step).toContain("PRODUCT('Tie rod','Tie rod'");
    expect(step).toContain("PRODUCT('Assembly','Assembly'");
    expect(step).toContain("MANIFOLD_SOLID_BREP('Shank'");
    expect(step.match(/MANIFOLD_SOLID_BREP\(/g)).toHaveLength(3);
    expect(step).toContain("DRAUGHTING_PRE_DEFINED_COLOUR('red')");
    expect(step).not.toContain('Open CASCADE STEP translator');

    const imported = execute(createEmptyDocument(), 'import_step_exact', { text: step }, ctx);
    expect(imported.summary).not.toContain('rejected');
    expect(imported.affected.length).toBeGreaterThan(0);
  }, 120_000);

  it('writes a nested sub-assembly once with composed locations and re-imports the same solids', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 4] }).document;
    doc = execute(doc, 'add_cylinder', { radius: 2, height: 20, position: [0, 0, -12] }).document;
    const [head, shank] = doc.order;
    doc = execute(doc, 'set_entity_name', { id: head ?? '', name: 'Head' }).document;
    doc = execute(doc, 'set_entity_name', { id: shank ?? '', name: 'Shank' }).document;
    doc = execute(doc, 'create_component', { name: 'Bolt', entityIds: [head ?? '', shank ?? ''] }).document;
    const bolt = Object.keys(doc.components)[0] ?? '';
    const firstBolt = doc.order.find((id) => doc.entities[id]?.kind === 'instance') ?? '';
    const secondBolt = execute(doc, 'insert_instance', { componentId: bolt, position: [30, 0, 0] });
    doc = execute(secondBolt.document, 'create_component', { name: 'Pair', entityIds: [firstBolt, ...secondBolt.affected] }).document;
    const pair = Object.keys(doc.components).find((id) => id !== bolt) ?? '';
    doc = execute(doc, 'insert_instance', { componentId: pair, position: [0, 60, 0], rotation: [0.4, 0.5, 0.6458] }).document;
    doc = execute(doc, 'insert_instance', { componentId: pair, position: [0, 120, 0] }).document;

    const ctx = { ...defaultContext(), kernel: kernels.occt };
    const exported = execute(doc, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false }, ctx);
    const step = (exported.data as { step: string }).step;
    expect(exported.data).toMatchObject({ assembly: { products: 2, occurrences: 3 } });
    // 3 uses of Pair + 2 uses of Bolt inside Pair (the 2 solids of Bolt are solids of its product)
    expect(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toHaveLength(5);
    expect(step.match(/PRODUCT\('Bolt'/g)).toHaveLength(1);
    expect(step.match(/PRODUCT\('Pair'/g)).toHaveLength(1);
    expect(step.match(/MANIFOLD_SOLID_BREP\(/g)).toHaveLength(2);
    for (const name of ['Pair 1', 'Pair 2', 'Pair 3', 'Bolt 1', 'Bolt 2'])
      expect(step).toMatch(new RegExp(`NEXT_ASSEMBLY_USAGE_OCCURRENCE\\('\\d+','${name}'`));

    const imported = execute(createEmptyDocument(), 'import_step_exact', { text: step }, ctx);
    // the file's root assembly comes back as one component with one top-level instance holding the 12 solids
    expect(imported.affected).toHaveLength(1);
    const volume = (document: typeof doc, id: string): number => {
      const measured = execute(document, 'mass_properties', { entityId: id }, ctx).data as { volume: number };
      return measured.volume;
    };
    const original = doc.order.filter((id) => doc.entities[id]?.kind === 'instance').reduce((sum, id) => sum + volume(doc, id), 0);
    const reimported = imported.affected.reduce((sum, id) => sum + volume(imported.document, id), 0);
    expect(Math.abs(reimported - original)).toBeLessThan(original * 1e-4);
  }, 180_000);

  it('keeps the flat list when no instance is exported', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
    const result = execute(
      doc,
      'export_step_ap242',
      { schema: 'ap214', includeValidationProperties: false },
      { ...defaultContext(), kernel: kernels.occt },
    );
    expect((result.data as { assembly?: unknown }).assembly).toBeUndefined();
    expect((result.data as { step: string }).step).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  }, 120_000);
});
