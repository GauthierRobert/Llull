/** Plant 04 PID M2: import_dexpi on the 11 DEXPI 1.3 verification files against the independent census (VC-PID-01, 03, 04, 05, 16). */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { getPid } from '@aec/plant/pid/state';
import { data } from '../../../helpers/commandAssertions';
import { C01, census, countsOf, dexpiText, importFile } from './dexpiFixtures';

describe('import_dexpi: census equality on the 11 files (VC-PID-01, 03)', () => {
  it('has the 11 files of the pack', () => {
    expect(census.proteus13).toHaveLength(11);
  });

  it.each(census.proteus13.map((entry) => [entry.file, entry] as const))('%s: every census count is equal', (file, entry) => {
    const doc = importFile(file);
    expect(countsOf(doc)).toEqual(entry.counts);
  });

  it.each(census.proteus13.map((entry) => [entry.file, entry] as const))(
    '%s: classes, tags, lines, instruments and loops are equal',
    (file, entry) => {
      const pid = getPid(importFile(file));
      const items = Object.values(pid.items);
      const tally = (kinds: string, pick: (cls: string) => boolean): Record<string, number> => {
        const found: Record<string, number> = {};
        for (const item of items)
          if (item.kind === kinds) {
            const cls = item.passthrough?.['dexpi:ComponentClass'] ?? item.dexpiClass;
            if (pick(cls)) found[cls] = (found[cls] ?? 0) + 1;
          }
        return found;
      };
      expect(tally('equipment', () => true)).toEqual(entry.equipmentByClass);
      expect(tally('inline', () => true)).toEqual(entry.pipingComponentsByClass);
      const tops = items.flatMap((item) => (item.kind === 'equipment' && item.parentId === undefined ? [item] : []));
      expect(tops.map((item) => item.tag ?? null)).toEqual(entry.equipment.map((e) => e.tagName));
      const lines = items.flatMap((item) => (item.kind === 'line' ? [item] : []));
      expect(
        lines.map((line) => ({
          lineNumber: line.lineNumber ?? null,
          fluidCode: line.fluidCode ?? null,
          pipingClass: line.pipingClass ?? null,
          dnText: line.attributes['nominalDiameterText']?.kind === 'text' ? line.attributes['nominalDiameterText'].value : null,
          segments: new Set(line.segmentIds.map((id) => pid.items[id]?.passthrough?.['dexpi:segment'])).size,
        })),
      ).toEqual(
        entry.lines.map((line) => ({
          lineNumber: line.lineNumber ?? null,
          fluidCode: line.fluidCode ?? null,
          pipingClass: line.pipingClass ?? null,
          dnText: line.nominalDiameter ?? null,
          segments: line.segments,
        })),
      );
      const instruments = items.flatMap((item) => (item.kind === 'instrument' ? [item] : []));
      expect(instruments.map((i) => [i.category, i.functions, i.loopNumber])).toEqual(
        entry.instrumentFunctions.map((f) => [f.category ?? '', f.functions ?? '', f.number ?? '']),
      );
      expect(items.flatMap((item) => (item.kind === 'loop' ? [item.tag] : []))).toEqual(entry.loops);
    },
  );

  it('imports all 11 files without DEXPI_UNMAPPED_CLASS (VC-PID-16)', () => {
    for (const entry of census.proteus13) {
      const result = data<{ warnings: Array<{ code: string }> }>(createEmptyDocument(), 'import_dexpi', { text: dexpiText(entry.file) });
      expect(
        result.warnings.filter((w) => w.code === 'DEXPI_UNMAPPED_CLASS'),
        entry.file,
      ).toEqual([]);
    }
  });
});

describe('import_dexpi on C01 (VC-PID-04)', () => {
  const pid = getPid(importFile(C01));
  const items = Object.values(pid.items);

  it('keeps tags, line numbers, DN, classes and instrument tags', () => {
    const tag = (kind: string): Array<string | undefined> => items.flatMap((i) => (i.kind === kind ? [i.tag] : []));
    expect(items.flatMap((i) => (i.kind === 'equipment' && i.parentId === undefined ? [i.tag] : []))).toEqual([
      'H1007',
      'H1008',
      'P4711',
      'P4712',
      'T4750',
    ]);
    expect(tag('instrument')).toEqual(['PI 4712.01', 'PICSA 4712.02', 'HS 4750.01', 'TICSA 4750.03']);
    const lines = items.flatMap((i) => (i.kind === 'line' ? [i] : []));
    expect(lines.map((l) => l.lineNumber)).toEqual([
      '47121',
      '47122',
      '47123',
      '47124',
      '47125',
      '47126',
      '47127',
      '47130',
      '47131',
      '47140',
      '47141',
    ]);
    expect(lines.find((l) => l.lineNumber === '47125')).toMatchObject({ dn: 25, pipingClass: '73HG12', fluidCode: 'MNc' });
    expect(new Set(lines.map((l) => l.dn))).toEqual(new Set([25, 50, 80]));
  });

  it('sets the valve operated flag, the actuating system and its controller, and the loop of every instrument', () => {
    const actuating = items.flatMap((i) => (i.kind === 'actuating' ? [i] : []));
    expect(actuating).toHaveLength(3);
    for (const system of actuating) {
      const valve = pid.items[system.valveId];
      expect(valve).toMatchObject({ kind: 'inline', operated: true });
      expect(pid.items[system.controllerId ?? '']?.kind).toBe('instrument');
    }
    expect(actuating.map((a) => a.failAction)).toEqual(expect.arrayContaining(['FC']));
    for (const instrument of items.flatMap((i) => (i.kind === 'instrument' ? [i] : [])))
      expect(pid.items[instrument.loopId ?? '']?.kind).toBe('loop');
  });

  it('puts every item on one sheet with a valid id scheme and records the import with its sha256 and census', () => {
    expect(pid.sheetOrder).toHaveLength(1);
    const sheet = pid.sheets[pid.sheetOrder[0] ?? ''];
    expect(sheet).toMatchObject({ number: 'PID-001', status: 'draft', paper: expect.stringMatching(/^A[0-4]$/) });
    expect(items.every((i) => i.sheetId === sheet?.id && /^pid-\d+\.\d+$/.test(i.id))).toBe(true);
    expect(pid.imports).toHaveLength(1);
    expect(pid.imports?.[0]).toMatchObject({
      format: 'dexpi-proteus',
      version: '1.3',
      sha256: census.proteus13[0]?.sha256,
      sheetId: sheet?.id,
      census: { connections: 29, danglingConnections: 0, shapeCatalogueEntries: 24 },
    });
  });
});
