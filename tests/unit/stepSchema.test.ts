import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { AP242_FILE_SCHEMA, retargetStepSchema } from '@core/commands/brep/stepSchema';
import { fakeKernel } from '../helpers/fakeKernel';

const AP214_STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Open CASCADE Model'),'2;1');
FILE_NAME('Open CASCADE Shape Model','2026-01-01',('Author'),('Open CASCADE'),'Open CASCADE STEP processor 7.9','Open CASCADE 7.9','Unknown');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1 = APPLICATION_PROTOCOL_DEFINITION('international standard',
  'automotive_design',2000,#2);
#2 = APPLICATION_CONTEXT(
  'core data for automotive mechanical design processes');
#7 = PRODUCT('Open CASCADE STEP translator 7.9 1',
  'Open CASCADE STEP translator 7.9 1','',(#8));
#10 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,#15),#345);
#11 = AXIS2_PLACEMENT_3D('',#12,#13,#14);
#15 = MANIFOLD_SOLID_BREP('',#16);
#345 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) );
ENDSEC;
END-ISO-10303-21;
`;

describe('retargetStepSchema', () => {
  it('rewrites FILE_SCHEMA, protocol definition and application context to AP242', () => {
    const out = retargetStepSchema(AP214_STEP, 'ap242');
    expect(out).toContain(`FILE_SCHEMA(('${AP242_FILE_SCHEMA}'));`);
    expect(out).not.toContain('AUTOMOTIVE_DESIGN');
    expect(out).toContain("'ap242_managed_model_based_3d_engineering',2011,#2");
    expect(out).toContain("APPLICATION_CONTEXT(\n  'managed model based 3d engineering')");
  });
  it('keeps everything else byte for byte (entities, names)', () => {
    const out = retargetStepSchema(AP214_STEP, 'ap242');
    expect(out.slice(out.indexOf('#7 = PRODUCT'))).toBe(AP214_STEP.slice(AP214_STEP.indexOf('#7 = PRODUCT')));
  });
  it('leaves AP214 text unchanged', () => {
    expect(retargetStepSchema(AP214_STEP, 'ap214')).toBe(AP214_STEP);
  });
  it('adds a FILE_SCHEMA to an empty HEADER and leaves text without declarations alone', () => {
    expect(retargetStepSchema('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;', 'ap242')).toContain('MIM_LF');
    expect(retargetStepSchema('DATA;', 'ap242')).toBe('DATA;');
  });
});

describe('export_step_ap242 schema option', () => {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1], color: '#ff0000' }).document;
  const ctx = { ...defaultContext(), kernel: fakeKernel({ step: AP214_STEP }) };
  it('writes AP214 when asked, and AP242 by default', () => {
    const byDefault = execute(doc, 'export_step_ap242', { includeValidationProperties: false }, ctx);
    expect(byDefault.summary).toContain('AP242');
    const result = execute(doc, 'export_step_ap242', { includeValidationProperties: false, schema: 'ap214' }, ctx);
    expect((result.data as { step: string }).step).toContain('AUTOMOTIVE_DESIGN');
    expect(result.summary).toContain('AP214');
  });
  it('writes the AP242 header and keeps names and colours', () => {
    const result = execute(doc, 'export_step_ap242', { includeValidationProperties: false, schema: 'ap242' }, ctx);
    const step = (result.data as { step: string }).step;
    expect(step).toContain('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF');
    expect(step).toContain(`PRODUCT('${doc.order[0]}'`);
    expect(step).toContain('COLOUR_RGB');
    expect(result.summary).toContain('AP242');
  });
  it('refuses AP203 on a kernel without the XDE writer and an unknown schema everywhere', () => {
    const result = execute(doc, 'export_step_ap242', { includeValidationProperties: false, schema: 'ap203' }, ctx);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('cannot write AP203');
    const unknown = execute(doc, 'export_step_ap242', { includeValidationProperties: false, schema: 'ap999' }, ctx);
    expect(unknown.summary).toContain('invalid params');
  });
});
