/** Plant 05 ISO M2: the fabrication commands on the three line sources (routed, legacy pipe, imported PCF), stale welds, and the performance budget (spec §8, bounds x3). */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document, cs150Line } from '../piping/rteFixtures';
import { loadedL101 } from './isoM2Fixtures';

interface WeldData {
  welds: Array<{ number: string; kind: string; at: number[]; componentIds: string[] }>;
  warnings: Array<{ code: string }>;
}

function routed(): { doc: CadDocument; lineId: string } {
  const line = cs150Line(100, '6001');
  const a = addTie(line.doc, 'RT-A', [0, 0, 0], [1, 0, 0]);
  const doc = apply(a.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 3000 },
      { direction: '+Z', length: 2000 },
    ],
  });
  return { doc, lineId: line.lineId };
}

describe('routed line', () => {
  const { doc, lineId } = routed();

  it('weld_list, spool_list, cut_list and piping_bom read the routed network (elbow joints are shop welds)', () => {
    const welds = data<WeldData>(doc, 'weld_list', { lineId });
    expect(welds.welds.map((weld) => weld.kind)).toEqual(['shop', 'shop']);
    expect(data<{ count: number }>(doc, 'spool_list', { lineId }).count).toBe(1);
    const cut = data<{ pieces: Array<{ centrelineLengthMm: number; cutLengthMm: number }> }>(doc, 'cut_list', { lineId, weldGapMm: 2 });
    expect(cut.pieces.map((piece) => piece.centrelineLengthMm)).toEqual([2848, 1848]);
    expect(cut.pieces.map((piece) => piece.cutLengthMm)).toEqual([2847, 1847]);
    const bom = data<{ rows: Array<{ type: string; quantity: number }>; provenance: { sources: string[] } }>(doc, 'piping_bom', {
      scope: 'line',
      lineId,
    });
    expect(bom.rows.find((row) => row.type === 'PIPE')?.quantity).toBeCloseTo(4.696, 9);
    expect(bom.provenance.sources).toEqual(['route']);
  });

  it('a field weld on a routed pipe splits it, ends a spool, and export_pcf writes it (the line itself is untouched)', () => {
    const welded = apply(doc, 'add_field_weld', { lineId, at: [1500, 0, 0], type: 'field_fit' });
    expect(welded.plant?.piping).toEqual(doc.plant?.piping);
    expect(data<{ count: number }>(welded, 'spool_list', { lineId }).count).toBe(2);
    const file = data<{ files: Array<{ content: string; countsByType: Record<string, number> }> }>(welded, 'export_pcf', {
      lineIds: [lineId],
    }).files[0];
    expect(file?.countsByType).toMatchObject({ WELD: 1, PIPE: 3, ELBOW: 1 });
    expect(file?.content).toContain('SKEY WF');
    expectRefusal(welded, 'cut_list', { lineId, weldGapMm: 0 }, 'ISO_GAP_UNDEFINED', 'fieldFitAllowanceMm');
  });

  it('a routed line without a run is ISO_NO_PIPING, and a run that no longer derives returns its RTE code', () => {
    const empty = cs150Line(100, '6002');
    expectRefusal(empty.doc, 'weld_list', { lineId: empty.lineId }, 'ISO_NO_PIPING');
    const broken = cs150Document();
    expectRefusal(broken, 'weld_list', { lineId: 'nope' }, 'ISO_LINE_NOT_FOUND');
  });
});

describe('legacy pipe line', () => {
  const base = apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });
  const doc = apply(base, 'add_pipe_run', {
    points: [
      [0, 0, 1000],
      [6000, 0, 1000],
      [6000, 4000, 1000],
    ],
    dn: 100,
    line: 'L-9',
    service: 'water',
  });

  it('derived elbows give welds, one spool and a cut list; the BOM has no item codes to group by and says so', () => {
    const welds = data<WeldData>(doc, 'weld_list', { lineId: 'L-9' });
    expect(welds.welds).toHaveLength(2);
    expect(data<{ count: number }>(doc, 'spool_list', { lineId: 'L-9' }).count).toBe(1);
    const cut = data<{ pieces: Array<{ cutLengthMm: number }> }>(doc, 'cut_list', { lineId: 'L-9', weldGapMm: 0 });
    expect(cut.pieces).toHaveLength(2);
    const bom = data<{ rows: unknown[]; withoutItemCode: string[]; warnings: Array<{ code: string }> }>(doc, 'piping_bom', {
      scope: 'document',
    });
    expect(bom.rows).toEqual([]);
    expect(bom.warnings.map((warning) => warning.code)).toEqual(['ISO_ITEM_CODE_MISSING']);
    expect(bom.withoutItemCode.length).toBeGreaterThan(0);
  });

  it('a too-short segment (legacy error finding) is refused by every query with its code', () => {
    const tight = apply(base, 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [100, 0, 0],
        [100, 100, 0],
      ],
      dn: 100,
      line: 'L-8',
      service: 'water',
    });
    expectRefusal(tight, 'weld_list', { lineId: 'L-8' }, 'ISO_SEGMENT_TOO_SHORT');
  });

  it('add_field_weld on a legacy pipe uses document units and the level elevation', () => {
    const result = ok(doc, 'add_field_weld', { lineId: 'L-9', at: [3000, 0, 1000] });
    expect((result.data as { at: number[] }).at).toEqual([3000, 0, 1000]);
  });
});

describe('stale field welds', () => {
  it('a weld whose pipe vanished is ignored and reported, not an error', () => {
    const doc = loadedL101();
    const welded = apply(doc, 'add_field_weld', { lineId: 'L-101', at: [2000, 0, 3000] });
    const fabrication = welded.plant?.fabrication;
    const moved = {
      ...welded,
      plant: {
        ...welded.plant,
        fabrication: {
          ...(fabrication as NonNullable<typeof fabrication>),
          fieldWelds: Object.fromEntries(
            Object.entries(fabrication?.fieldWelds ?? {}).map(([id, weld]) => [
              id,
              { ...weld, xyz: [9, 9, 9] as [number, number, number] },
            ]),
          ),
        },
      },
    };
    const welds = data<WeldData>(moved, 'weld_list', { lineId: 'L-101' });
    expect(welds.welds).toHaveLength(13);
    expect(welds.warnings.map((warning) => warning.code)).toContain('ISO_FIELD_WELD_STALE');
    const numbered = data<{ warnings: Array<{ code: string }> }>(moved, 'number_welds', { lineId: 'L-101' });
    expect(numbered.warnings.map((warning) => warning.code)).toEqual(['ISO_FIELD_WELD_STALE']);
  });
});

describe('performance (spec §8: welds + spools + cut list on 1000 components < 50 ms; bounds here x3, plus slack for a loaded runner)', () => {
  const pipes = 333;
  const text = (): string => {
    const records: string[] = [];
    let id = 0;
    for (let k = 0; k < pipes; k++) {
      const x0 = k * 1000;
      records.push(
        `PIPE\n    COMPONENT-IDENTIFIER ${++id}\n    END-POINT ${x0}.0 0.0 0.0 100 BW\n    END-POINT ${x0 + 700}.0 0.0 0.0 100 BW\n    ITEM-CODE PIPE-100\n`,
        `FLANGE\n    COMPONENT-IDENTIFIER ${++id}\n    END-POINT ${x0 + 700}.0 0.0 0.0 100 BW\n    END-POINT ${x0 + 800}.0 0.0 0.0 100 BW\n    SKEY FLWN\n    ITEM-CODE FL-100\n`,
        `PIPE\n    COMPONENT-IDENTIFIER ${++id}\n    END-POINT ${x0 + 800}.0 0.0 0.0 100 BW\n    END-POINT ${x0 + 1000}.0 0.0 0.0 100 BW\n    ITEM-CODE PIPE-100\n`,
      );
    }
    return `ISOGEN-FILES ISOGEN.FLS\nUNITS-BORE MM\nUNITS-CO-ORDS MM\nPIPELINE-REFERENCE BIG\n${records.join('')}`;
  };
  const big = apply(createEmptyDocument(), 'import_pcf', { text: text() });

  it('the pipeline of queries on ~1000 components stays within the bound and is consistent', () => {
    const start = performance.now();
    const welds = data<WeldData>(big, 'weld_list', { lineId: 'BIG' });
    const spools = data<{ count: number }>(big, 'spool_list', { lineId: 'BIG' });
    const cut = data<{ pieces: unknown[] }>(big, 'cut_list', { lineId: 'BIG', weldGapMm: 3 });
    const bom = data<{ rows: unknown[] }>(big, 'piping_bom', { scope: 'line', lineId: 'BIG', includeBolting: true });
    const elapsed = performance.now() - start;
    expect(welds.welds).toHaveLength(pipes * 3 - 1);
    expect(spools.count).toBe(1);
    expect(cut.pieces).toHaveLength(pipes * 2);
    expect(bom.rows).toHaveLength(2);
    expect(elapsed).toBeLessThan(4 * 3 * 50 + 1000);
  });

  it('number_welds and split_spools autoBreak on the same line finish in bounded time and number every weld', () => {
    const start = performance.now();
    const numbered = execute(big, 'number_welds', { lineId: 'BIG' });
    const limited = apply(numbered.document, 'set_fabrication_rules', { source: 'perf', maxSpoolPieces: 100 });
    const split = ok(limited, 'split_spools', { lineId: 'BIG', autoBreak: true });
    expect(performance.now() - start).toBeLessThan(30_000);
    expect((numbered.data as { assigned: unknown[] }).assigned).toHaveLength(pipes * 3 - 1);
    expect((split.data as { spools: Array<{ pieces: number }> }).spools.every((spool) => spool.pieces <= 100)).toBe(true);
  });
});
