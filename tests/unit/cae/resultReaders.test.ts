import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDat } from '@cae/results/datReader';
import { parseFrd } from '@cae/results/frdReader';

const fixture = (name: string): string => readFileSync(`tests/unit/cae/fixtures/${name}`, 'utf8');

describe('parseFrd on real CalculiX 2.21 output', () => {
  it('reads a static run: DISP, STRESS and TOSTRAIN at the written node values', () => {
    const steps = parseFrd(fixture('static.frd'));
    expect(steps).toHaveLength(1);
    const [step] = steps;
    expect(step?.step).toBe(1);
    expect(step?.time).toBe(1);
    expect(Object.keys(step?.fields ?? {})).toEqual(['DISP', 'STRESS', 'TOSTRAIN']);
    expect(step?.fields.DISP?.components).toEqual(['D1', 'D2', 'D3']);
    expect(step?.fields.STRESS?.components).toEqual(['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX']);
    expect(Object.keys(step?.fields.DISP?.values ?? {})).toHaveLength(8);
    expect(step?.fields.DISP?.values['2']?.[0]).toBeCloseTo(0.002, 12);
    expect(step?.fields.DISP?.values['3']?.[1]).toBeCloseTo(-3e-4, 12);
    // adjacent 12-character cells without a blank between them are split by column
    expect(step?.fields.DISP?.values['2']?.[1]).toBeCloseTo(-1.31024e-19, 24);
    expect(step?.fields.DISP?.values['2']?.[2]).toBeCloseTo(-4.32927e-19, 24);
    expect(step?.fields.STRESS?.values['5']?.[0]).toBeCloseTo(210, 9);
    expect(step?.fields.STRESS?.values['1']?.[5]).toBeCloseTo(-1.81744e-14, 19);
    expect(step?.fields.TOSTRAIN?.values['4']?.[0]).toBeCloseTo(1e-3, 12);
    expect(step?.fields.ERROR).toBeUndefined();
  });

  it('reads a steady heat run: NDTEMP, FLUX and RFL', () => {
    const [step] = parseFrd(fixture('heat.frd'));
    expect(Object.keys(step?.fields ?? {})).toEqual(['NDTEMP', 'FLUX', 'RFL']);
    expect(step?.fields.NDTEMP?.components).toEqual(['T']);
    expect(step?.fields.NDTEMP?.values['1']).toEqual([100]);
    expect(step?.fields.NDTEMP?.values['2']).toEqual([20]);
    expect(step?.fields.FLUX?.components).toEqual(['F1', 'F2', 'F3']);
    expect(step?.fields.FLUX?.values['1']?.[0]).toBeCloseTo(2000, 6);
    expect(step?.fields.RFL?.values['1']?.[0]).toBeCloseTo(666.667, 3);
    expect(step?.fields.RFL?.values['2']?.[0]).toBeCloseTo(-666.667, 3);
  });

  it('reads a transient series: one entry per increment with the cumulative time', () => {
    const steps = parseFrd(fixture('transient.frd'));
    expect(steps.map((s) => [s.step, s.time])).toEqual([
      [1, 0.5],
      [1, 1],
      [1, 1.5],
    ]);
    for (const step of steps) expect(Object.keys(step.fields)).toEqual(['NDTEMP', 'RFL']);
  });

  it('numbers result sets by CalculiX step for several load cases', () => {
    const steps = parseFrd(fixture('two.frd'));
    expect(steps.map((s) => [s.step, s.time])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(steps[0]?.fields.DISP?.values['2']?.[0]).toBeCloseTo(0.002, 12);
    expect(steps[1]?.fields.DISP?.values['2']?.[0]).toBeCloseTo(0.004, 12);
  });

  it('tolerates text without result blocks, blank lines and stray rows', () => {
    expect(parseFrd('')).toEqual([]);
    expect(
      parseFrd(
        '    1C\n    2C                             1                                     1\n -1         1 0.00000E+00 0.00000E+00 0.00000E+00\n -3\n 9999\n',
      ),
    ).toEqual([]);
    const stray = ' -1         1 1.00000E+00\n -4  DISP        1    1\n -3\n';
    expect(parseFrd(stray)).toEqual([]);
  });
});

describe('parseDat on real CalculiX 2.21 output', () => {
  it('reads the *NODE PRINT reaction table with its title and time', () => {
    const { tables } = parseDat(fixture('static.dat'));
    expect(tables).toHaveLength(1);
    const [table] = tables;
    expect(table?.title).toBe('forces (fx,fy,fz) for set XMAX and time 0.1000000E+01');
    expect(table?.time).toBe(1);
    expect(table?.rows).toHaveLength(4);
    expect(table?.rows.map((row) => row[0])).toEqual([2, 4, 6, 8]);
    const total = (table?.rows ?? []).reduce((sum, row) => sum + (row[1] ?? 0), 0);
    expect(total).toBeCloseTo(210, 6);
  });

  it('reads one table per step with the step time', () => {
    const { tables } = parseDat(fixture('two.dat'));
    expect(tables.map((t) => t.time)).toEqual([1, 2]);
    expect((tables[1]?.rows ?? []).reduce((sum, row) => sum + (row[1] ?? 0), 0)).toBeCloseTo(420, 6);
  });

  it('gives no tables for text without a table title', () => {
    expect(parseDat('')).toEqual({ tables: [] });
    expect(parseDat('S T E P 1\n 1 2 3\n')).toEqual({ tables: [] });
  });

  it('ends a table at the first non-numeric line', () => {
    const text = 'displacements (vx,vy,vz) for set A and time  0.5E+00\n\n 1 1.0 2.0 3.0\n junk line\n 2 4 5 6\n';
    expect(parseDat(text).tables).toEqual([
      { title: 'displacements (vx,vy,vz) for set A and time 0.5E+00', time: 0.5, rows: [[1, 1, 2, 3]] },
    ]);
  });
});
