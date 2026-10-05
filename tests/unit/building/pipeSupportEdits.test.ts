import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { reconcilePipeSupports, reconciliationNote } from '@aec/industrial/pipeSupportAttach';
import { step } from './steelFixtures';
import { shoeDoc, supportsOf } from './pipeSupportFixtures';

/** shoeDoc + a shoe at the crossing of the pipe and the beam member-3 (SB1). */
const supported = (): CadDocument =>
  step(shoeDoc(), 'add_pipe_support', { pipeId: 'pipe-1', at: [[3000, 2000, 3027.15]] });

/** A second IPE300 beam on level-2 along Y at `x` (top of steel 2970, like member-3). */
const secondBeam = (doc: CadDocument, x: number): CadDocument =>
  step(doc, 'add_steel_member', {
    role: 'beam',
    profile: 'IPE300',
    start: [x, 0, -180],
    end: [x, 4000, -180],
    levelId: 'level-2',
  });

const danglingMembers = (doc: CadDocument): string[] =>
  supportsOf(doc).flatMap((support) =>
    support.memberId !== null && doc.building?.elements[support.memberId]?.category !== 'member'
      ? [support.id]
      : [],
  );

describe('deleting the steel a support bears on', () => {
  it('re-attaches the support to the nearest steel in reach and says so', () => {
    const doc = secondBeam(supported(), 3050);
    const result = execute(doc, 'delete_building_element', { elementIds: ['member-3'] });
    const [support] = supportsOf(result.document);
    expect(support?.memberId).toBe('member-4');
    expect(danglingMembers(result.document)).toEqual([]);
    expect(result.summary).toContain('Pipe supports re-checked: PS1 re-attached SB1 -> SB2');
    expect(result.affected).toContain('pipeSupport-1');
  });

  it('turns the support unattached when no steel is left, with no dangling memberId', () => {
    const doc = supported();
    const result = execute(doc, 'delete_building_element', { elementIds: ['member-3'] });
    const [support] = supportsOf(result.document);
    expect(support).toMatchObject({ memberId: null, pedestalHeight: 0, rodLength: 0 });
    expect(danglingMembers(result.document)).toEqual([]);
    expect(result.summary).toContain('PS1 DETACHED from SB1');
    expect(result.summary).toContain('now unattached, carries nothing');
    const data = execute(result.document, 'check_pipe_supports', {}).data as {
      pipes: Array<{ unattached: number }>;
    };
    expect(data.pipes[0]?.unattached).toBe(1);
  });

  it('leaves a support alone when another member is deleted', () => {
    const doc = secondBeam(supported(), 3050);
    const result = execute(doc, 'delete_building_element', { elementIds: ['member-4'] });
    expect(supportsOf(result.document)[0]?.memberId).toBe('member-3');
    expect(result.summary).not.toContain('Pipe supports re-checked');
  });

  it('re-attaches a hanger and recomputes its rod length', () => {
    let doc = step(shoeDoc(), 'add_pipe_run', {
      levelId: 'level-2',
      dn: 100,
      line: 'L-2',
      points: [
        [0, 1000, -1000],
        [6000, 1000, -1000],
      ],
    });
    doc = step(doc, 'add_pipe_support', {
      pipeId: 'pipe-2',
      type: 'hanger',
      at: [[3000, 1000, 2000]],
    });
    expect(supportsOf(doc)[0]?.memberId).toBe('member-3');
    expect(supportsOf(doc)[0]?.rodLength).toBeCloseTo(2670 - 2057.15, 6);
    doc = step(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE200',
      start: [3000, 0, 0],
      end: [3000, 4000, 0],
      levelId: 'level-2',
    });
    const result = execute(doc, 'delete_building_element', { elementIds: ['member-3'] });
    const [hanger] = supportsOf(result.document);
    expect(hanger?.memberId).toBe('member-4');
    expect(hanger?.rodLength).toBeCloseTo(2900 - 2057.15, 6);
    expect(hanger?.pedestalHeight).toBe(0);
  });
});

describe('moving the pipe', () => {
  it('re-checks the supports against the steel at the new position and keeps a member still in reach', () => {
    const result = execute(supported(), 'move_building_element', {
      elementIds: ['pipe-1'],
      delta: [0, 1000],
    });
    const [support] = supportsOf(result.document);
    expect(support?.position).toEqual([3000, 3000, 3027.15]);
    expect(support?.memberId).toBe('member-3');
    expect(result.summary).toContain('Pipe supports re-checked: 1 kept (PS1)');
  });

  it('re-attaches to the steel under the new position', () => {
    const doc = secondBeam(supported(), 4000);
    const result = execute(doc, 'move_building_element', {
      elementIds: ['pipe-1'],
      delta: [1000, 0],
    });
    expect(supportsOf(result.document)[0]?.memberId).toBe('member-4');
    expect(result.summary).toContain('PS1 re-attached SB1 -> SB2');
    expect(result.affected).toContain('pipeSupport-1');
  });

  it('detaches a support moved off all steel', () => {
    const result = execute(supported(), 'move_building_element', {
      elementIds: ['pipe-1'],
      delta: [0, 3000],
    });
    expect(supportsOf(result.document)[0]).toMatchObject({ memberId: null, pedestalHeight: 0 });
    expect(result.summary).toContain('PS1 DETACHED from SB1');
  });

  it('attaches an unattached support that lands on steel', () => {
    const loose = step(shoeDoc(), 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[1000, 2000, 3027.15]],
    });
    expect(supportsOf(loose)[0]?.memberId).toBeNull();
    const result = execute(loose, 'move_building_element', {
      elementIds: ['pipe-1'],
      delta: [2000, 0],
    });
    expect(supportsOf(result.document)[0]?.memberId).toBe('member-3');
    expect(result.summary).toContain('PS1 re-attached unattached -> SB1');
  });

  it('re-attaches copied supports to steel of the target level instead of leaving them loose', () => {
    let doc = step(supported(), 'add_level', { name: 'Upper', elevation: 6000, height: 3000 });
    doc = step(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [3000, 0, 2820],
      end: [3000, 4000, 2820],
      levelId: 'level-3',
    });
    const result = execute(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-3'],
      categories: ['pipe'],
    });
    const copy = supportsOf(result.document).find((support) => support.levelId === 'level-3');
    expect(copy?.memberId).toBe('member-4');
    expect(result.summary).toContain('PS2 re-attached unattached -> SB2');
  });
});

describe('moving or editing the steel', () => {
  it('re-checks the supports on a moved member: kept while in reach, detached when moved away', () => {
    const near = execute(supported(), 'move_building_element', {
      elementIds: ['member-3'],
      delta: [40, 0],
    });
    expect(supportsOf(near.document)[0]?.memberId).toBe('member-3');
    expect(near.summary).toContain('1 kept (PS1)');
    const away = execute(supported(), 'move_building_element', {
      elementIds: ['member-3'],
      delta: [800, 0],
    });
    expect(supportsOf(away.document)[0]).toMatchObject({ memberId: null });
    expect(away.summary).toContain('PS1 DETACHED from SB1');
    expect(danglingMembers(away.document)).toEqual([]);
  });

  it('re-attaches to another beam when the member moves away from under the support', () => {
    const doc = secondBeam(supported(), 3100);
    const result = execute(doc, 'move_building_element', {
      elementIds: ['member-3'],
      delta: [-800, 0],
    });
    expect(supportsOf(result.document)[0]?.memberId).toBe('member-4');
    expect(result.summary).toContain('PS1 re-attached SB1 -> SB2');
  });

  it('updates the pedestal when the member is lowered or its section changes', () => {
    const lowered = execute(supported(), 'update_steel_member', {
      memberId: 'member-3',
      start: [3000, 0, -280],
      end: [3000, 4000, -280],
    });
    expect(supportsOf(lowered.document)[0]).toMatchObject({
      memberId: 'member-3',
      pedestalHeight: 100,
    });
    expect(lowered.summary).toContain('Pipe supports re-checked: 1 kept (PS1)');
    const lighter = execute(supported(), 'update_steel_member', {
      memberId: 'member-3',
      profile: 'IPE200',
    });
    expect(supportsOf(lighter.document)[0]?.pedestalHeight).toBe(50);
  });

  it('detaches the support of a member edited out of reach', () => {
    const result = execute(supported(), 'update_steel_member', {
      memberId: 'member-3',
      start: [3000, 0, -2000],
      end: [3000, 4000, -2000],
    });
    expect(supportsOf(result.document)[0]?.memberId).toBeNull();
    expect(result.summary).toContain('PS1 DETACHED from SB1');
  });

  it('widens its reach to the support own pedestal, so a tall pedestal is not detached by a move', () => {
    let doc = step(shoeDoc(), 'update_steel_member', {
      memberId: 'member-3',
      start: [3000, 0, -1000],
      end: [3000, 4000, -1000],
    });
    doc = step(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 3027.15]],
      maxReach: 1500,
    });
    expect(supportsOf(doc)[0]?.pedestalHeight).toBeGreaterThan(500);
    const moved = execute(doc, 'move_building_element', {
      elementIds: ['pipe-1'],
      delta: [0, 100],
    });
    expect(supportsOf(moved.document)[0]?.memberId).toBe('member-3');
  });
});

describe('holding on replay', () => {
  it('reproduces the re-attachment when the history is replayed', () => {
    let doc = secondBeam(supported(), 3100);
    doc = step(doc, 'move_building_element', { elementIds: ['member-3'], delta: [-800, 0] });
    expect(supportsOf(doc)[0]?.memberId).toBe('member-4');
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(supportsOf(replayed)).toEqual(supportsOf(doc));
  });

  it('follows an edited step: moving the member by less keeps the support on it', () => {
    let doc = supported();
    doc = step(doc, 'move_building_element', { elementIds: ['member-3'], delta: [800, 0] });
    expect(supportsOf(doc)[0]?.memberId).toBeNull();
    const moveStep = doc.featureHistory.at(-1)?.id as string;
    const edited = execute(doc, 'edit_step_params', {
      stepId: moveStep,
      params: { elementIds: ['member-3'], delta: [40, 0] },
    });
    expect(supportsOf(edited.document)[0]?.memberId).toBe('member-3');
  });
});

describe('reconcilePipeSupports', () => {
  it('changes nothing without a previous building or with nothing to re-check', () => {
    const doc = supported();
    const building = doc.building as NonNullable<CadDocument['building']>;
    expect(reconcilePipeSupports({ ...doc, building: undefined as never }, building).building).toBe(
      building,
    );
    const result = reconcilePipeSupports(doc, building);
    expect(result.building).toBe(building);
    expect(reconciliationNote(result)).toBe('');
  });

  it('re-checks the listed supports even when nothing changed, and skips a support whose pipe is gone', () => {
    const doc = supported();
    const building = doc.building as NonNullable<CadDocument['building']>;
    const forced = reconcilePipeSupports(doc, building, ['pipeSupport-1']);
    expect(forced.kept).toEqual(['PS1']);
    expect(reconciliationNote(forced)).toBe(' Pipe supports re-checked: 1 kept (PS1).');
    const orphan = {
      ...building,
      elements: {
        ...building.elements,
        'pipeSupport-1': { ...supportsOf(doc)[0], pipeId: 'gone' },
      },
    } as typeof building;
    const skipped = reconcilePipeSupports(doc, orphan, ['pipeSupport-1']);
    expect(skipped.kept).toEqual([]);
    expect(skipped.building).toBe(orphan);
  });
});
