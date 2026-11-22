/** Document settings that clear_document keeps (KEPT_KEYS) while it resets the history must survive replay_history: no recorded step regenerates them. */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const SITE = { latitudeDeg: 48.2, longitudeDeg: 16.37, dateTime: '2026-06-21T14:30:00+02:00', northAngleDeg: 30 };

/** Key of KEPT_KEYS -> the command that sets it to a non-default value. */
const SETTERS: Record<string, readonly [string, Record<string, unknown>]> = {
  camera: ['set_camera', { target: [1, 2, 3], distance: 40 }],
  units: ['set_units', { units: 'in' }],
  displayPrecision: ['set_units', { displayPrecision: 5 }],
  kernelSettings: ['set_modeling_tolerance', { linear: 1e-3 }],
  siteContext: ['set_site_context', SITE],
  nextStepNumber: ['add_box', { size: [1, 1, 1] }],
};

function run(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, name, params);
  expect(result.document, `${name}: ${result.summary}`).not.toBe(doc);
  return result.document;
}

describe('clear_document kept keys survive replay_history', () => {
  it.each(Object.keys(SETTERS))('%s', (key) => {
    const [name, params] = SETTERS[key]!;
    const set = run(createEmptyDocument(), name, params);
    const cleared = run(run(set, 'add_box', { size: [2, 2, 2] }), 'clear_document', {});
    const before = (cleared as unknown as Record<string, unknown>)[key];
    expect(before, `clear_document dropped ${key}`).toBeDefined();
    const replayed = run(run(cleared, 'add_box', { size: [3, 3, 3] }), 'replay_history', {});
    const after = (replayed as unknown as Record<string, unknown>)[key];
    if (key === 'nextStepNumber') expect(after).toBeDefined();
    else expect(after).toEqual(before);
    expect(Object.keys(replayed.entities)).toHaveLength(1);
  });

  it('a suppressed set_site_context step still removes the site (the orphan rule)', () => {
    const set = run(createEmptyDocument(), 'set_site_context', SITE);
    const stepId = set.featureHistory[0]!.id;
    const replayed = run(set, 'set_step_suppressed', { stepId, suppressed: true });
    expect(replayed.siteContext).toBeUndefined();
  });
});
