/**
 * Plant 05 ISO M1: the canonical writer and the round trips (VC-ISO-03): fixture read -> write is byte-equal, a routed line exported, previewed and
 * stored comes back as the same network, inches, materials switch, document persistence of the stored line.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { sha256Hex } from '@lib/sha256';
import { readPcf } from '@aec/plant/fabrication/pcf/pcfRead';
import { writePcfText } from '@aec/plant/fabrication/pcf/pcfWrite';
import { fabricationErrors } from '@aec/plant/fabrication/validate';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, routedPumpToVesselWithTee } from '../piping/rteFixtures';
import { fixturePcf, withLine } from './fabricationFixtures';

interface Exported {
  files: Array<{
    name: string;
    content: string;
    sha256: string;
    componentCount: number;
    source: string;
    warnings: Array<{ code: string }>;
  }>;
  count: number;
}
const exported = (doc: CadDocument, params: Record<string, unknown> = {}): Exported => data<Exported>(doc, 'export_pcf', params);

describe('read -> write is byte-equal on the MVP subset (VC-ISO-03)', () => {
  const text = fixturePcf();

  it('the fixture is the pack file (sha256 56d1b90a...) and the canonical writer reproduces it', () => {
    expect(sha256Hex(text)).toMatch(/^56d1b90a/);
    const read = readPcf(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const written = writePcfText(read.file, { units: 'mm', includeMaterials: true });
    expect(written.content).toBe(text);
    expect(written.truncatedLines).toEqual([]);
  });

  it('import_pcf then export_pcf gives the same bytes, the same sha256, 15 components', () => {
    const stored = apply(createEmptyDocument(), 'import_pcf', { text });
    const file = exported(stored, { lineIds: ['L-101'] }).files[0];
    expect(file?.content).toBe(text);
    expect(file?.sha256).toBe(sha256Hex(text));
    expect(file?.componentCount).toBe(15);
    expect(file?.name).toBe('L-101.pcf');
    expect(file?.source).toBe('pcf');
  });

  it('unknown records and attributes come back at the same place', () => {
    const odd = withLine(
      withLine(text, 16, '    COMPONENT-ATTRIBUTE1 12.5\n    SKEY FLWN'),
      12,
      'MESSAGE-SQUARE\n    TEXT hello  world\nFLANGE',
    );
    const stored = apply(createEmptyDocument(), 'import_pcf', { text: odd });
    const back = exported(stored).files[0]?.content ?? '';
    expect(back).toContain('MESSAGE-SQUARE\n    TEXT hello  world\nFLANGE');
    expect(back).toContain('    END-POINT 76.0 0.0 3000.0 100 BW\n    COMPONENT-ATTRIBUTE1 12.5\n    SKEY FLWN\n');
    expect(back.split('\n').filter((line) => line.startsWith('COMPONENT-ATTRIBUTE')).length).toBe(0);
  });

  it('export in inches writes INCH units and 4 decimals; reading it back gives the same geometry within the 4-decimal rounding', () => {
    const stored = apply(createEmptyDocument(), 'import_pcf', { text });
    const inch = exported(stored, { units: 'inch' }).files[0]?.content ?? '';
    expect(inch).toContain('UNITS-BORE INCH\nUNITS-CO-ORDS INCH\nUNITS-WEIGHT KGS\nUNITS-BOLT-DIA INCH\nUNITS-BOLT-LENGTH INCH\n');
    expect(inch).toContain('END-POINT 0.0000 0.0000 118.1102 3.937 FL');
    const again = data<{ totalPipeLengthMm: number; units: { coords: string } }>(createEmptyDocument(), 'import_pcf', {
      text: inch,
      preview: true,
    });
    expect(again.units.coords).toBe('INCH');
    expect(again.totalPipeLengthMm).toBeCloseTo(13045, 1);
  });

  it('includeMaterials false drops the MATERIALS block only', () => {
    const stored = apply(createEmptyDocument(), 'import_pcf', { text });
    const without = exported(stored, { includeMaterials: false }).files[0]?.content ?? '';
    expect(without).not.toContain('MATERIALS');
    expect(text.startsWith(without.trimEnd())).toBe(true);
  });

  it('a description over 1024 characters is cut and its output line number reported', () => {
    const read = readPcf(text);
    if (!read.ok) throw new Error(read.message);
    const [first, ...others] = read.file.materials;
    const long = { ...read.file, materials: [{ itemCode: first?.itemCode ?? '', fields: { DESCRIPTION: 'x'.repeat(1100) } }, ...others] };
    const written = writePcfText(long, { units: 'mm', includeMaterials: true });
    expect(written.content.split('\n').every((line) => line.length <= 1024)).toBe(true);
    expect(written.truncatedLines).toHaveLength(1);
  });
});

describe('route -> export_pcf -> import_pcf preview: the same network (plant 05 ISO M1 acceptance)', () => {
  const line = cs150Line(100, '6001');
  const a = addTie(line.doc, 'RT-A', [0, 0, 0], [1, 0, 0]);
  const routed = apply(a.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 3000 },
      { direction: '+Z', length: 2000 },
    ],
  });
  const file = exported(routed).files[0] as Exported['files'][number];

  it('preview reports the exported counts and pipe lengths (2848 + 1848)', () => {
    const preview = data<{
      lineId: string;
      componentCount: number;
      countsByType: Record<string, number>;
      pipeLengthsMm: number[];
      totalPipeLengthMm: number;
    }>(createEmptyDocument(), 'import_pcf', { text: file.content, preview: true });
    expect(preview.lineId).toBe('100-P-6001-CS150');
    expect(preview.componentCount).toBe(file.componentCount);
    expect(preview.countsByType).toEqual({ PIPE: 2, ELBOW: 1 });
    expect(preview.pipeLengthsMm).toEqual([2848, 1848]);
    expect(preview.totalPipeLengthMm).toBeCloseTo(4696, 6);
  });

  it('importing into the routed document is refused (the line number is in use) and succeeds under another id', () => {
    expectRefusal(routed, 'import_pcf', { text: file.content }, 'ISO_PCF_LINE_EXISTS');
    const stored = apply(routed, 'import_pcf', { text: file.content, lineIdOverride: 'COPY-1' });
    const again = exported(stored, { lineIds: ['COPY-1'] }).files[0];
    expect(again?.content).toBe(file.content.replace('PIPELINE-REFERENCE 100-P-6001-CS150', 'PIPELINE-REFERENCE COPY-1'));
  });

  it('the stored copy reads back to the same components as the routed export (ids, points, keys, item codes)', () => {
    const second = readPcf(file.content);
    const stored = apply(routed, 'import_pcf', { text: file.content, lineIdOverride: 'COPY-2' });
    const copy = stored.plant?.fabrication?.pcfLines['COPY-2'];
    expect(second.ok && copy?.components).toEqual(second.ok ? second.file.components : undefined);
  });

  it('the whole export default includes routed and imported lines, routed first', () => {
    const stored = apply(routed, 'import_pcf', { text: file.content, lineIdOverride: 'COPY-3' });
    expect(exported(stored).files.map((entry) => entry.name)).toEqual(['100-P-6001-CS150.pcf', 'COPY-3.pcf']);
  });
});

describe('a pump-to-vessel line with a tee, valve, flanges, gaskets and bolts survives the round trip', () => {
  const scene = routedPumpToVesselWithTee();
  const file = exported(scene.doc).files[0] as Exported['files'][number];

  it('export -> import -> export differs only in the PIPELINE-REFERENCE line', () => {
    const stored = apply(createEmptyDocument(), 'import_pcf', { text: file.content, lineIdOverride: 'RT' });
    const back = exported(stored).files[0]?.content ?? '';
    const reference = file.content.split('\n').find((text) => text.startsWith('PIPELINE-REFERENCE')) ?? '';
    expect(back).toBe(file.content.replace(reference, 'PIPELINE-REFERENCE RT'));
  });
});

describe('the stored slice persists and validates', () => {
  const stored = apply(createEmptyDocument(), 'import_pcf', { text: fixturePcf() });

  it('save -> load keeps the stored line and re-serializes equal', () => {
    const json = serializeDocument(stored);
    const loaded = deserializeDocument(json);
    expect(loaded.plant?.fabrication?.pcfLines['L-101']?.components).toHaveLength(15);
    expect(serializeDocument(loaded)).toBe(json);
  });

  it('a corrupt slice is rejected on load', () => {
    const raw = JSON.parse(serializeDocument(stored)) as {
      document: { plant: { fabrication: { pcfLines: Record<string, { components: unknown[] }> } } };
    };
    const line = raw.document.plant.fabrication.pcfLines['L-101'] as { components: unknown[] };
    line.components = [{ id: 'x', type: 'NOPE', ends: [1, 2, 3] }];
    expect(() => deserializeDocument(JSON.stringify(raw))).toThrow(/fabrication/);
  });

  it.each([
    ['not an object', 5],
    ['a wrong version', { version: 2, pcfLines: {} }],
    ['pcfLines not an object', { version: 1, pcfLines: [] }],
    ['a line whose id differs from its key', { version: 1, pcfLines: { A: { lineId: 'B' } } }],
    ['a line that is not an object', { version: 1, pcfLines: { A: 3 } }],
  ])('fabricationErrors: %s', (_name, raw) => {
    expect(fabricationErrors(raw).length).toBeGreaterThan(0);
  });

  it('fabricationErrors: absent is valid; component fields are checked one by one', () => {
    expect(fabricationErrors(undefined)).toEqual([]);
    const good = JSON.parse(JSON.stringify(stored.plant?.fabrication)) as { pcfLines: Record<string, Record<string, unknown>> };
    expect(fabricationErrors(good)).toEqual([]);
    const line = good.pcfLines['L-101'] as { components: Array<Record<string, unknown>>; materials: unknown[]; unknownRecords: unknown[] };
    const first = line.components[0] as Record<string, unknown>;
    const second = line.components[1] as Record<string, unknown>;
    Object.assign(first, { branch: 3, centre: [1], skey: 4, weightKg: 'x', extra: { a: 1 }, id: second['id'] });
    line.materials = [{ itemCode: 3 }];
    line.unknownRecords = [{ type: 'X' }];
    const problems = fabricationErrors(good).join('\n');
    for (const fragment of ['branch', 'centre', 'skey', 'weightKg', 'extra', 'used twice', 'materials[0]', 'unknownRecords[0]'])
      expect(problems).toContain(fragment);
  });
});

describe('is pure', () => {
  it('export_pcf returns the very document it was given', () => {
    const stored = apply(createEmptyDocument(), 'import_pcf', { text: fixturePcf() });
    expect(execute(stored, 'export_pcf', {}).document).toBe(stored);
  });
});
