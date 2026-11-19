/**
 * Golden pin of the PHY-15 end-to-end plan (docs/physics/15-electro-optical-properties/validation/plans/eop_end_to_end.plan.json): records, a
 * linearCoefficient strap at 75 degC, coatings, lightning zones, check_bonding and every query; replay and save / load keep the slice identical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { normalize } from './normalize';

const PLANS = 'docs/physics/15-electro-optical-properties/validation/plans';

interface Step {
  command: string;
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
}

function run(name: string): { steps: Step[]; document: CadDocument } {
  const actions = JSON.parse(readFileSync(`${PLANS}/${name}.plan.json`, 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const steps = (result.data as { steps: Step[] }).steps;
  expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return { steps, document: result.document };
}

/** Every number at 9 significant digits (the closed forms are exact to far better; the pin is the shape and the codes). */
function nine(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(9)) : value;
  if (Array.isArray(value)) return value.map(nine);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, nine(entry)]));
  return value;
}

const dataOf = (steps: Step[], command: string): Record<string, unknown> => steps.find((step) => step.command === command)?.data ?? {};

describe('eop_end_to_end plan (VC-EOP-02, 05, 06, 08, 09; zones)', () => {
  const plan = run('eop_end_to_end');

  it('the slice, the bond row at 75 degC, the zone rows and every query are pinned', () => {
    expect(normalize(plan.document)).toMatchSnapshot('document');
    const bonding = dataOf(plan.steps, 'check_bonding') as {
      status: string;
      rows: Array<{ totalOhm: number; status: string; code: string }>;
      zones: Array<{ zone: string; code: string | null }>;
    };
    expect(Math.abs((bonding.rows[0]?.totalOhm ?? 0) / (0.5e-3 + 0.02096764215 / 10) - 1)).toBeLessThan(1e-9);
    expect(bonding.rows[0]).toMatchObject({ status: 'fail', code: 'EOP_BOND_RESISTANCE_EXCEEDED' });
    expect(bonding.zones.map((zone) => [zone.zone, zone.code])).toEqual([
      ['2A', 'EOP_LIGHTNING_ZONE_NO_PATH'],
      ['3', null],
    ]);
    expect(Math.abs((dataOf(plan.steps, 'electrical_resistance')['dcOhm'] as number) / 0.02096764215 - 1)).toBeLessThan(1e-9);
    expect(Math.abs((dataOf(plan.steps, 'optical_balance')['temperatureK'] as number) / 270.245498555 - 1)).toBeLessThan(1e-6);
    for (const command of [
      'check_bonding',
      'electrical_resistance',
      'shield_absorption',
      'normal_reflectance',
      'optical_balance',
      'check_surface_properties',
    ])
      expect(nine(dataOf(plan.steps, command))).toMatchSnapshot(command);
  }, 120_000);

  it('replaying the plan on a fresh document gives the identical document', () => {
    expect(normalize(run('eop_end_to_end').document)).toEqual(normalize(plan.document));
  }, 120_000);

  it('save, load and replay_history keep the electro-optical slice and the material models deep-equal', () => {
    const loaded = deserializeDocument(serializeDocument(plan.document));
    expect(loaded.electroOptical).toEqual(plan.document.electroOptical);
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(replayed.electroOptical).toEqual(plan.document.electroOptical);
    expect(replayed.materials['strap_cu']).toEqual(plan.document.materials['strap_cu']);
  }, 120_000);
});
