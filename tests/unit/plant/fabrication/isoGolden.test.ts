/** ISO-M6 (VC-ISO-17): the reference isometric of L-101 (plan SC-ISO-03: import, final sheet) and its PCF are golden files; a run twice is byte-identical. */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@lib/sha256';
import { apply, data } from '../../../helpers/commandAssertions';
import { loadedL101 } from './isoM2Fixtures';

interface Files {
  files: Array<{ name: string; format: string; content: string; sha256: string }>;
}

const reference = (): { svg: string; dxf: string; pcf: string; sha: string[] } => {
  const doc = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });
  const iso = data<Files>(doc, 'export_isometric', { lineId: 'L-101', style: 'final', paper: 'A3', formats: ['svg', 'dxf'] });
  const pcf = data<Files>(doc, 'export_pcf', { lineIds: ['L-101'] });
  const svg = iso.files.find((file) => file.format === 'svg')?.content ?? '';
  const dxf = iso.files.find((file) => file.format === 'dxf')?.content ?? '';
  const text = pcf.files[0]?.content ?? '';
  return { svg, dxf, pcf: text, sha: [svg, dxf, text].map(sha256Hex) };
};

describe('VC-ISO-17: golden isometric of L-101', () => {
  const first = reference();

  it('the SVG, the DXF and the PCF match the golden files', async () => {
    await expect(first.svg).toMatchFileSnapshot('../../../golden/__snapshots__/plant_iso_l101.svg');
    await expect(first.dxf).toMatchFileSnapshot('../../../golden/__snapshots__/plant_iso_l101.dxf');
    await expect(first.pcf).toMatchFileSnapshot('../../../golden/__snapshots__/plant_iso_l101.pcf');
  });

  it('a second run of the same plan gives the same sha256 of every file', () => {
    expect(reference().sha).toEqual(first.sha);
    expect(first.sha.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });
});
