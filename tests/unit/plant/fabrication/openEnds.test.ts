/** ISO-M6 follow-up: export_pcf openEnds on imported and legacy lines, and the imported line numbers that create_pipeline / add_pipe_run refuse. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { cs150Document } from '../piping/rteFixtures';
import { fixturePcf } from './fabricationFixtures';
import { loadedL101 } from './isoM2Fixtures';

type OpenEnds = Array<{ partId: string; position: number[]; dn: number }>;
const openEndsOf = (doc: Parameters<typeof data>[0], lineId: string): OpenEnds =>
  data<{ files: Array<{ openEnds: OpenEnds }> }>(doc, 'export_pcf', { lineIds: [lineId] }).files[0]?.openEnds ?? [];

describe('export_pcf openEnds on an imported line', () => {
  it('lists the points no other component meets: the line start, the main end and the branch end', () => {
    const ends = openEndsOf(loadedL101(), 'L-101');
    expect(ends.map((end) => end.position)).toEqual([
      [0, 0, 3000],
      [8000, 4000, 1000],
      [7105, 4000, 1500],
    ]);
    expect(ends.every((end) => end.dn === 100 && end.partId.startsWith('pcf:L-101:'))).toBe(true);
  });

  it('a gap in the line adds the free points on both sides', () => {
    const text = fixturePcf().replace(/(PIPE\n    COMPONENT-IDENTIFIER 6\n    END-POINT )5000\.0 152\.0 3000\.0/, '$15000.0 400.0 3000.0');
    expect(text).not.toBe(fixturePcf());
    expect(openEndsOf(apply(createEmptyDocument(), 'import_pcf', { text }), 'L-101').length).toBeGreaterThan(3);
  });
});

describe('export_pcf openEnds on a legacy line', () => {
  const base = apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });
  const doc = apply(base, 'add_pipe_run', {
    points: [
      [0, 0, 1000],
      [6000, 0, 1000],
      [6000, 4000, 1000],
    ],
    dn: 100,
    line: 'L-9',
  });

  it('lists the two free ends of the run (the derived elbow is connected)', () => {
    const ends = openEndsOf(doc, 'L-9');
    expect(ends).toHaveLength(2);
    expect(ends.map((end) => end.position)).toEqual([
      [0, 0, 1000],
      [6000, 4000, 1000],
    ]);
  });
});

describe('create_pipeline and add_pipe_run refuse the number of an imported line', () => {
  const imported = apply(cs150Document(), 'import_pcf', { text: fixturePcf() });

  it('create_pipeline with lineNumber L-101 is RTE_DUPLICATE_LINE_NUMBER, not an export failure later', () => {
    expectRefusal(
      imported,
      'create_pipeline',
      { service: 'P', sequence: '9001', spec: 'CS150', dn: 100, lineNumber: 'L-101' },
      'RTE_DUPLICATE_LINE_NUMBER',
      'lineNumber',
    );
    const free = apply(imported, 'create_pipeline', { service: 'P', sequence: '9001', spec: 'CS150', dn: 100, lineNumber: 'L-102' });
    expect(free).not.toBe(imported);
  });

  it('add_pipe_run with line L-101 is refused; another number is accepted', () => {
    const grade = apply(imported, 'add_level', { name: 'Grade', elevation: 0 });
    const points = [
      [0, 0, 1000],
      [3000, 0, 1000],
    ];
    expectRefusal(grade, 'add_pipe_run', { points, dn: 100, line: 'L-101' }, 'RTE_DUPLICATE_LINE_NUMBER', 'line');
    expect(apply(grade, 'add_pipe_run', { points, dn: 100, line: 'L-102' })).not.toBe(grade);
  });
});
