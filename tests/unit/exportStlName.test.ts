import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { ExportStlData } from '@core/commands/export';
import { execute } from '@core/commands/registry';

describe('export_stl solid name', () => {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const exportData = (params: Record<string, unknown>): ExportStlData =>
    execute(doc, 'export_stl', params).data as ExportStlData;

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
