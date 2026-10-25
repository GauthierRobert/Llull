/**
 * Plant 05 ISO M1: the less common records and attributes of the subset (§6.1) survive read -> write: pass-through header lines, SUPPORT with CO-ORDS,
 * OLET and BOLT without END-POINTs, WEIGHT, the three category flags, weld keys, extra pipeline attributes, `-0.0`.
 */

import { describe, expect, it } from 'vitest';
import { readPcf } from '@aec/plant/fabrication/pcf/pcfRead';
import { writePcfText } from '@aec/plant/fabrication/pcf/pcfWrite';

const SINK = [
  'ISOGEN-FILES ISOGEN.FLS',
  'UNITS-BORE MM',
  'UNITS-CO-ORDS MM',
  'UNITS-WEIGHT KGS',
  'UNITS-BOLT-DIA MM',
  'UNITS-BOLT-LENGTH MM',
  'UNITS-WEIGHT-LENGTH METER',
  'PIPELINE-REFERENCE K-1',
  '    PIPING-SPEC A1A',
  '    PAINTING-SPEC P1',
  '    HIGHEST-WELD-NUMBER 12',
  '    NOTE-FREE-FORM some text',
  'PIPE',
  '    COMPONENT-IDENTIFIER 1',
  '    END-POINT 0.0 0.0 0.0 100 BW',
  '    END-POINT 1000.0 0.0 0.0 100 BW',
  '    FABRICATION-ITEM',
  '    ITEM-CODE PIPE-100',
  '    WEIGHT 12.5',
  'OLET',
  '    COMPONENT-IDENTIFIER 2',
  '    CENTRE-POINT 500.0 0.0 0.0',
  '    BRANCH1-POINT 500.0 0.0 100.0 50 BW',
  '    SKEY OLWE',
  'BOLT',
  '    COMPONENT-IDENTIFIER 3',
  '    OFFSHORE-ITEM',
  '    ITEM-CODE BOLT-100',
  'WELD',
  '    COMPONENT-IDENTIFIER 4',
  '    END-POINT 1000.0 0.0 0.0 100 BW',
  '    END-POINT 1000.0 0.0 0.0 100 BW',
  '    SKEY WF',
  'SUPPORT',
  '    COMPONENT-IDENTIFIER 5',
  '    CO-ORDS 250.0 0.0 -100.0',
  '    SKEY SU01',
  'MATERIALS',
  'ITEM-CODE PIPE-100',
  '    DESCRIPTION pipe   with  spaces',
  '    NOTE-FLAG',
  '',
].join('\n');

describe('the rarer records of the subset', () => {
  it('read -> write is byte-equal and every field lands in the network', () => {
    const read = readPcf(SINK);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.header).toEqual({ 'ISOGEN-FILES': 'ISOGEN.FLS', 'UNITS-WEIGHT': 'KGS', 'UNITS-WEIGHT-LENGTH': 'METER' });
    expect(read.file.attributes['NOTE-FREE-FORM']).toBe('some text');
    const [pipe, olet, bolt, weld, support] = read.file.components;
    expect(pipe).toMatchObject({ category: 'fabrication', weightKg: 12.5 });
    expect(olet).toMatchObject({ ends: [], centre: [500, 0, 0], branch: { boreMm: 50 } });
    expect(bolt).toMatchObject({ category: 'offshore', ends: [] });
    expect(weld).toMatchObject({ weldKind: 'field_fit', skey: 'WF' });
    expect(support).toMatchObject({ coords: [250, 0, -100], skey: 'SU01' });
    expect(read.file.materials[0]?.fields).toEqual({ DESCRIPTION: 'pipe   with  spaces', 'NOTE-FLAG': '' });
    expect(writePcfText(read.file, { units: 'mm', includeMaterials: true }).content).toBe(SINK);
  });

  it('the writer derives the weld key from weldKind and prints negative zero as 0.0', () => {
    const read = readPcf(SINK);
    if (!read.ok) throw new Error(read.message);
    const components = read.file.components.map((component) => {
      if (component.type === 'WELD') {
        const { skey, ...rest } = component;
        void skey;
        return { ...rest, weldKind: 'shop' as const, ends: [{ xyz: [-0, 0, 0] as [number, number, number], boreMm: 100, endType: 'BW' }] };
      }
      return component;
    });
    const content = writePcfText({ ...read.file, components }, { units: 'mm', includeMaterials: false }).content;
    expect(content).toContain('WELD\n    COMPONENT-IDENTIFIER 4\n    END-POINT 0.0 0.0 0.0 100 BW\n    SKEY WW\n');
    expect(content).not.toContain('MATERIALS');
  });
});
