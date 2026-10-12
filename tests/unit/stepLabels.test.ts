import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { labelStep, stepString } from '@core/commands/brep/stepLabels';
import { fakeKernel } from '../helpers/fakeKernel';

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

  it('names the solids, not the placement axis', () => {
    expect(labeled).toContain("#15 = MANIFOLD_SOLID_BREP('Bearing 1',#16);");
    expect(labeled).toContain("#359 = MANIFOLD_SOLID_BREP('Shaft''s',#360);");
    expect(labeled).toContain("#11 = AXIS2_PLACEMENT_3D('',#12,#13,#14);");
  });

  it('styles every solid with one shared color chain per distinct color', () => {
    expect(labeled.match(/COLOUR_RGB\('',1\.000,0\.000,0\.000\)/g)).toHaveLength(1);
    expect(labeled.match(/STYLED_ITEM\('color',\(#\d+\),#(15|359)\)/g)).toHaveLength(2);
    expect(labeled).toMatch(
      /MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION\('',\(#\d+,#\d+\),#345\)/,
    );
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
