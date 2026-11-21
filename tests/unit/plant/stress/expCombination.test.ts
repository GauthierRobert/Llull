/** 07 PST EXP combinations: `method` scalar over displacement-only terms (opposite-sign thermal ranges add in magnitude); srss and non-displacement terms are refused. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { analyzed, anchorAt, baseDoc, conditioned, DN100, withModel, withPipe } from './m3Fixtures';
import { expectRel } from './stressFixtures';

/** An L-shaped pipe between two anchors, constant secant coefficient, a hot case T1 and a cold case T2 (opposite sign about the installation temperature). */
function lFrame(): { doc: CadDocument; id: string } {
  const pipe = withPipe(
    baseDoc(),
    [
      [0, 0, 0],
      [3000, 0, 0],
      [3000, 3000, 0],
    ],
    DN100.odMm,
  );
  const model = withModel(pipe.doc, [pipe.id]);
  let doc = conditioned(
    model.doc,
    model.id,
    {
      temperatures: [
        { name: 'T1', tempC: 200 },
        { name: 'T2', tempC: -40 },
      ],
    },
    { thermal: { meanCtePerK: 1.2e-5 } },
  );
  doc = anchorAt(anchorAt(doc, model.id, pipe.id, 0), model.id, pipe.id, 6000);
  return { doc, id: model.id };
}

const thermal = [
  { name: 'SUS', type: 'SUS', basic: ['W'] },
  { name: 'HOT', type: 'OPE', basic: ['T1'] },
  { name: 'COLD', type: 'OPE', basic: ['T2'] },
];
const exp = (name: string, terms: [string, number][], method?: string): unknown => ({
  name,
  type: 'EXP',
  combine: terms.map(([term, factor]) => ({ case: term, factor })),
  ...(method === undefined ? {} : { method }),
});

const peak = (doc: CadDocument, id: string, name: string): number =>
  Math.max(
    ...(analyzed(doc, id, { include: ['stresses'] }).details?.stresses ?? [])
      .filter((row) => row.case === name)
      .map((row) => row.stressMPa),
  );

describe('EXP combine method', () => {
  it('scalar of two opposite-sign thermal ranges = S_E(hot) + S_E(cold), more than the algebraic difference', () => {
    const { doc, id } = lFrame();
    const both: [string, number][] = [
      ['HOT', 1],
      ['COLD', 1],
    ];
    const set = apply(doc, 'set_stress_load_cases', {
      modelId: id,
      cases: [...thermal, exp('A', [['HOT', 1]]), exp('B', [['COLD', 1]]), exp('SC', both, 'scalar'), exp('AL', both)],
    });
    const a = peak(set, id, 'A');
    const b = peak(set, id, 'B');
    expect(a).toBeGreaterThan(1);
    expect(b).toBeGreaterThan(1);
    expectRel(peak(set, id, 'SC'), a + b, 1e-7, 'scalar');
    expect(peak(set, id, 'AL')).toBeLessThan(a + b);
  });

  it('refuses srss on EXP and a scalar term that carries weight, pressure, wind or forces', () => {
    const { doc, id } = lFrame();
    const sets = (list: unknown[]): unknown => ({ modelId: id, cases: list });
    const both: [string, number][] = [
      ['HOT', 1],
      ['COLD', 1],
    ];
    expectRefusal(doc, 'set_stress_load_cases', sets([...thermal, exp('X', both, 'srss')]), 'PST_LOADCASE_INVALID');
    expectRefusal(
      doc,
      'set_stress_load_cases',
      sets([
        ...thermal,
        exp(
          'X',
          [
            ['SUS', 1],
            ['HOT', 1],
          ],
          'scalar',
        ),
      ]),
      'PST_LOADCASE_INVALID',
    );
    expectRefusal(
      doc,
      'set_stress_load_cases',
      sets([{ name: 'WT', type: 'OPE', basic: ['W', 'T1'] }, exp('X', [['WT', 1]], 'scalar')]),
      'PST_LOADCASE_INVALID',
    );
    expect(
      apply(doc, 'set_stress_load_cases', sets([...thermal, exp('X', both, 'scalar')])).plant?.stress?.models[id]?.loadCases,
    ).toHaveLength(4);
  });
});
