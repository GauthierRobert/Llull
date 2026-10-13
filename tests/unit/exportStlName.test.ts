import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { ExportStlData } from '@core/commands/exchange/exportStl';
import { execute } from '@core/commands/registry';

describe('export_stl solid name', () => {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const exportData = (params: Record<string, unknown>): ExportStlData => execute(doc, 'export_stl', params).data as ExportStlData;

  it('wraps ASCII output in the requested name', () => {
    const stl = exportData({ name: 'bracket' }).stl!;
    expect(stl.startsWith('solid bracket\n')).toBe(true);
    expect(stl.endsWith('endsolid bracket')).toBe(true);
  });

  it('cannot inject facets or records through a multi-line name', () => {
    const stl = exportData({ name: 'part\nendsolid\nsolid evil' }).stl!;
    const lines = stl.split('\n');
    expect(lines[0]).toBe('solid part endsolid solid evil');
    expect(lines.filter((line) => line.startsWith('solid')).length).toBe(1);
  });

  it('falls back to llull for a blank name', () => {
    expect(exportData({ name: ' \n ' }).stl!.startsWith('solid llull\n')).toBe(true);
  });

  it('binary header never starts with "solid" (ASCII sniffers), even for a name that does', () => {
    const data = exportData({ format: 'binary', name: 'solid thing' });
    const bytes = Buffer.from(data.stlBase64!, 'base64');
    expect(bytes.subarray(0, 5).toString('ascii').toLowerCase()).not.toBe('solid');
    expect(bytes.subarray(0, 17).toString('ascii')).toBe('llull solid thing');
    expect(bytes.readUInt32LE(80)).toBe(data.triangleCount);
  });
});

describe('export_stl entity names', () => {
  type Doc = ReturnType<typeof createEmptyDocument>;
  const named = (): Doc => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] }).document;
    const [first] = doc.order;
    return execute(doc, 'set_entity_name', { id: first, name: 'Bearing 1' }).document;
  };
  const stlOf = (doc: Doc, p: Record<string, unknown>): string => (execute(doc, 'export_stl', p).data as ExportStlData).stl!;

  it('names the solid after a lone exported named entity', () => {
    const doc = named();
    const stl = stlOf(doc, { entityIds: [doc.order[0]] });
    expect(stl.startsWith('solid Bearing 1\n')).toBe(true);
  });

  it('keeps the llull default when several entities are merged', () => {
    expect(stlOf(named(), {}).startsWith('solid llull\n')).toBe(true);
  });

  it('perEntity writes one named solid block per entity (name, else id)', () => {
    const doc = named();
    const lines = stlOf(doc, { perEntity: true }).split('\n');
    expect(lines.filter((line) => line.startsWith('solid '))).toEqual(['solid Bearing 1', `solid ${doc.order[1]}`]);
    expect(lines.filter((line) => line.startsWith('endsolid ')).length).toBe(2);
    expect(lines.filter((line) => line.includes('facet normal')).length).toBe(24);
  });

  it('perEntity on an empty selection is one valid empty solid', () => {
    expect(stlOf(createEmptyDocument(), { perEntity: true })).toBe('solid llull\nendsolid llull');
  });
});

describe('export_obj entity names', () => {
  it('writes one named object per entity with offset face indices', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] }).document;
    const [first, second] = doc.order;
    doc = execute(doc, 'set_entity_name', { id: first, name: 'Shaft  A' }).document;
    const text = (execute(doc, 'export_obj', {}).data as { text: string }).text;
    const lines = text.split('\n');
    expect(lines.filter((line) => line.startsWith('o '))).toEqual(['o Shaft_A', `o ${second}`]);
    expect(lines.filter((line) => line.startsWith('f ')).at(12)).toBe('f 37//13 38//13 39//13');
  });
});
