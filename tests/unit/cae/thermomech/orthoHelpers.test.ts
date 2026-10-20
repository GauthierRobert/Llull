/** PHY-04 M4b review: orthotropic helpers on unknown ids and an invalid reference temperature. */
import { describe, expect, it } from 'vitest';
import type { DeckContext } from '@cae/decks/context';
import { analysisInputHash } from '@cae/hash/inputHash';
import { orthoPartProblems } from '@cae/thermomech/orthoCheck';
import { orthotropicExpansionCards } from '@cae/thermomech/orthoCte';
import { mustRun } from '../deckFixtures';
import { coupledFixture } from './coupledSupport';

function fixtureAndSetup(): {
  boxId: string;
  doc: ReturnType<typeof coupledFixture>['doc'];
  setup: NonNullable<NonNullable<ReturnType<typeof coupledFixture>['doc']['analysis']>['cases'][string]['thermomech']>;
} {
  const base = coupledFixture({ orthotropic: [1e-5, 2e-5, 3e-5] });
  const doc = mustRun(base.doc, 'set_temperature_field', {
    analysisId: base.analysisId,
    cteBasis: { mat: { kind: 'secant', referenceTemperature: { value: 20, unit: 'degC' } } },
  });
  expect(analysisInputHash(doc, base.analysisId, 'mesh')).toBeTruthy();
  const setup = doc.analysis?.cases[base.analysisId]?.thermomech;
  if (setup === undefined) throw new Error('fixture case missing');
  return { boxId: base.boxId, doc, setup };
}

describe('orthotropic helpers on unknown ids and bad set-ups', () => {
  it('orthoPartProblems tolerates an unknown material and an unknown part without throwing', () => {
    const { doc, setup } = fixtureAndSetup();
    const unknownMaterial = orthoPartProblems(doc, setup, 'no-part', 'no-material', 293.15);
    expect(unknownMaterial.some((problem) => problem.severity === 'error')).toBe(true);
    expect(orthoPartProblems(doc, setup, 'no-part', 'mat', 293.15).map((problem) => problem.code)).toEqual([
      'TMC_CTE_ORTHO_ELASTIC_ISOTROPIC',
    ]);
  });

  it('orthotropicExpansionCards refuses an invalid reference temperature unit and writes cards otherwise', () => {
    const { doc, setup, boxId } = fixtureAndSetup();
    const context = { doc } as unknown as DeckContext;
    const bad = orthotropicExpansionCards(context, boxId, 'mat', { ...setup, referenceTemperature: { value: 1, unit: 'mm' } }, 0, 100);
    expect(bad).toMatchObject({ code: 'THM_UNITS_MISMATCH', ids: ['mat', boxId] });
    expect('text' in orthotropicExpansionCards(context, boxId, 'mat', setup, 0, 100)).toBe(true);
  });
});
