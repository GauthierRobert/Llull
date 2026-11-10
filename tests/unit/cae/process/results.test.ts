/** PHY-16 results: the phases (end of build, release steps), probe readings per phase, the recorded summary, load validation of the build set-up. */
import { describe, expect, it } from 'vitest';
import { analysisErrors } from '@cae/model/validate';
import { evaluateProbes } from '@cae/results/probes';
import { amResultSets } from '@cae/process/results';
import { caseOf } from '@cae/shared/access';
import { amBar, amFrd, must, solveBar } from './support';

const probeBar = (): ReturnType<typeof amBar> => {
  const bar = amBar({ release: true });
  return {
    ...bar,
    doc: must(bar.doc, 'add_result_probe', { analysisId: bar.analysisId, name: 'tip', point: [4, 1, 1.5], quantity: 'u_z' }).doc,
  };
};

/** Steps of the fixture: 3 layers -> the build ends in step 7, the release is step 8. */
const frd = (mesh: Parameters<typeof amFrd>[0]): string =>
  amFrd(mesh, [
    { step: 6, time: 6, szz: 1, uz: 0.5 },
    { step: 7, time: 7, szz: 120, uz: 0.01 },
    { step: 8, time: 8, szz: 45, uz: 0.2 },
  ]);

describe('am_build_distortion results', () => {
  it('stores the end of the build and every release step as load cases, with the largest von Mises and displacement of each', () => {
    const bar = probeBar();
    const solved = solveBar(bar, frd);
    const cases = caseOf(solved.doc, bar.analysisId)?.results?.loadCases ?? [];
    expect(cases.map((entry) => entry.name)).toEqual(['build', 'cut_plate']);
    expect(cases.map((entry) => Math.round(entry.maxVonMises.value))).toEqual([120, 45]);
    expect(cases.map((entry) => entry.maxDisplacement.value)).toEqual([0.01, 0.2]);
  });

  it('reads a probe once per phase (step 6 is not a phase and is skipped), named by the phase', () => {
    const bar = probeBar();
    const solved = solveBar(bar, frd);
    const analysis = caseOf(solved.doc, bar.analysisId);
    if (analysis === undefined) throw new Error('no case');
    const [probe] = evaluateProbes(analysis, solved.mesh, solved.results, 1);
    expect(probe?.values.map((value) => [value.loadCase, value.step, value.value])).toEqual([
      ['build', 7, 0.01],
      ['cut_plate', 8, 0.2],
    ]);
  });

  it('omits a phase CalculiX did not write, and returns no phase for a case without a set-up', () => {
    const bar = probeBar();
    const solved = solveBar(bar, (mesh) => amFrd(mesh, [{ step: 7, time: 7, szz: 120, uz: 0.01 }]));
    const analysis = caseOf(solved.doc, bar.analysisId);
    if (analysis === undefined) throw new Error('no case');
    expect(amResultSets(analysis, solved.mesh, solved.results, 1).map((set) => set.name)).toEqual(['build']);
    const { am, ...bare } = analysis;
    void am;
    expect(amResultSets(bare, solved.mesh, solved.results, 1)).toEqual([]);
  });
});

describe('am set-up load validation', () => {
  const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(amBar({ release: true }).doc)) as Record<string, unknown>;
  const firstCase = (doc: Record<string, unknown>): Record<string, unknown> => {
    const cases = (doc['analysis'] as { cases: Record<string, Record<string, unknown>> }).cases;
    return Object.values(cases)[0] ?? {};
  };
  const mutate = (patch: (am: Record<string, unknown>, analysis: Record<string, unknown>) => void): string[] => {
    const doc = raw();
    const analysis = firstCase(doc);
    patch(analysis['am'] as Record<string, unknown>, analysis);
    return analysisErrors(doc);
  };

  it('accepts a valid set-up', () => {
    expect(analysisErrors(raw())).toEqual([]);
  });

  it.each([
    ['a direction that is not a unit vector', (am: Record<string, unknown>) => (am['buildDirection'] = [0, 0, 2]), 'not a unit vector'],
    ['a plate that is not a part', (am: Record<string, unknown>) => (am['plateEntityId'] = 'ghost'), "'ghost' is not a part"],
    ['a support that is not a part', (am: Record<string, unknown>) => (am['supportEntityIds'] = ['ghost']), "'ghost' is not a part"],
    ['a layer height of zero', (am: Record<string, unknown>) => (am['layerHeight'] = 0), 'layerHeight'],
    [
      'an absurd strain',
      (am: Record<string, unknown>) => (am['inherentStrain'] = { exx: 0.5, eyy: 0, ezz: 0, source: 'x', calibrated: true }),
      'not below 0.1',
    ],
    [
      'a blank strain source',
      (am: Record<string, unknown>) => (am['inherentStrain'] = { exx: 0, eyy: 0, ezz: 0, source: ' ', calibrated: true }),
      'source',
    ],
    [
      'a duplicate release step name',
      (am: Record<string, unknown>) => {
        const steps = am['releaseSteps'] as Record<string, unknown>[];
        am['releaseSteps'] = [...steps, { ...steps[0], remove: ['supports'] }];
      },
      'used twice',
    ],
    [
      'a collinear 3-2-1 support',
      (am: Record<string, unknown>) => {
        const steps = am['releaseSteps'] as Record<string, unknown>[];
        am['releaseSteps'] = [
          {
            ...steps[0],
            support321: [
              [0, 0, 0],
              [1, 0, 0],
              [2, 0, 0],
            ],
          },
        ];
      },
      'collinear',
    ],
    [
      'supports removed in a case with none',
      (am: Record<string, unknown>) => {
        const steps = am['releaseSteps'] as Record<string, unknown>[];
        am['releaseSteps'] = [{ ...steps[0], remove: ['supports'] }];
      },
      'the case has none',
    ],
  ])('rejects %s', (_label, patch, fragment) => {
    const errors = mutate((am) => patch(am));
    expect(
      errors.some((error) => error.includes(fragment)),
      errors.join(' | '),
    ).toBe(true);
  });

  it('rejects a build set-up on a case of another type and a malformed shape', () => {
    expect(mutate((_am, analysis) => (analysis['type'] = 'static')).some((error) => error.includes('only am_build_distortion'))).toBe(true);
    expect(mutate((am) => (am['releaseSteps'] = 'x')).length).toBeGreaterThan(0);
  });
});
