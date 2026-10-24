/** Line-number template (02 RTE §5.9, M3): rendering, validation, best-effort parsing and the `set_piping_settings` command. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument, RevolutionEntity } from '@core/model/types';
import {
  DEFAULT_LINE_NUMBER_TEMPLATE,
  lineNumberTemplate,
  parseLineNumber,
  renderLineNumber,
  templateProblem,
} from '@aec/plant/piping/lineNumber';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document, cs150Line } from './rteFixtures';

const fields = { dn: 80, service: 'HO', sequence: '4001', spec: 'CS150' };
const insulated = { ...fields, insulation: { code: 'H', thicknessMm: 50 } };

describe('template engine', () => {
  it('default template: SC-RTE-07 80-HO-4001-CS150-H50; the optional insulation group vanishes without insulation', () => {
    expect(renderLineNumber(DEFAULT_LINE_NUMBER_TEMPLATE, insulated)).toBe('80-HO-4001-CS150-H50');
    expect(renderLineNumber(DEFAULT_LINE_NUMBER_TEMPLATE, fields)).toBe('80-HO-4001-CS150');
  });

  it('custom templates reorder fields and keep literals; an empty field outside a group renders empty', () => {
    expect(renderLineNumber('{service}{sequence}/{dn}[ ({insulationCode})]', insulated)).toBe('HO4001/80 (H)');
    expect(renderLineNumber('{service}{sequence}/{dn}[ ({insulationCode})]', fields)).toBe('HO4001/80');
    expect(renderLineNumber('L-{sequence}-{insulationCode}', fields)).toBe('L-4001-');
  });

  it.each([
    ['', '1 to 120'],
    ['{dn}-{service}', 'needs {sequence}'],
    ['{sequence}-{bogus}', 'unknown placeholder {bogus}'],
    ['{sequence}-{dn}-{dn}', 'twice'],
    ['[{sequence}', 'unbalanced ['],
    ['{sequence}]', 'unbalanced ]'],
    ['[[{sequence}]]', 'nested'],
    ['{sequence}{', 'stray brace'],
  ])('refuses the template %j (%s)', (template, why) => {
    expect(templateProblem(template)).toContain(why);
  });

  it('accepts the default and a custom one', () => {
    expect(templateProblem(DEFAULT_LINE_NUMBER_TEMPLATE)).toBeNull();
    expect(templateProblem('{service}-{sequence}')).toBeNull();
  });

  it('reads a number back best effort, reports differences and never corrects them', () => {
    const same = parseLineNumber(DEFAULT_LINE_NUMBER_TEMPLATE, '80-HO-4001-CS150-H50', insulated);
    expect(same).toMatchObject({ matched: true, differences: [] });
    expect(same.fields).toMatchObject({
      dn: '80',
      service: 'HO',
      sequence: '4001',
      spec: 'CS150',
      insulationCode: 'H',
      insulationThickness: '50',
    });
    const other = parseLineNumber(DEFAULT_LINE_NUMBER_TEMPLATE, '80-HO-4002-CS150', fields);
    expect(other.differences).toEqual([{ field: 'sequence', parsed: '4002', line: '4001' }]);
    expect(parseLineNumber(DEFAULT_LINE_NUMBER_TEMPLATE, 'L-1', fields)).toEqual({ matched: false, fields: {}, differences: [] });
  });

  it('the document template is the default until set', () => {
    expect(lineNumberTemplate({})).toEqual({ value: DEFAULT_LINE_NUMBER_TEMPLATE, defaulted: true });
    expect(lineNumberTemplate({ settings: { lineNumberTemplate: '{sequence}' } })).toEqual({ value: '{sequence}', defaulted: false });
  });
});

describe('set_piping_settings', () => {
  const two = (): { doc: CadDocument; ids: string[] } => {
    const first = apply(cs150Document(), 'create_pipeline', { service: 'P', sequence: '1001', spec: 'CS150', dn: 100 });
    const second = apply(first, 'create_pipeline', { service: 'CW', sequence: '1002', spec: 'CS150', dn: 100, lineNumber: 'EXPLICIT-1' });
    return { doc: second, ids: second.plant?.piping?.lineOrder as string[] };
  };

  it('renumbers the lines that followed the old template, keeps explicit numbers and names both', () => {
    const s = two();
    const result = ok(s.doc, 'set_piping_settings', { lineNumberTemplate: '{service}-{sequence}-{dn}' });
    const lines = result.document.plant?.piping?.lines ?? {};
    expect(lines[s.ids[0] as string]?.lineNumber).toBe('P-1001-100');
    expect(lines[s.ids[1] as string]?.lineNumber).toBe('EXPLICIT-1');
    expect(result.data).toMatchObject({
      template: { value: '{service}-{sequence}-{dn}', defaulted: false },
      renumbered: [{ lineId: s.ids[0], from: '100-P-1001-CS150', to: 'P-1001-100' }],
      keptExplicit: [s.ids[1]],
    });
    expect(result.document.plant?.piping?.settings).toEqual({ lineNumberTemplate: '{service}-{sequence}-{dn}' });
  });

  it('new lines follow the template (data.template.defaulted false) and null restores the default', () => {
    const s = two();
    const custom = apply(s.doc, 'set_piping_settings', { lineNumberTemplate: '{service}-{sequence}-{dn}' });
    const made = data<{ lineNumber: string; template: { defaulted: boolean; applied: boolean } }>(custom, 'create_pipeline', {
      service: 'HO',
      sequence: '4001',
      spec: 'CS150',
      dn: 100,
    });
    expect(made.lineNumber).toBe('HO-4001-100');
    expect(made.template).toMatchObject({ defaulted: false, applied: true });
    const back = apply(custom, 'set_piping_settings', { lineNumberTemplate: null });
    expect(back.plant?.piping?.settings).toBeUndefined();
    expect(back.plant?.piping?.lines[s.ids[0] as string]?.lineNumber).toBe('100-P-1001-CS150');
  });

  it('explicit numbers are parsed with the template and the differences reported, not corrected', () => {
    const made = data<{ lineNumber: string; lineNumberParse: { matched: boolean; differences: unknown[] } }>(
      cs150Document(),
      'create_pipeline',
      { service: 'P', sequence: '1001', spec: 'CS150', dn: 100, lineNumber: '100-P-9999-CS150' },
    );
    expect(made.lineNumber).toBe('100-P-9999-CS150');
    expect(made.lineNumberParse.matched).toBe(true);
    expect(made.lineNumberParse.differences).toEqual([{ field: 'sequence', parsed: '9999', line: '1001' }]);
  });

  it('derived part names follow the renumbering (reconcile rebuilds the run entities)', () => {
    const { doc, lineId } = cs150Line();
    const a = addTie(doc, 'A', [0, 0, 0], [1, 0, 0]);
    const routed = apply(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 2000 }] });
    const runId = routed.plant?.piping?.runOrder[0] as string;
    const renamed = apply(routed, 'set_piping_settings', { lineNumberTemplate: '{service}{sequence}' });
    const piece = renamed.entities[`${runId}/pipe-1`] as RevolutionEntity;
    expect(piece.name).toContain('P1001');
    expect(piece.name).not.toContain('100-P-1001-CS150');
  });

  it('refuses an unusable template, two lines getting one number and a no-op; omitting the template changes nothing', () => {
    const s = two();
    expectRefusal(s.doc, 'set_piping_settings', { lineNumberTemplate: '{service}' }, 'RTE_TEMPLATE_INVALID', 'lineNumberTemplate');
    // An explicit number equal to the one the first line would be renumbered to.
    const clashing = apply(s.doc, 'create_pipeline', { service: 'P', sequence: '2001', spec: 'CS150', dn: 100, lineNumber: 'P-1001-100' });
    expectRefusal(clashing, 'set_piping_settings', { lineNumberTemplate: '{service}-{sequence}-{dn}' }, 'RTE_DUPLICATE_LINE_NUMBER');
    expect(execute(s.doc, 'set_piping_settings', { lineNumberTemplate: DEFAULT_LINE_NUMBER_TEMPLATE }).document).toBe(s.doc);
    expect(execute(s.doc, 'set_piping_settings', {}).document).toBe(s.doc);
  });

  it('is pure, survives save and load, and a corrupt template in a file is a validation error', () => {
    const s = two();
    const before = JSON.stringify(s.doc);
    const changed = execute(s.doc, 'set_piping_settings', { lineNumberTemplate: '{sequence}-{service}' });
    expect(JSON.stringify(s.doc)).toBe(before);
    const loaded = deserializeDocument(serializeDocument(changed.document));
    expect(loaded.plant?.piping?.settings).toEqual({ lineNumberTemplate: '{sequence}-{service}' });
    const piping = JSON.parse(JSON.stringify(changed.document.plant?.piping)) as Record<string, unknown>;
    expect(pipingErrors({ ...piping, settings: { lineNumberTemplate: '{service}' } })).toEqual([
      expect.stringContaining('plant.piping.settings.lineNumberTemplate'),
    ]);
    expect(pipingErrors({ ...piping, settings: 3 })).toEqual(['plant.piping.settings must be an object']);
  });
});
