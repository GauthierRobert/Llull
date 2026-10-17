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

  it('exports component instances as their placed solids, named <instance>/<part>', () => {
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
    expect(data.step.match(/PRODUCT\('[^']*\/Bolt'/g)).toHaveLength(2);
    // the second instance sits 50 mm along x: its corner coordinates appear in the exact B-rep
    expect(data.step).toMatch(/CARTESIAN_POINT\('',\(5[45]\.\d*E?\+?\d*,/);
  }, 120_000);
});
