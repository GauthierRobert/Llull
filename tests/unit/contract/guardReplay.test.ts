/**
 * Contract (L8): every installed derivation guard gives the same verdict while a history replay re-runs a step as outside one, except the
 * reference (delete) guards of REPLAY_SKIPPING, which never refuse a replayed step (a history recorded before the guard existed still replays;
 * the net result of the history meta-command is still checked). The PLM release lock is NOT skipping: a replay cannot edit a released item.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { pluginGuards } from '@core/plugins/host';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { released } from '../plm/fixtures';
import { runPlan } from '../electroOptical/fixtures';
import { FAT_PLANS, runPlanFile } from '../cae/fatigue/support';

/** Guard domains that skip a step re-run by replay: slice-reference delete guards (corrosion, electro-optical, cae analysis + durability). */
const REPLAY_SKIPPING: ReadonlySet<string> = new Set(['corrosion', 'electro-optical', 'cae']);

const replayingCtx = (): ExecutionContext => ({ ...defaultContext(), replaying: true });

interface Fixture {
  readonly name: string;
  readonly previous: CadDocument;
  readonly next: CadDocument;
  readonly command: string;
}

/** `next` = the result of `command` with the replay-skipping guards out of the way (run as a replayed step). */
function viaReplay(name: string, previous: CadDocument, command: string, params: Record<string, unknown>): Fixture {
  const result = execute(previous, command, params, replayingCtx());
  if (result.error !== undefined) throw new Error(`${name}: ${result.summary}`);
  return { name, previous, next: result.document, command };
}

function corrosionFixture(): Fixture {
  const added = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  const box = added.affected[0] ?? '';
  const covered = execute(added.document, 'assign_surface_system', { entityIds: [box], layers: [{ class: 'anodize' }] }).document;
  return viaReplay('corrosion surface system', covered, 'delete_entities', { ids: [box] });
}

function electroOpticalFixture(): Fixture {
  const { doc, aliases } = runPlan('eop_bonding_paths.plan.json');
  return viaReplay('eop bond path', doc, 'delete_entities', { ids: [aliases['box'] ?? ''] });
}

function analysisFixture(): Fixture {
  const added = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  const box = added.affected[0] ?? '';
  const created = execute(added.document, 'create_analysis', { name: 'a', analysisType: 'static' });
  const withPart = execute(created.document, 'set_part_idealization', { analysisId: created.affected[0] ?? '', entityId: box });
  if (withPart.error !== undefined) throw new Error(withPart.summary);
  return viaReplay('cae analysis part', withPart.document, 'delete_entities', { ids: [box] });
}

function durabilityFixture(): Fixture {
  const { document } = runPlanFile(`${FAT_PLANS}/fat_history_only_miner.plan.json`);
  const fatigue = Object.values(document.analysis?.durability?.fatigueCases ?? {})[0];
  if (fatigue === undefined) throw new Error('no fatigue case');
  return viaReplay('cae durability model', document, 'delete_material_model', {
    material: fatigue.material.recordId,
    id: fatigue.material.modelId,
  });
}

function plmFixture(): Fixture {
  const doc = released();
  const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const id = box.affected[0] ?? '';
  const entity = box.document.entities[id];
  if (entity === undefined) throw new Error('no box');
  return {
    name: 'plm released edit',
    previous: doc,
    next: { ...doc, entities: { ...doc.entities, 'extra-1': entity } },
    command: 'add_box',
  };
}

describe('guard replay contract (L8), over every installed guard', () => {
  const fixtures = [corrosionFixture(), electroOpticalFixture(), analysisFixture(), durabilityFixture(), plmFixture()];
  const guards = pluginGuards();

  it('REPLAY_SKIPPING names installed guard domains only, and plm is not among them', () => {
    const domains = new Set(guards.map((guard) => guard.domain));
    for (const domain of REPLAY_SKIPPING) expect(domains.has(domain)).toBe(true);
    expect(REPLAY_SKIPPING.has('plm')).toBe(false);
  });

  it('a non-skipping guard gives the same verdict with { replaying: true } as with { replaying: false }; a skipping one returns null', () => {
    for (const guard of guards)
      for (const fixture of fixtures) {
        const outside = guard.check(fixture.previous, fixture.next, fixture.command, { replaying: false });
        const inside = guard.check(fixture.previous, fixture.next, fixture.command, { replaying: true });
        expect(guard.check(fixture.previous, fixture.next, fixture.command), `${guard.domain} / ${fixture.name}: default`).toEqual(outside);
        if (REPLAY_SKIPPING.has(guard.domain)) expect(inside, `${guard.domain} / ${fixture.name}`).toBeNull();
        else expect(inside, `${guard.domain} / ${fixture.name}`).toEqual(outside);
      }
  });

  it('the comparison is not trivial: every skipping guard and the plm lock refuse some fixture outside replay', () => {
    const refusing = (domain: string): string[] =>
      guards
        .filter((guard) => guard.domain === domain)
        .map((guard, index) => {
          const hit = fixtures.find(
            (fixture) => guard.check(fixture.previous, fixture.next, fixture.command, { replaying: false }) !== null,
          );
          return `${domain}#${index}:${hit?.name ?? 'none'}`;
        });
    for (const domain of [...REPLAY_SKIPPING, 'plm']) for (const entry of refusing(domain)) expect(entry).not.toMatch(/:none$/);
  });

  it('a replayed step still cannot edit a released item (PLM_LOCKED)', () => {
    const doc = released();
    const edited = execute(doc, 'add_box', { size: [1, 1, 1] }, replayingCtx());
    expect(edited.error?.code).toBe('PLM_LOCKED');
    expect(edited.document).toBe(doc);
  });

  it('a reference delete is refused outside replay and allowed as a replayed step (end to end)', () => {
    const { previous } = corrosionFixture();
    const box = Object.keys(previous.entities)[0] ?? '';
    expect(execute(previous, 'delete_entities', { ids: [box] }).error?.code).toBe('COR_REFERENCE_IN_USE');
    expect(execute(previous, 'delete_entities', { ids: [box] }, replayingCtx()).document.entities[box]).toBeUndefined();
  });
});
