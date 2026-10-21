import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute, listCommands } from '@core/commands/registry';
import type { ParamSpec } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { boxOf, step } from '../materials/support';

/** `export_*` commands that emit nothing from the document. None today; add a name here only with the reason. */
const NOT_CONTENT_EXPORTS: ReadonlySet<string> = new Set<string>([]);

const ctx = { ...defaultContext(), kernel: {} as unknown as GeometryKernel, humanSignature: null };

/** A schema-valid value for one parameter (the gate runs before any lookup, so ids need not exist). */
function sample(spec: ParamSpec): unknown {
  if (spec.enum !== undefined && spec.enum.length > 0) return spec.enum[0];
  switch (spec.type) {
    case 'string':
      return 'x';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    default:
      return {};
  }
}

const requiredParams = (name: string): Record<string, unknown> => {
  const schema = listCommands().find((command) => command.name === name)?.paramsSchema;
  const required = schema?.required ?? [];
  return Object.fromEntries(required.map((key) => [key, sample(schema?.properties[key] as ParamSpec)]));
};

function controlledDocument(): CadDocument {
  const record = { id: 'secret', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'ITAR' } };
  return boxOf(step(createEmptyDocument(), 'define_material_record', record), 'secret').doc;
}

const exportNames = listCommands()
  .map((command) => command.name)
  .filter((name) => name.startsWith('export_') && !NOT_CONTENT_EXPORTS.has(name));

describe('every export_* command is behind the export gate (TR-MAT-30 / 51)', () => {
  it('finds the export commands of core and every plugin', () => {
    for (const name of ['export_stl', 'export_sheet_svg', 'export_material_cards', 'export_building_dxf', 'export_ifc', 'export_nc_files'])
      expect(exportNames).toContain(name);
    expect(exportNames.length).toBeGreaterThanOrEqual(21);
  });

  it.each(exportNames)('%s refuses a controlled document with MAT_EXPORT_CONTROLLED and returns no data', (name) => {
    const doc = controlledDocument();
    const withMaterialCard = name === 'export_material_cards' ? { material: 'secret', target: 'calculix' } : {};
    const result = execute(doc, name, { ...requiredParams(name), ...withMaterialCard }, ctx);
    expect(result.error?.code, result.summary).toBe('MAT_EXPORT_CONTROLLED');
    expect(result.rejected).toBe(true);
    expect(result.data).toBeUndefined();
    expect(result.document).toBe(doc);
  });

  it.each(exportNames)('%s: an agent confirmation (true) is MAT_HUMAN_GATE', (name) => {
    const doc = controlledDocument();
    const params = { ...requiredParams(name), ...(name === 'export_material_cards' ? { material: 'secret', target: 'calculix' } : {}) };
    const result = execute(doc, name, { ...params, confirmExportControlled: true }, ctx);
    expect(result.error?.code, result.summary).toBe('MAT_HUMAN_GATE');
  });

  it('export_material_cards also gates the controlled material it writes when no entity uses it', () => {
    const record = {
      id: 'secret',
      designation: 'X',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'EAR', eccn: '1C002' },
    };
    const doc = step(createEmptyDocument(), 'define_material_record', record);
    const result = execute(doc, 'export_material_cards', { material: 'secret', target: 'calculix' }, ctx);
    expect(result.error?.code).toBe('MAT_EXPORT_CONTROLLED');
  });

  it('an uncontrolled document is not gated', () => {
    const result = execute(createEmptyDocument(), 'export_stl', {}, ctx);
    expect(result.error?.code).not.toBe('MAT_EXPORT_CONTROLLED');
  });
});
