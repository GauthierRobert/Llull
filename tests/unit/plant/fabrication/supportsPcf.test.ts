/**
 * Plant 05 ISO M5: supports in the PCF (SUPPORT records with CO-ORDS) for routed, legacy and imported lines, and the helper that reads them (VC-ISO-21, first half).
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { lineSupports } from '@aec/plant/fabrication/supports';
import { legacyNetwork } from '@aec/plant/fabrication/legacyNetwork';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { s501, routedWithSupport } from './isoM5Fixtures';
import { fixturePcf } from './fabricationFixtures';

interface PcfFile {
  content: string;
  countsByType: Record<string, number>;
  supports: Array<{ id: string; mark: string; type: string; coordsMm: number[] }>;
  missingSkey: string[];
}

describe('export_pcf includeSupports', () => {
  it('a legacy line writes its two shoes as SUPPORT records on the centreline, after the pipe they lie on (VC-ISO-21)', () => {
    const doc = s501();
    const file = data<{ files: PcfFile[] }>(doc, 'export_pcf', { lineIds: ['S-501'], includeSupports: true }).files[0] as PcfFile;
    expect(file.countsByType['SUPPORT']).toBe(2);
    expect(file.supports.map((support) => support.coordsMm)).toEqual([
      [1000, 0, 2000],
      [4000, 1000, 2000],
    ]);
    expect(file.supports.map((support) => support.type)).toEqual(['shoe', 'shoe']);
    expect(file.supports.map((support) => support.mark)).toEqual(['PS1', 'PS2']);
    expect(file.content).toContain('SUPPORT\n    COMPONENT-IDENTIFIER');
    expect(file.content).toContain('    CO-ORDS 1000.0 0.0 2000.0');
    expect(file.content).toContain('    SUPPORT-TYPE SHOE');
    expect(file.missingSkey.some((id) => id.startsWith('pipesupport'))).toBe(false);
  });

  it('default is no supports for a routed or legacy line; the file is unchanged by supports in the document', () => {
    const doc = s501();
    const without = data<{ files: PcfFile[] }>(doc, 'export_pcf', { lineIds: ['S-501'] }).files[0] as PcfFile;
    expect(without.countsByType['SUPPORT']).toBeUndefined();
    expect(without.supports).toEqual([]);
  });

  it('a routed line writes its guide, the PCF reads back through import_pcf preview with the support kept', () => {
    const { doc, lineId } = routedWithSupport();
    const file = data<{ files: PcfFile[] }>(doc, 'export_pcf', { lineIds: [lineId], includeSupports: true }).files[0] as PcfFile;
    expect(file.supports).toHaveLength(1);
    expect(file.supports[0]?.coordsMm).toEqual([3000, 0, 1000]);
    const preview = data<{ countsByType: Record<string, number> }>(createEmptyDocument(), 'import_pcf', {
      text: file.content,
      preview: true,
    });
    expect(preview.countsByType['SUPPORT']).toBe(1);
    const stored = apply(createEmptyDocument(), 'import_pcf', { text: file.content });
    const again = data<{ files: PcfFile[] }>(stored, 'export_pcf', {}).files[0] as PcfFile;
    expect(again.content).toBe(file.content);
    expect(again.supports).toEqual(file.supports);
  });

  it('an imported line always writes the SUPPORT records it holds (lossless), includeSupports or not', () => {
    const text = fixturePcf().replace('MATERIALS\n', 'SUPPORT\n    COMPONENT-IDENTIFIER 16\n    CO-ORDS 1000.0 0.0 3000.0\nMATERIALS\n');
    const stored = apply(createEmptyDocument(), 'import_pcf', { text });
    for (const params of [{}, { includeSupports: false }, { includeSupports: true }]) {
      const file = data<{ files: PcfFile[] }>(stored, 'export_pcf', params).files[0] as PcfFile;
      expect(file.content).toBe(text);
      expect(file.supports).toEqual([{ id: 'pcf:L-101:16', mark: 'pcf:L-101:16', type: 'unspecified', coordsMm: [1000, 0, 3000] }]);
    }
  });

  it('is pure and deterministic', () => {
    const doc = s501();
    const before = JSON.stringify(doc);
    const first = execute(doc, 'export_pcf', { lineIds: ['S-501'], includeSupports: true });
    expect(JSON.stringify(doc)).toBe(before);
    expect(ok(doc, 'export_pcf', { lineIds: ['S-501'], includeSupports: true }).data).toEqual(first.data);
  });
});

describe('lineSupports', () => {
  it('reads document supports in the world frame, level elevation added, unit converted', () => {
    const doc = apply(createEmptyDocument(), 'set_units', { units: 'm' });
    let withLevel = apply(doc, 'add_level', { name: 'Upper', elevation: 3 });
    withLevel = apply(withLevel, 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [6, 0, 0],
      ],
      dn: 100,
      line: 'M-1',
      service: 'water',
    });
    const pipeId = Object.values(withLevel.building?.elements ?? {}).find((element) => element.category === 'pipe')?.id as string;
    const supported = apply(withLevel, 'add_pipe_support', { pipeId, at: [[2, 0, 3]], type: 'anchor' });
    const network = legacyNetwork(supported, 'M-1');
    expect(network).not.toBeNull();
    const [support] = lineSupports(supported, 'M-1', network as NonNullable<typeof network>);
    expect(support?.xyz).toEqual([2000, 0, 3000]);
    expect(support?.type).toBe('anchor');
  });

  it('a line with no supports has none', () => {
    const network = legacyNetwork(s501(), 'S-501');
    expect(lineSupports(createEmptyDocument(), 'S-501', network as NonNullable<typeof network>)).toEqual([]);
  });
});
