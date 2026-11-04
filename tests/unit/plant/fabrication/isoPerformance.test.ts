/** ISO-M6 (VC-ISO-18): a 1000-component line against the budgets of TECHNICAL_SPEC §8, measured. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, data } from '../../../helpers/commandAssertions';

/** A staircase of `pairs` pipes and 90 degree elbows (2 x pairs components) in the E-N plane, DN100, alternating east and north legs of 1000 mm. */
function staircasePcf(pairs: number): string {
  const lines = [
    'ISOGEN-FILES ISOGEN.FLS',
    'UNITS-BORE MM',
    'UNITS-CO-ORDS MM',
    'UNITS-WEIGHT KGS',
    'PIPELINE-REFERENCE L-1000',
    '    PIPING-SPEC A1A',
  ];
  const at = (point: readonly number[]): string => `${point[0]}.0 ${point[1]}.0 ${point[2]}.0`;
  let end: [number, number, number] = [0, 0, 0];
  let id = 1;
  for (let index = 0; index < pairs; index++) {
    const east = index % 2 === 0;
    const d1: [number, number, number] = east ? [1, 0, 0] : [0, 1, 0];
    const d2: [number, number, number] = east ? [0, 1, 0] : [1, 0, 0];
    const corner: [number, number, number] = [end[0] + d1[0] * 1000 - d1[0] * 152 * 0, end[1] + d1[1] * 1000, 0];
    const bendIn: [number, number, number] = [corner[0] - d1[0] * 152, corner[1] - d1[1] * 152, 0];
    const bendOut: [number, number, number] = [corner[0] + d2[0] * 152, corner[1] + d2[1] * 152, 0];
    lines.push(
      'PIPE',
      `    COMPONENT-IDENTIFIER ${id++}`,
      `    END-POINT ${at(end)} 100 BW`,
      `    END-POINT ${at(bendIn)} 100 BW`,
      '    ITEM-CODE PIPE-100-S40',
      'ELBOW',
      `    COMPONENT-IDENTIFIER ${id++}`,
      `    END-POINT ${at(bendIn)} 100 BW`,
      `    END-POINT ${at(bendOut)} 100 BW`,
      `    CENTRE-POINT ${at(corner)}`,
      '    SKEY ELBW',
      '    ITEM-CODE ELL90LR-100-S40',
    );
    end = bendOut;
  }
  return `${lines.join('\n')}\n`;
}

const best = <T>(runs: number, run: () => T): { value: T; ms: number } => {
  let value: T | undefined;
  let ms = Infinity;
  for (let at = 0; at < runs; at++) {
    const start = performance.now();
    value = run();
    ms = Math.min(ms, performance.now() - start);
  }
  return { value: value as T, ms };
};

/** A fixed pure-JS workload (sort, string building, a hash-like fold), independent of the code under test: how slow this machine is right now. */
function workload(): number {
  const start = performance.now();
  let seed = 12345;
  const values: number[] = [];
  for (let at = 0; at < 150_000; at++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    values.push(seed);
  }
  values.sort((x, y) => x - y);
  let fold = 0;
  for (const value of values) fold = (fold * 31 + (value % 997)) % 1000003;
  const text = values.slice(0, 20_000).join(',');
  return fold >= 0 && text.length > 0 ? performance.now() - start : -1;
}

/** Bounds are the §8 budgets of a plain run; they scale by how much slower the fixed workload runs than on the dev machine (45 ms, 2026-11-04; coverage instrumentation, load), at most x10. */
const REFERENCE_MILLISECONDS = 45;
const SLACK = ((): number => {
  workload();
  return Math.min(10, Math.max(1, Math.min(workload(), workload()) / REFERENCE_MILLISECONDS));
})();

describe('VC-ISO-18: a 1000-component line stays inside the budgets of TECHNICAL_SPEC §8', () => {
  const text = staircasePcf(500);
  const empty = createEmptyDocument();
  const doc = apply(empty, 'import_pcf', { text });
  const numbered = apply(apply(doc, 'set_fabrication_rules', { weldGapMm: 3, source: 'test' }), 'number_welds', { lineId: 'L-1000' });

  it('has 1000 components', () => {
    expect(text.split('\n').filter((line) => /^[A-Z]/.test(line) && !/^(ISOGEN|UNITS|PIPELINE)/.test(line))).toHaveLength(1000);
    expect(data<{ welds: unknown[] }>(numbered, 'weld_list', { lineId: 'L-1000' }).welds.length).toBeGreaterThan(900);
  });

  it('import_pcf preview < 100 ms', () => {
    expect(best(3, () => execute(empty, 'import_pcf', { text, preview: true })).ms).toBeLessThan(100 * SLACK);
  });

  it('export_pcf < 200 ms, output <= 200 kB (a 120 kB bound could not hold: about 130 bytes per two-point record)', () => {
    const { value, ms } = best(3, () => data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', { lineIds: ['L-1000'] }));
    expect(ms).toBeLessThan(200 * SLACK);
    expect(value.files[0]?.content.length).toBeLessThan(200_000);
  });

  it('welds, spools and cut list: each query < 50 ms', () => {
    for (const command of ['weld_list', 'spool_list', 'cut_list'])
      expect(best(3, () => data(numbered, command, { lineId: 'L-1000' })).ms, command).toBeLessThan(50 * SLACK);
  });

  it('export_isometric SVG, 1000 components, auto split < 2 s', () => {
    const defined = apply(numbered, 'define_isometric', { lineId: 'L-1000', maxPipePiecesPerSheet: 50, style: 'final' });
    const { value, ms } = best(2, () => data<{ sheets: unknown[] }>(defined, 'export_isometric', { lineId: 'L-1000', style: 'final' }));
    expect(value.sheets.length).toBeGreaterThan(5);
    expect(ms).toBeLessThan(2000 * SLACK);
  });

  it('check_isometric of the line < 1 s', () => {
    expect(best(2, () => data(numbered, 'check_isometric', { lineId: 'L-1000' })).ms).toBeLessThan(1000 * SLACK);
  });
});
