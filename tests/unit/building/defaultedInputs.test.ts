import { describe, expect, it } from 'vitest';
import { portalHall } from '../../helpers/portalHall';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const hall = (): CadDocument => portalHall({ span: 24000, length: 30000 }, createEmptyDocument());
const defaultedOf = (
  tool: string,
  params: Record<string, unknown> = {},
): { defaulted: Array<{ input: string; value: unknown }>; summary: string } => {
  const result = execute(hall(), tool, params);
  return { defaulted: (result.data as { defaulted: Array<{ input: string; value: unknown }> }).defaulted, summary: result.summary };
};
const names = (list: Array<{ input: string }>): string[] => list.map((entry) => entry.input);

describe('engineering defaults of the hall checks are reported (INT-14)', () => {
  it('check_bracing lists windPressure, deadLoad and snowLoad when omitted, nothing when given', () => {
    const omitted = defaultedOf('check_bracing');
    expect(omitted.defaulted).toEqual([
      { input: 'windPressure', value: '0.6' },
      { input: 'deadLoad', value: '0.5' },
      { input: 'snowLoad', value: '0.8' },
    ]);
    expect(omitted.summary).toContain('windPressure 0.6 (defaulted)');
    expect(names(defaultedOf('check_bracing', { windPressure: 0.7, deadLoad: 0.5 }).defaulted)).toEqual(['snowLoad']);
  });
  it('check_purlins lists windPressure, snowLoad and roofDeadLoad when omitted', () => {
    const omitted = defaultedOf('check_purlins');
    expect(names(omitted.defaulted)).toEqual(['windPressure', 'snowLoad', 'roofDeadLoad']);
    expect(omitted.summary).toContain('roofDeadLoad 0.3 (defaulted)');
    expect(defaultedOf('check_purlins', { windPressure: 1, snowLoad: 1, roofDeadLoad: 1 }).defaulted).toEqual([]);
  });
  it('design_portal_frames and design_purlins list the omitted targetUtilisation', () => {
    expect(defaultedOf('design_portal_frames', { windPressure: 0.7 }).defaulted).toEqual(
      expect.arrayContaining([
        { input: 'targetUtilisation', value: '0.95' },
        { input: 'allowFixedBases', value: 'true' },
      ]),
    );
    expect(names(defaultedOf('design_portal_frames', { targetUtilisation: 0.9, allowFixedBases: false }).defaulted)).not.toContain(
      'targetUtilisation',
    );
    expect(names(defaultedOf('design_purlins').defaulted)).toEqual(['targetUtilisation', 'windPressure', 'snowLoad', 'roofDeadLoad']);
    expect(names(defaultedOf('design_purlins', { targetUtilisation: 0.9 }).defaulted)).toEqual([
      'windPressure',
      'snowLoad',
      'roofDeadLoad',
    ]);
  });
});
