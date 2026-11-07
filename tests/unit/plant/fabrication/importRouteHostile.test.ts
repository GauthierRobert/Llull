/**
 * Plant 05 ISO M6c: hostile PCF text through the new route-mode branches (eccentric reducers, caps, blind flanges, flanged joints, instruments). The PCF is external text:
 * whatever the geometry, `import_pcf as route` must not throw and must either build a line or refuse with the document unchanged and a coded error.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { cs150Document } from '../piping/rteFixtures';
import { extrasDocument } from './routeExtraFixtures';

const HEADER = 'ISOGEN-FILES ISOGEN.FLS\nUNITS-BORE MM\nUNITS-CO-ORDS MM\nPIPELINE-REFERENCE H-1\n    PIPING-SPEC CS150\n';
const record = (type: string, id: number, ends: string[], extra = ''): string =>
  `${type}\n    COMPONENT-IDENTIFIER ${id}\n${ends.map((end) => `    END-POINT ${end}\n`).join('')}${extra}`;
const pipe = (id: number, a: string, b: string, bore = 100): string => record('PIPE', id, [`${a} ${bore} BW`, `${b} ${bore} BW`]);

const cases: Record<string, string> = {
  'an eccentric reducer alone': HEADER + record('REDUCER-ECCENTRIC', 1, ['0.0 0.0 0.0 150 BW', '140.0 0.0 27.0 100 BW']),
  'a reducer whose two bores are equal':
    HEADER + pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') + record('REDUCER-ECCENTRIC', 2, ['1000.0 0.0 0.0 100 BW', '1140.0 0.0 10.0 100 BW']),
  'a reducer with both ends at one point':
    HEADER + pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') + record('REDUCER-ECCENTRIC', 2, ['1000.0 0.0 0.0 150 BW', '1000.0 0.0 0.0 100 BW']),
  'a reducer with a huge offset':
    HEADER +
    pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0', 150) +
    record('REDUCER-ECCENTRIC', 2, ['1000.0 0.0 0.0 150 BW', '1140.0 0.0 900000.0 100 BW']) +
    pipe(3, '1140.0 0.0 900000.0', '3000.0 0.0 900000.0'),
  'a reducer with a diagonal offset and a skew next leg':
    HEADER +
    pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0', 150) +
    record('REDUCER-ECCENTRIC', 2, ['1000.0 0.0 0.0 150 BW', '1140.0 20.0 20.0 100 BW']) +
    record('ELBOW', 3, ['1140.0 20.0 20.0 100 BW', '1300.0 20.0 180.0 100 BW'], '    CENTRE-POINT 1300.0 20.0 20.0\n'),
  'a cap alone': HEADER + record('CAP', 1, ['0.0 0.0 0.0 100 BW']),
  'a cap at a point no pipe reaches': HEADER + pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') + record('CAP', 2, ['5000.0 0.0 0.0 100 BW']),
  'two caps on one pipe end':
    HEADER +
    pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
    record('CAP', 2, ['1000.0 0.0 0.0 100 BW']) +
    record('CAP', 3, ['1000.0 0.0 0.0 100 BW']),
  'a cap whose closed end is the pipe start':
    HEADER + pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') + record('CAP', 2, ['0.0 0.0 0.0 100 BW', '-64.0 0.0 0.0 100 BW']),
  'a blind flange alone': HEADER + record('FLANGE-BLIND', 1, ['0.0 0.0 0.0 100 FL']),
  'a blind flange against a flange without a pipe':
    HEADER +
    record('FLANGE', 1, ['0.0 0.0 0.0 100 BW', '76.0 0.0 0.0 100 FL']) +
    record('FLANGE-BLIND', 2, ['76.0 0.0 0.0 100 FL', '98.4 0.0 0.0 100 FL']),
  'a flange joined to itself':
    HEADER + pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') + record('FLANGE', 2, ['1000.0 0.0 0.0 100 BW', '1000.0 0.0 0.0 100 FL']),
  'two flanges back to back with no pipe either side':
    HEADER +
    record('FLANGE', 1, ['0.0 0.0 0.0 100 BW', '76.0 0.0 0.0 100 FL']) +
    record('FLANGE', 2, ['76.0 0.0 0.0 100 FL', '152.0 0.0 0.0 100 BW']),
  'an instrument of zero length':
    HEADER +
    pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
    record('INSTRUMENT', 2, ['1000.0 0.0 0.0 100 BW', '1000.0 0.0 0.0 100 BW']) +
    pipe(3, '1000.0 0.0 0.0', '2000.0 0.0 0.0'),
  'an instrument off the pipe axis':
    HEADER +
    pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
    record('INSTRUMENT', 2, ['1000.0 0.0 0.0 100 BW', '1300.0 200.0 0.0 100 BW']) +
    pipe(3, '1300.0 200.0 0.0', '2000.0 200.0 0.0'),
  'an instrument of astronomic length':
    HEADER + pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') + record('INSTRUMENT', 2, ['1000.0 0.0 0.0 100 BW', '1e300 0.0 0.0 100 BW']),
  'a flanged instrument against a blind flange':
    HEADER +
    record('FLANGE', 1, ['0.0 0.0 0.0 100 BW', '76.0 0.0 0.0 100 FL']) +
    record('INSTRUMENT', 2, ['76.0 0.0 0.0 100 FL', '376.0 0.0 0.0 100 FL']) +
    record('FLANGE-BLIND', 3, ['376.0 0.0 0.0 100 FL']),
};

describe('hostile PCF through the route-mode fittings', () => {
  for (const [name, text] of Object.entries(cases)) {
    for (const [label, doc] of [
      ['CS150', cs150Document()],
      ['CS150 + cap / blind rows', extrasDocument()],
    ] as const) {
      it(`${name} (${label}): never throws; a built line or a coded refusal with the document unchanged`, () => {
        const result = execute(doc, 'import_pcf', { text, as: 'route', spec: 'CS150', eccentricFlat: 'top' });
        if (result.rejected === true) {
          expect(result.document).toBe(doc);
          expect(result.affected).toEqual([]);
          expect(result.error?.code).toMatch(/^(ISO|RTE|PSC)_/);
        } else expect(result.affected.length).toBeGreaterThan(0);
        const preview = execute(doc, 'import_pcf', { text, as: 'route', spec: 'CS150', preview: true });
        expect(preview.document).toBe(doc);
      });
    }
  }
});
