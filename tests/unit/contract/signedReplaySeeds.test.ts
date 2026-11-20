/**
 * SIG-REPLAY: every signed act recorded as a feature step (a command taking `confirmation`, not metaHistory) either follows the history on replay
 * (its record is stamped with its step and the plugin seed keeps it only while that step is live: a suite runs `expectSignedReplayFollowsHistory`),
 * or is listed below with why it has no seeded record, or as a known gap (ratchet). A new signed gate must join one of the lists.
 * A signed gate MUST name its signature param `confirmation` (tests/unit/contract/signatureParamName.test.ts): that is how it is found here.
 * Decision record: docs/decisions/SIG-REPLAY.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getCommand, toToolSchemas } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { documentExtensions } from '@core/plugins/host';
import { mergeReplaySeeds } from '@core/commands/history/replaySeeds';
import { isRecord } from '@lib/isRecord';

/** Signed step gates whose replay follows the history, and the suite that proves it. */
const FOLLOWS_HISTORY: Readonly<Record<string, string>> = {
  dispose_acoustic_export: 'tests/unit/vibroacoustics/review.test.ts',
  accept_corrosion_item: 'tests/unit/corrosion/accept.test.ts',
  dispose_bond_check: 'tests/unit/electroOptical/dispose.test.ts',
  approve_environment_deviation: 'tests/unit/environment/deviation.test.ts',
  dispose_margin: 'tests/unit/cae/dispositionGates.test.ts',
  dispose_thermal_limit: 'tests/unit/cae/dispositionGates.test.ts',
  dispose_fit_result: 'tests/unit/cae/thermomech/disposeReplay.test.ts',
  accept_verification_exception: 'tests/unit/cae/vnv/studyGate.test.ts',
};

/** Signed step gates that keep no record through a replay seed: nothing for a suppressed step to leave behind. */
const NO_SEEDED_RECORD: Readonly<Record<string, string>> = {
  set_review_disposition: 'the disposition is written by its step only; a replay re-runs it (no seed)',
  import_material_library: 'the confirmation only lowers a marking at import; nothing is seeded',
  set_export_marking: 'the marking is written by its step only; nothing is seeded',
};

/** KNOWN GAPS (ratchet): seeded signed records not yet stamped; `seeded` puts a record at the slice its seed copies. Fix one, move it to FOLLOWS_HISTORY. */
const KNOWN_GAPS: Readonly<Record<string, { readonly why: string; readonly seeded: (record: object) => object }>> = {
  approve_pipe_spec: {
    why: 'plant spec approvals ledger (plant/spec replaySeed)',
    seeded: (record) => ({ plant: { spec: { specs: {}, specOrder: [], approvals: [record] } } }),
  },
  issue_isometric: {
    why: 'fabrication issueLedger (plant/fabrication replaySeed)',
    seeded: (record) => ({ plant: { fabrication: { version: 1, pcfLines: {}, issueLedger: [record] } } }),
  },
  accept_registration: { why: 'scan acceptanceLedger (scan replaySeed)', seeded: (record) => ({ scan: { acceptanceLedger: [record] } }) },
  accept_asbuilt_extraction: {
    why: 'scan acceptanceLedger (scan replaySeed)',
    seeded: (record) => ({ scan: { acceptanceLedger: [record] } }),
  },
  accept_reliability_result: {
    why: 'probabilistic acceptanceLedger (cae replaySeed; probabilistic lane)',
    seeded: (record) => ({ probabilistic: { acceptanceLedger: [record] } }),
  },
};

/** Signed step gates whose approval a plugin `carry` re-attaches after the steps (no seed, no live step keys): out of the seed contract. */
const CARRIED: Readonly<Record<string, string>> = {
  approve_pipe_stress: 'stress approval re-attached by the plugin carry while the recorded results are unchanged',
};

/** The slices NO_SEEDED_RECORD gates write: no installed seed may return them. */
const UNSEEDED_SLICES: readonly string[] = ['prototype', 'materials'];

/** Followed slices with one stamped (dead key 7) and one legacy record each. */
function followedBase(stamped: object, legacy: object): object {
  return {
    vibroacoustics: { spectra: {}, spectrumOrder: [], exposures: {}, exposureOrder: [], reviews: { a: stamped, b: legacy } },
    corrosion: { materials: {}, surfaceSystems: {}, isolations: {}, acceptances: { a: stamped, b: legacy } },
    electroOptical: { coatings: {}, bondPaths: {}, dispositions: { a: stamped, b: legacy } },
    spaceEnvironment: { deviations: { a: stamped, b: legacy } },
    analysis: {
      cases: {},
      caseOrder: [],
      dispositionLedger: [stamped, legacy],
      fitLedger: [stamped, legacy],
      exceptionLedger: [stamped, legacy],
    },
  };
}

const seeded = (base: CadDocument, live?: ReadonlySet<string>): string =>
  JSON.stringify(mergeReplaySeeds(documentExtensions().map((extension) => extension.replaySeed?.(base, live) ?? {})).seed);
const count = (text: string, marker: string): number => text.split(`"marker":"${marker}"`).length - 1;

const signedSteps = (): string[] =>
  toToolSchemas()
    .filter((tool) => isRecord(tool.input_schema.properties) && 'confirmation' in tool.input_schema.properties)
    .map((tool) => tool.name)
    .filter((name) => getCommand(name)?.annotations?.metaHistory !== true)
    .sort();

describe('SIG-REPLAY: signed step gates follow the history on replay', () => {
  it('every signed step gate is classified (followed, no seeded record, or a known gap), and every listed one still exists', () => {
    const listed = [
      ...Object.keys(FOLLOWS_HISTORY),
      ...Object.keys(NO_SEEDED_RECORD),
      ...Object.keys(KNOWN_GAPS),
      ...Object.keys(CARRIED),
    ].sort();
    expect(signedSteps()).toEqual(listed);
  });

  it.each(Object.entries(FOLLOWS_HISTORY))('%s: its suite runs the suppress / delete / unsuppress scenario', (command, file) => {
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('expectSignedReplayFollowsHistory');
    expect(text).toContain(command);
  });

  it('every installed seed that copies a followed slice drops a stamped record whose step is not live, and keeps a legacy one', () => {
    const base = {
      ...createEmptyDocument(),
      ...followedBase({ stepKey: '7', marker: 'stamped' }, { marker: 'legacy' }),
    } as unknown as CadDocument;
    const slots = count(JSON.stringify(base), 'stamped');
    // derived, not hard-coded: the seeds that copy a followed slice are the ones that return its records
    const copying = documentExtensions().filter((extension) => count(JSON.stringify(extension.replaySeed?.(base) ?? {}), 'stamped') > 0);
    expect(copying.length).toBeGreaterThan(0);
    expect(count(seeded(base), 'stamped')).toBe(slots);
    expect(count(seeded(base, new Set(['7'])), 'stamped')).toBe(slots);
    for (const extension of copying) {
      const dead = JSON.stringify(extension.replaySeed?.(base, new Set(['1', '2'])) ?? {});
      expect(count(dead, 'stamped')).toBe(0);
      expect(count(dead, 'legacy')).toBe(count(JSON.stringify(extension.replaySeed?.(base) ?? {}), 'legacy'));
    }
    expect(count(seeded(base, new Set()), 'legacy')).toBe(slots);
  });

  it.each(Object.entries(KNOWN_GAPS))(
    '%s (known gap, ratchet): its seed STILL keeps a record stamped with a dead step',
    (_command, gap) => {
      const base = { ...createEmptyDocument(), ...gap.seeded({ stepKey: '7', marker: 'gap' }) } as unknown as CadDocument;
      expect(count(seeded(base), 'gap')).toBe(1);
      expect(count(seeded(base, new Set()), 'gap')).toBe(1);
    },
  );

  it.each(UNSEEDED_SLICES)('no installed plugin seed returns the %s slice (NO_SEEDED_RECORD gates)', (slice) => {
    const base = { ...createEmptyDocument(), [slice]: { a: { stepKey: '7', marker: 'unseeded' } } } as unknown as CadDocument;
    for (const extension of documentExtensions()) expect(Object.keys(extension.replaySeed?.(base) ?? {})).not.toContain(slice);
  });
});
