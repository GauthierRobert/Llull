/** ENG-10b: a modal (natural frequency) question reaches the modal path of the catalog; controls keep their rank. */
import { describe, expect, it } from 'vitest';
import { searchTools } from '@protocol/discovery';

const top = (query: string, count: number): string[] => searchTools(query, count).map((hit) => hit.name);

describe('modal analysis discoverability', () => {
  it.each([
    'natural frequency',
    'natural frequencies of a bracket',
    'modal analysis',
    'eigenfrequency',
    'resonance',
    'mode shapes',
    'vibration modes',
    'vibration mode',
  ])('"%s" ranks create_analysis (analysisType modal) in the top 3', (query) => {
    expect(top(query, 3)).toContain('create_analysis');
  });

  it.each(['natural frequency', 'natural frequencies of a bracket', 'mode shapes', 'eigenfrequency'])(
    '"%s" also surfaces the solve step in the top 6',
    (query) => {
      expect(top(query, 6)).toContain('fea_solve');
    },
  );

  it('mode shapes also surface the result readers', () => {
    expect(top('mode shapes', 6)).toEqual(expect.arrayContaining(['fea_result_field', 'render_fea_results']));
  });

  it.each([
    ['stress plot', 'render_fea_results'],
    ['export step', 'export_step'],
    ['how heavy is it', 'mass_properties'],
    ['round the edges', 'fillet_edge'],
    ['take a picture', 'render_view'],
    ['random vibration PSD', 'define_vibration_spectrum'],
    ['harmonic response', 'sdof_response'],
  ])('control "%s" still ranks %s in the top 3', (query, expected) => {
    expect(top(query, 3)).toContain(expected);
  });
});
