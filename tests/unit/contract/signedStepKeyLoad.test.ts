/** SIG-REPLAY load path: a stored `stepKey` is optional text of 1 to 64 characters in every signed slice and ledger; anything else is refused on load. */
import { describe, expect, it } from 'vitest';
import { corrosionErrors } from '@cae/corrosion/model';
import { electroOpticalErrors } from '@cae/electroOptical/model';
import { spaceEnvironmentErrors } from '@cae/environment/model';
import { dispositionLedgerErrors } from '@cae/shared/validateDispositionLedger';
import { fitDispositionErrors } from '@cae/thermomech/validateDispositions';
import { vibroacousticsErrors } from '@cae/vibroacoustics/model';
import { ledgerErrors } from '@cae/vnv/validateStudies';

type Validate = (record: Record<string, unknown>) => string[];

/** Each signed slice / ledger, with one (possibly otherwise incomplete) record carrying `extra`. */
const TARGETS: readonly (readonly [string, Validate])[] = [
  [
    'vibroacoustics.reviews',
    (record) =>
      vibroacousticsErrors({
        vibroacoustics: { spectra: {}, spectrumOrder: [], exposures: {}, exposureOrder: [], reviews: { a: record } },
      }),
  ],
  [
    'corrosion.acceptances',
    (record) => corrosionErrors({ corrosion: { materials: {}, surfaceSystems: {}, isolations: {}, acceptances: { a: record } } }),
  ],
  [
    'electroOptical.dispositions',
    (record) => electroOpticalErrors({ electroOptical: { coatings: {}, bondPaths: {}, dispositions: { a: record } } }),
  ],
  ['spaceEnvironment.deviations', (record) => spaceEnvironmentErrors({ spaceEnvironment: { deviations: { a: record } } })],
  ['analysis.dispositionLedger', (record) => dispositionLedgerErrors({ dispositionLedger: [record] })],
  ['analysis.fitLedger', (record) => fitDispositionErrors({ fitLedger: [record] })],
  ['analysis.exceptionLedger', (record) => ledgerErrors({ exceptionLedger: [{ analysisId: 'an-1.1', studyId: 'cs-2.1', ...record }] })],
];

const aboutStepKey = (errors: readonly string[]): string[] => errors.filter((error) => /stepKey/.test(error));

describe.each(TARGETS)('%s: stored stepKey', (_name, validate) => {
  it('absent, or text of 1 to 64 characters, raises no stepKey error', () => {
    expect(aboutStepKey(validate({}))).toEqual([]);
    expect(aboutStepKey(validate({ stepKey: '7' }))).toEqual([]);
    expect(aboutStepKey(validate({ stepKey: 'k'.repeat(64) }))).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['a number', 7],
    ['an object', {}],
    ['65 characters', 'k'.repeat(65)],
  ])('%s is refused', (_label, stepKey) => {
    expect(aboutStepKey(validate({ stepKey }))).not.toEqual([]);
  });
});
