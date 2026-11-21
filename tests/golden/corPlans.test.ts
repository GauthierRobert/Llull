/**
 * Golden pin of the PHY-13 plan galvanic_plate_check (docs/physics/13-corrosion-compatibility/validation/plans/galvanic_plate_check.plan.json): a 7075 plate
 * with a titanium-group block (VC-COR-01.1 face 1800 mm^2, VC-COR-02.2 fail 0.60 V), a pair isolation (VC-COR-08 pass_isolated), then without it a
 * cadmium-plated block (VC-COR-03 small anode 4500 / 13000). The normalized document and every query are pinned; replay and save / load are identical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { expected } from '../unit/corrosion/fixtures';
import { normalize } from './normalize';

const PLAN = 'docs/physics/13-corrosion-compatibility/validation/plans/galvanic_plate_check.plan.json';

interface Step {
  command: string;
  ok: boolean;
  summary: string;
  data?: unknown;
}

interface Item {
  status: string;
  code: string;
  inputs: { differenceV?: number; anode?: string; areaRatio?: number };
  reviewRequired: boolean;
}
interface CheckData {
  status: string;
  items: Item[];
  orphans: unknown[];
  text?: string;
}

function run(): { steps: Step[]; document: CadDocument } {
  const actions = JSON.parse(readFileSync(PLAN, 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const steps = (result.data as { steps: Step[] }).steps;
  expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return { steps, document: result.document };
}

const caseOf = (id: string): unknown => expected.cases.find((entry) => entry.id === id)?.value;
const dataOf = (steps: Step[], command: string): unknown[] => steps.filter((step) => step.command === command).map((step) => step.data);
const close = (actual: number | undefined, reference: number): boolean =>
  Math.abs((actual ?? NaN) - reference) <= 1e-9 * Math.abs(reference);

describe('PHY-13 galvanic_plate_check plan, golden (VC-COR-01.1, 02.2, 03, 08)', () => {
  const plan = run();

  it('contact, fail, isolated pass and the cadmium small-anode warning; document and queries pinned', () => {
    expect(normalize(plan.document)).toMatchSnapshot('document');
    const [contacts] = dataOf(plan.steps, 'find_contacts') as { pairs: { kind: string; area: number }[] }[];
    const face = caseOf('VC-COR-01.1') as { kind: string; area: number };
    expect(contacts?.pairs).toHaveLength(1);
    expect(contacts?.pairs[0]?.kind).toBe(face.kind);
    expect(close(contacts?.pairs[0]?.area, face.area)).toBe(true);
    const [bare, isolated, plated] = dataOf(plan.steps, 'check_material_compatibility') as CheckData[];
    const couple = caseOf('VC-COR-02.2') as { differenceV: number; verdict: { normal: string } };
    expect(couple.verdict.normal).toBe('incompatible');
    expect(bare?.items[0]).toMatchObject({ status: 'fail', code: 'COR_GALVANIC_INCOMPATIBLE', reviewRequired: true });
    expect(Math.abs((bare?.items[0]?.inputs.differenceV ?? NaN) - couple.differenceV)).toBeLessThanOrEqual(1e-12);
    expect(isolated?.status).toBe('pass_isolated');
    expect(plated?.items[0]).toMatchObject({ status: 'warn', code: 'COR_SMALL_ANODE' });
    expect(close(plated?.items[0]?.inputs.areaRatio, caseOf('VC-COR-03') as number)).toBe(true);
    expect(plated?.text?.split('\n')[0]?.split(',')).toHaveLength(12);
    expect([bare, isolated, plated].every((answer) => answer?.orphans.length === 0)).toBe(true);
    for (const command of ['find_contacts', 'check_material_compatibility', 'list_surface_systems'])
      expect(dataOf(plan.steps, command)).toMatchSnapshot(command);
  });

  it('replaying the plan on a fresh document and replay_history give the identical document; save / load keeps the slice', () => {
    const again = run();
    expect(again.document).toEqual(plan.document);
    expect(JSON.stringify(again.steps)).toBe(JSON.stringify(plan.steps));
    expect(normalize(execute(plan.document, 'replay_history', {}).document)).toEqual(normalize(plan.document));
    expect(deserializeDocument(serializeDocument(plan.document)).corrosion).toEqual(plan.document.corrosion);
  });
});
