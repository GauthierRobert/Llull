/**
 * SIG-REPLAY: every signed act recorded as a feature step (a command taking `confirmation`, not metaHistory) either follows the history on replay
 * (its record is stamped with its step and the plugin seed keeps it only while that step is live: a suite runs `expectSignedReplayFollowsHistory`),
 * or is listed below with why it has no seeded record, or as a known gap (ratchet). A new signed gate must join one of the lists.
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

/** KNOWN GAPS (ratchet): seeded or carried signed records not yet stamped with their step. Fix one, move it to FOLLOWS_HISTORY. */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  approve_pipe_spec: 'plant spec approvals ledger (plant/spec replaySeed)',
  issue_isometric: 'fabrication issueLedger (plant/fabrication replaySeed)',
  accept_registration: 'scan acceptanceLedger (scan replaySeed)',
  accept_asbuilt_extraction: 'scan acceptanceLedger (scan replaySeed)',
  accept_reliability_result: 'probabilistic acceptanceLedger (cae replaySeed; probabilistic lane)',
  approve_pipe_stress: 'stress approval re-attached by the plugin carry, not a seed',
};

const signedSteps = (): string[] =>
  toToolSchemas()
    .filter((tool) => isRecord(tool.input_schema.properties) && 'confirmation' in tool.input_schema.properties)
    .map((tool) => tool.name)
    .filter((name) => getCommand(name)?.annotations?.metaHistory !== true)
    .sort();

describe('SIG-REPLAY: signed step gates follow the history on replay', () => {
  it('every signed step gate is classified (followed, no seeded record, or a known gap), and every listed one still exists', () => {
    const listed = [...Object.keys(FOLLOWS_HISTORY), ...Object.keys(NO_SEEDED_RECORD), ...Object.keys(KNOWN_GAPS)].sort();
    expect(signedSteps()).toEqual(listed);
  });

  it.each(Object.entries(FOLLOWS_HISTORY))('%s: its suite runs the suppress / delete / unsuppress scenario', (command, file) => {
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('expectSignedReplayFollowsHistory');
    expect(text).toContain(command);
  });

  it('every installed seed drops a stamped record whose step is not live, and keeps a legacy (unstamped) one', () => {
    const stamped = { stepKey: '7', marker: 'stamped' };
    const legacy = { marker: 'legacy' };
    const base = {
      ...createEmptyDocument(),
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
    } as unknown as CadDocument;
    const seed = (live?: ReadonlySet<string>): string =>
      JSON.stringify(mergeReplaySeeds(documentExtensions().map((extension) => extension.replaySeed?.(base, live) ?? {})).seed);
    const count = (text: string, marker: string): number => text.split(`"marker":"${marker}"`).length - 1;
    expect(count(seed(), 'stamped')).toBe(7);
    expect(count(seed(new Set(['7'])), 'stamped')).toBe(7);
    expect(count(seed(new Set(['1', '2'])), 'stamped')).toBe(0);
    expect(count(seed(new Set()), 'legacy')).toBe(7);
  });
});
