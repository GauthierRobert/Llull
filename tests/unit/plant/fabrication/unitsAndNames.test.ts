/**
 * Plant 05 ISO M1 review round 2: the verbatim-units guard only concerns imported lines and length-bearing attributes; file names clash on their sanitized
 * stem; a legacy pipe on a vanished level is flagged; lineIdOverride is trimmed.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { legacyNetwork } from '@aec/plant/fabrication/legacyNetwork';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Document, routedPumpToVesselWithTee } from '../piping/rteFixtures';
import { fixturePcf } from './fabricationFixtures';

const exported = (doc: CadDocument, params: Record<string, unknown>): string =>
  data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', params).files[0]?.content ?? '';

describe('unit changes and verbatim attributes', () => {
  it('a routed line with a valve (SPINDLE-DIRECTION in extra) exports in inches', () => {
    const scene = routedPumpToVesselWithTee();
    const valve = apply(scene.doc, 'insert_inline_component', {
      runId: scene.runId,
      type: 'valveGate',
      tag: 'XV-1001',
      at: { leg: 3, centreDistance: 800 },
      stemDirection: [0, -1, 0],
    });
    const text = exported(valve, { units: 'inch' });
    expect(text).toContain('UNITS-CO-ORDS INCH');
    expect(text).toContain('SPINDLE-DIRECTION SOUTH');
  });

  it('an imported line whose only extras carry no length converts; one with a length-bearing extra is refused', () => {
    const quiet = fixturePcf().replace(
      '    SKEY FLWN\n    ITEM-CODE FLWN-100-150',
      '    SPINDLE-DIRECTION UP\n    SPECIAL-FLAG\n    SKEY FLWN\n    ITEM-CODE FLWN-100-150',
    );
    const stored = apply(createEmptyDocument(), 'import_pcf', { text: quiet });
    expect(exported(stored, { units: 'inch' })).toContain('SPINDLE-DIRECTION UP\n    SPECIAL-FLAG\n');
    const loud = apply(createEmptyDocument(), 'import_pcf', {
      text: fixturePcf().replace(
        '    SKEY FLWN\n    ITEM-CODE FLWN-100-150',
        '    COMPONENT-ATTRIBUTE1 12.5\n    SKEY FLWN\n    ITEM-CODE FLWN-100-150',
      ),
    });
    expectRefusal(loud, 'export_pcf', { units: 'inch' }, 'ISO_PCF_UNITS_VERBATIM');
  });
});

describe('file names', () => {
  it('lines whose names sanitize to the same file (L/100 and L_100) are refused', () => {
    const first = apply(createEmptyDocument(), 'import_pcf', { text: fixturePcf().replace('L-101', 'L/100') });
    const both = apply(first, 'import_pcf', { text: fixturePcf().replace('L-101', 'L_100') });
    const result = expectRefusal(both, 'export_pcf', {}, 'ISO_LINE_DUPLICATE');
    expect(result.summary).toContain('L_100.pcf');
  });

  it('lineIdOverride is trimmed before it becomes the line id', () => {
    const stored = apply(createEmptyDocument(), 'import_pcf', { text: fixturePcf(), lineIdOverride: '  X-1  ' });
    expect(Object.keys(stored.plant?.fabrication?.pcfLines ?? {})).toEqual(['X-1']);
  });
});

describe('legacy pipe on a vanished level', () => {
  it('is flagged ISO_LEVEL_MISSING (elevation 0 assumed) and still exported', () => {
    const pipe = ok(cs150Document(), 'add_pipe_run', {
      points: [
        [0, 0, 500],
        [2000, 0, 500],
      ],
      dn: 100,
      line: 'V-1',
    });
    const building = pipe.document.building;
    if (building === undefined) throw new Error('no building');
    const levelId = Object.keys(building.levels)[0] as string;
    const { [levelId]: gone, ...levels } = building.levels;
    void gone;
    const orphaned: CadDocument = { ...pipe.document, building: { ...building, levels } };
    const net = legacyNetwork(orphaned, 'V-1');
    expect(net?.warnings.map((warning) => warning.code)).toContain('ISO_LEVEL_MISSING');
    expect(net?.components[0]?.ends[0]?.xyz[2]).toBe(500);
    expect(legacyNetwork(pipe.document, 'V-1')?.warnings.map((warning) => warning.code)).not.toContain('ISO_LEVEL_MISSING');
    expect(data<{ count: number }>(orphaned, 'export_pcf', {}).count).toBe(1);
  });
});
