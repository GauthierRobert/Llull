/**
 * Plant 05 ISO M1 review fixes: one PIPELINE-REFERENCE per exported file across routed, imported and legacy lines (a clash is refused, both owners named),
 * legacy pipes in a non-mm document, error findings refuse the export, no butt-weld key is inferred for small bore.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { legacyNetwork } from '@aec/plant/fabrication/legacyNetwork';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document } from '../piping/rteFixtures';
import { fixturePcf } from './fabricationFixtures';

/** CS150 document with a routed line whose line number is `lineNumber` (id line-1). */
function routedLine(lineNumber: string, base: CadDocument = cs150Document()): CadDocument {
  const created = apply(base, 'create_pipeline', { service: 'P', sequence: '9001', spec: 'CS150', dn: 100, lineNumber });
  const lineId = created.plant?.piping?.lineOrder.at(-1) as string;
  const a = addTie(created, `T-${lineNumber}`, [0, 0, 0], [1, 0, 0]);
  return apply(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 3000 }] });
}

const legacyPipe = (base: CadDocument, line: string): CadDocument =>
  ok(base, 'add_pipe_run', {
    points: [
      [0, 5000, 0],
      [2000, 5000, 0],
    ],
    dn: 100,
    line,
    service: 'water',
  }).document;

describe('export_pcf: one file per PIPELINE-REFERENCE', () => {
  it('an imported line and a routed line with the same number are refused, both owners named', () => {
    const imported = apply(cs150Document(), 'import_pcf', { text: fixturePcf().replace('L-101', 'L-100') });
    const both = routedLine('L-100', imported);
    const result = expectRefusal(both, 'export_pcf', {}, 'ISO_LINE_DUPLICATE', 'lineIds');
    expect(result.summary).toContain('routed line');
    expect(result.summary).toContain('imported line L-100');
    expect(result.error?.ids).toHaveLength(2);
  });

  it('an imported line and a legacy pipe line with the same number are refused instead of dropping the pipe', () => {
    const imported = apply(cs150Document(), 'import_pcf', { text: fixturePcf().replace('L-101', 'L-100') });
    const both = legacyPipe(imported, 'L-100');
    const result = expectRefusal(both, 'export_pcf', {}, 'ISO_LINE_DUPLICATE');
    expect(result.summary).toContain('legacy pipe line L-100');
    expectRefusal(both, 'export_pcf', { lineIds: ['L-100'] }, 'ISO_LINE_DUPLICATE');
  });

  it('a routed line and a legacy pipe line with the same number are refused', () => {
    const both = legacyPipe(routedLine('L-7'), 'L-7');
    expectRefusal(both, 'export_pcf', {}, 'ISO_LINE_DUPLICATE');
  });

  it('distinct numbers export together', () => {
    const mixed = legacyPipe(routedLine('L-7'), 'L-8');
    expect(data<{ count: number }>(mixed, 'export_pcf', {}).count).toBe(2);
  });
});

describe('legacy pipes in a document that is not in mm', () => {
  const metres = apply(createEmptyDocument(), 'set_units', { units: 'm' });
  const pipe = ok(metres, 'add_pipe_run', {
    points: [
      [0, 0, 0],
      [2, 0, 0],
      [2, 3, 0],
    ],
    dn: 100,
    line: 'M-1',
    service: 'water',
  });

  it('points and elevations are converted to mm before the bend radius (mm) is applied', () => {
    const net = legacyNetwork(pipe.document, 'M-1');
    expect(net?.components.map((component) => component.type)).toEqual(['PIPE', 'ELBOW', 'PIPE']);
    expect(net?.components[0]?.ends[1]?.xyz).toEqual([1847.6, 0, 0]);
    expect(net?.components[1]?.centre).toEqual([2000, 0, 0]);
    expect(net?.components[2]?.ends[1]?.xyz).toEqual([2000, 3000, 0]);
  });

  it('the exported file is in mm', () => {
    const file = data<{ files: Array<{ content: string }> }>(pipe.document, 'export_pcf', {}).files[0];
    expect(file?.content).toContain('UNITS-CO-ORDS MM');
    expect(file?.content).toContain('END-POINT 2000.0 3000.0 0.0 100 BW');
  });

  it('a level elevation in feet converts too', () => {
    const feet = apply(createEmptyDocument(), 'set_units', { units: 'ft' });
    const levelled = apply(feet, 'add_level', { name: 'Up', elevation: 10, height: 10, makeActive: true });
    const made = ok(levelled, 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [10, 0, 0],
      ],
      dn: 100,
      line: 'F-1',
      service: 'water',
    });
    expect(legacyNetwork(made.document, 'F-1')?.components[0]?.ends.map((end) => end.xyz)).toEqual([
      [0, 0, 3048],
      [3048, 0, 3048],
    ]);
  });
});

describe('legacy findings and keys', () => {
  it('an error finding (bends closer than their centre-to-ends) refuses the export with its code', () => {
    const short = ok(cs150Document(), 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [1000, 0, 0],
        [1000, 200, 0],
        [2000, 200, 0],
      ],
      dn: 100,
      line: 'S-1',
    });
    const result = expectRefusal(short.document, 'export_pcf', {}, 'ISO_SEGMENT_TOO_SHORT');
    expect(result.error?.ids.length).toBeGreaterThan(0);
  });

  it('no butt weld is inferred below DN50: the elbow has no SKEY and is listed in missingSkey', () => {
    const small = ok(cs150Document(), 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [1000, 0, 0],
        [1000, 1000, 0],
      ],
      dn: 25,
      line: 'N-1',
    });
    const file = data<{ files: Array<{ missingSkey: string[]; content: string }> }>(small.document, 'export_pcf', {}).files[0];
    expect(file?.missingSkey).toEqual([`${small.affected[0]}/elbow-1`]);
    expect(file?.content).not.toContain('SKEY');
    const big = ok(cs150Document(), 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [1000, 0, 0],
        [1000, 1000, 0],
      ],
      dn: 50,
      line: 'N-2',
    });
    expect(legacyNetwork(big.document, 'N-2')?.components[1]?.skey).toBe('ELBW');
  });
});
