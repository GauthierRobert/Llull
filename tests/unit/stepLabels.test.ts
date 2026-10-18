import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { labelStep, stepString } from '@core/commands/brep/stepLabels';
import { fakeKernel } from '../helpers/fakeKernel';
import { withMonotonicStepCounter } from '@core/model/stepCounter';

/** The shape of the kernel's STEP output: one product + one B-rep representation per solid. */
const KERNEL_STEP = `ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1 = APPLICATION_PROTOCOL_DEFINITION('international standard',
  'automotive_design',2000,#2);
#2 = APPLICATION_CONTEXT(
  'core data for automotive mechanical design processes');
#3 = SHAPE_DEFINITION_REPRESENTATION(#4,#10);
#7 = PRODUCT('Open CASCADE STEP translator 7.4 1',
  'Open CASCADE STEP translator 7.4 1','',(#8));
#10 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,#15),#345);
#11 = AXIS2_PLACEMENT_3D('',#12,#13,#14);
#15 = MANIFOLD_SOLID_BREP('',#16);
#345 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) );
#355 = PRODUCT('Open CASCADE STEP translator 7.4 2',
  'Open CASCADE STEP translator 7.4 2','',(#356));
#358 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,#359),#689);
#359 = MANIFOLD_SOLID_BREP('',#360);
#689 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) );
ENDSEC;
END-ISO-10303-21;
`;

describe('labelStep', () => {
  const labeled = labelStep(KERNEL_STEP, [
    { name: 'Bearing 1', description: 'Bearing group', color: '#ff0000' },
    { name: "Shaft's", color: '#ff0000' },
  ]);
  it('renames each product (id, name, description) in transfer order', () => {
    expect(labeled).toContain("PRODUCT('Bearing 1','Bearing 1','Bearing group',(#8))");
    expect(labeled).toContain("PRODUCT('Shaft''s','Shaft''s','',(#356))");
    expect(labeled).not.toContain('Open CASCADE STEP translator 7.4');
  });
  it('labels a later export of the same process, whose translator numbering does not restart at 1', () => {
    const later = KERNEL_STEP.replace(/translator 7\.4 1/g, 'translator 7.4 3').replace(/translator 7\.4 2/g, 'translator 7.4 4');
    const relabeled = labelStep(later, [{ name: 'Bearing 1' }, { name: 'Shaft' }]);
    expect(relabeled).toContain("PRODUCT('Bearing 1','Bearing 1','',(#8))");
    expect(relabeled).toContain("PRODUCT('Shaft','Shaft','',(#356))");
    expect(relabeled).not.toContain('Open CASCADE STEP translator 7.4');
  });
  it('names the solids, not the placement axis', () => {
    for (const s of [
      "#15 = MANIFOLD_SOLID_BREP('Bearing 1',#16);",
      "#359 = MANIFOLD_SOLID_BREP('Shaft''s',#360);",
      "#11 = AXIS2_PLACEMENT_3D('',#12,#13,#14);",
    ])
      expect(labeled).toContain(s);
  });
  it('styles every solid with one shared color chain per distinct color', () => {
    expect(labeled.match(/COLOUR_RGB\('',1\.000,0\.000,0\.000\)/g)).toHaveLength(1);
    expect(labeled.match(/STYLED_ITEM\('color',\(#\d+\),#(15|359)\)/g)).toHaveLength(2);
    expect(labeled).toMatch(/MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION\('',\(#\d+,#\d+\),#345\)/);
    const ids = [...labeled.matchAll(/^#(\d+) = /gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(labeled.indexOf('STYLED_ITEM')).toBeLessThan(labeled.lastIndexOf('ENDSEC;'));
  });
  it('adds a chain per distinct color', () => {
    const two = labelStep(KERNEL_STEP, [
      { name: 'a', color: '#00ff00' },
      { name: 'b', color: '#0000ff' },
    ]);
    expect(two.match(/COLOUR_RGB/g)).toHaveLength(2);
  });
  it('keeps names but skips colors for a missing or malformed color', () => {
    const plain = labelStep(KERNEL_STEP, [{ name: 'a' }, { name: 'b', color: 'red' }]);
    expect(plain).toContain("PRODUCT('b','b','',(#356))");
    expect(plain).not.toContain('STYLED_ITEM');
  });
  it('only renames products when the solid count does not match the labels', () => {
    const mismatch = labelStep(KERNEL_STEP, [{ name: 'only', color: '#ff0000' }]);
    expect(mismatch).toContain("PRODUCT('only','only','',(#8))");
    expect(mismatch).toContain('Open CASCADE STEP translator 7.4 2');
    expect(mismatch).not.toContain('STYLED_ITEM');
  });
  it('returns text that is not kernel STEP unchanged', () => {
    expect(labelStep('ISO-10303-21;', [{ name: 'a', color: '#ff0000' }])).toBe('ISO-10303-21;');
  });
});

describe('stepString', () => {
  it('escapes quotes, backslashes and non-ASCII, and drops control characters', () => {
    expect(stepString("a'b\\c")).toBe("a''b\\\\c");
    expect(stepString('Lager é')).toBe('Lager \\X2\\00E9\\X0\\');
    expect(stepString('x\ny')).toBe('x y');
  });
});

describe('export_step_exact labels', () => {
  it('stamps entity names, group names and colors on the kernel STEP', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1], color: '#ff0000' }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2], color: '#0000ff' }).document;
    const [first, second] = doc.order;
    doc = execute(doc, 'set_entity_name', { id: first, name: 'Housing' }).document;
    doc = execute(doc, 'group_entities', { ids: [first, second], name: 'Pump' }).document;
    const ctx = { ...defaultContext(), kernel: fakeKernel({ step: KERNEL_STEP }) };
    const step = (execute(doc, 'export_step_exact', {}, ctx).data as { step: string }).step;
    expect(step).toContain("PRODUCT('Housing','Housing','Pump',(#8))");
    expect(step).toContain(`PRODUCT('${second}','${second}','Pump',(#356))`);
    expect(step.match(/COLOUR_RGB/g)).toHaveLength(2);
  });
});

describe('export_step_exact instance labels', () => {
  it('names instance solids after the component names, never internal ids', () => {
    let doc = createEmptyDocument();
    for (const name of ['M6 bolt', 'Plate']) {
      const box = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = execute(box.document, 'create_component', { name, entityIds: box.affected }).document;
    }
    const ctx = { ...defaultContext(), kernel: fakeKernel({ step: KERNEL_STEP }) };
    const step = (execute(doc, 'export_step_exact', {}, ctx).data as { step: string }).step;
    expect(step).toContain("PRODUCT('M6 bolt/M6 bolt','M6 bolt/M6 bolt'");
    expect(step).toContain("PRODUCT('Plate/Plate','Plate/Plate'");
    expect(step).not.toContain('expanded::');
    expect(step).not.toContain('instance-');
  });

  it('gives instances of one component distinct product names', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    let doc = execute(box.document, 'create_component', { name: 'Tie rod M10', entityIds: box.affected }).document;
    const componentId = Object.keys(doc.components)[0]!;
    doc = execute(doc, 'insert_instance', { componentId, position: [5, 0, 0] }).document;
    const ctx = { ...defaultContext(), kernel: fakeKernel({ step: KERNEL_STEP }) };
    const step = (execute(doc, 'export_step_exact', {}, ctx).data as { step: string }).step;
    expect(step).toContain("PRODUCT('Tie rod M10 1/Tie rod M10',");
    expect(step).toContain("PRODUCT('Tie rod M10 2/Tie rod M10',");
  });
});

describe('withMonotonicStepCounter', () => {
  const at = (nextStepNumber: number): CadDocument => ({ ...createEmptyDocument(), nextStepNumber });
  it('raises the restored counter to the current one', () => {
    expect(withMonotonicStepCounter(at(3), at(7)).nextStepNumber).toBe(7);
  });
  it('returns the restored document itself when it already holds the maximum', () => {
    const restored = at(9);
    expect(withMonotonicStepCounter(restored, at(2))).toBe(restored);
  });
});
