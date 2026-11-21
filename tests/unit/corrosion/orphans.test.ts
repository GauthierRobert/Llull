/** COR-b orphan handling: the reference guard (COR_REFERENCE_IN_USE), remove_surface_system / remove_galvanic_group, and the check's data.orphans. */
import { describe, expect, it } from 'vitest';
import { type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { corrosionReferenceGuard } from '@cae/corrosion/guard';
import { orphanedEntries } from '@cae/corrosion/orphans';
import { remediationOfCor } from '@cae/corrosion/codes';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { signingContext } from '../../helpers/signedPlantDoc';
import { libraryFile, mmDocument, step } from '../materials/support';
import { check, pair, run, withEnvironment } from './fixtures';

const SOURCE = { citation: 'test' };

interface Orphan {
  kind: string;
  id: string;
  code: string;
  missing: string[];
  remedy: string;
}
const orphansOf = (doc: CadDocument): Orphan[] => (check(doc) as unknown as { orphans: Orphan[] }).orphans;

describe('corrosion reference guard (COR_REFERENCE_IN_USE)', () => {
  it('refuses to delete a solid a surface system covers; clearing the system first lets it go', () => {
    const { doc, plate } = pair();
    const covered = execute(doc, 'assign_surface_system', { entityIds: [plate], layers: [{ class: 'anodize' }] });
    const systemId = covered.affected[0] ?? '';
    const refused = execute(covered.document, 'delete_entities', { ids: [plate] });
    expect(refused.error?.code).toBe('COR_REFERENCE_IN_USE');
    expect(refused.error?.ids).toEqual([plate]);
    expect(refused.summary).toContain(`is used by surface system '${systemId}'`);
    expect(refused.document).toBe(covered.document);
    const cleared = run(covered.document, 'assign_surface_system', { entityIds: [plate], layers: [{ class: 'none' }] });
    expect(execute(cleared, 'delete_entities', { ids: [plate] }).error).toBeUndefined();
  });

  it('refuses to delete a solid a pair or part isolation names; remove_isolation lets it go', () => {
    const { doc, plate, block } = pair();
    const isolated = execute(doc, 'declare_isolation', { pair: [plate, block], method: 'sealant_faying' });
    const refused = execute(isolated.document, 'delete_entities', { ids: [block] });
    expect(refused.error?.code).toBe('COR_REFERENCE_IN_USE');
    expect(refused.summary).toContain(`remove_isolation '${isolated.affected[0] ?? ''}'`);
    const removed = run(isolated.document, 'remove_isolation', { id: isolated.affected[0] ?? '' });
    expect(execute(removed, 'delete_entities', { ids: [block] }).error).toBeUndefined();
    const part = execute(doc, 'declare_isolation', { entityId: plate, method: 'primer' });
    expect(execute(part.document, 'delete_entities', { ids: [plate] }).error?.code).toBe('COR_REFERENCE_IN_USE');
  });

  it('unrelated deletions and edits pass the guard', () => {
    const { doc, plate, block } = pair();
    const covered = run(doc, 'assign_surface_system', { entityIds: [plate], layers: [{ class: 'anodize' }] });
    expect(execute(covered, 'delete_entities', { ids: [block] }).error).toBeUndefined();
    expect(execute(covered, 'move_entities', { ids: [plate], delta: [1, 0, 0] }).error).toBeUndefined();
  });

  it('delete_material_library is refused while a record of it has a galvanic group; remove_galvanic_group first lets it go', () => {
    const imported = step(mmDocument(), 'import_material_library', { library: libraryFile() });
    const grouped = run(imported, 'set_galvanic_group', {
      material: 'aa7075_t6',
      galvanicGroup: 'aluminium_wrought_other',
      source: SOURCE,
    });
    const refused = execute(grouped, 'delete_material_library', { libraryId: 'synthetic-lib' });
    expect(refused.error).toMatchObject({ code: 'COR_REFERENCE_IN_USE', ids: ['aa7075_t6'] });
    expect(refused.summary).toContain("remove_galvanic_group 'aa7075_t6'");
    expect(refused.document).toBe(grouped);
    const cleared = run(grouped, 'remove_galvanic_group', { material: 'aa7075_t6' });
    expect(execute(cleared, 'delete_material_library', { libraryId: 'synthetic-lib' }).error).toBeUndefined();
  });

  it('load_document of a pre-guard file whose surface system names an entity it lacks is not refused (whole-document replacement)', () => {
    const { doc, plate } = pair();
    const covered = run(doc, 'assign_surface_system', { entityIds: [plate], layers: [{ class: 'anodize' }] });
    const { [plate]: _gone, ...entities } = covered.entities;
    void _gone;
    const legacy: CadDocument = { ...covered, entities, order: covered.order.filter((id) => id !== plate) };
    const loaded = execute(covered, 'load_document', { json: serializeDocument(legacy) });
    expect(loaded.error).toBeUndefined();
    expect(loaded.document.entities[plate]).toBeUndefined();
    expect(orphansOf(withEnvironment(loaded.document, 'normal')).map((orphan) => orphan.kind)).toEqual(['surface_system']);
  });

  it('refuses only references the input document already had (a result that adds a dangling entry is not a deletion)', () => {
    const { doc, plate } = pair();
    const covered = run(doc, 'assign_surface_system', { entityIds: [plate], layers: [{ class: 'anodize' }] });
    const { [plate]: _gone, ...entities } = covered.entities;
    void _gone;
    expect(corrosionReferenceGuard.check(doc, { ...covered, entities }, 'some_command')).toBeNull();
    expect(corrosionReferenceGuard.check(covered, { ...covered, entities }, 'some_command')).not.toBeNull();
    expect(corrosionReferenceGuard.check(covered, { ...covered, entities }, 'some_command', { replaying: true })).toBeNull();
  });

  it('replay_history of a history recorded before the guard (assign, then delete the covered solid) gives the saved model', () => {
    const { doc, plate } = pair();
    const covered = run(doc, 'assign_surface_system', { entityIds: [plate], layers: [{ class: 'anodize' }] });
    const preGuard = execute(covered, 'delete_entities', { ids: [plate] }, { ...defaultContext(), replaying: true });
    expect(preGuard.error).toBeUndefined();
    expect(preGuard.document.featureHistory.at(-1)?.name).toBe('delete_entities');
    const replayed = execute(preGuard.document, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(replayed.document.entities[plate]).toBeUndefined();
    expect(replayed.document.corrosion).toEqual(preGuard.document.corrosion);
  });
});

describe('remove_surface_system', () => {
  it('removes a system by id; its solid couples as its base material again', () => {
    const { doc, plate } = pair(['aluminium_wrought_other', 'aluminium_wrought_other']);
    const plated = execute(doc, 'assign_surface_system', {
      entityIds: [plate],
      layers: [{ class: 'metallic_plating', galvanicGroup: 'cadmium_plate' }],
    });
    const id = plated.affected[0] ?? '';
    const result = execute(plated.document, 'remove_surface_system', { id });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([id]);
    expect(result.summary).toContain(`removed '${id}'`);
    expect(result.document.corrosion?.surfaceSystems).toEqual({});
  });

  it('refuses an unknown id with COR_SURFACE_SYSTEM_NOT_FOUND and the document unchanged', () => {
    const { doc } = pair();
    const result = execute(doc, 'remove_surface_system', { id: 'ss-9.9' });
    expect(result.error?.code).toBe('COR_SURFACE_SYSTEM_NOT_FOUND');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('is pure', () => {
    const { doc, plate } = pair();
    const covered = execute(doc, 'assign_surface_system', { entityIds: [plate], layers: [{ class: 'anodize' }] });
    const before = structuredClone(covered.document);
    execute(covered.document, 'remove_surface_system', { id: covered.affected[0] ?? '' });
    expect(covered.document).toEqual(before);
  });
});

describe('remove_galvanic_group', () => {
  it('removes the entry; the material stays and the next check reports the pair unknown (COR_GROUP_MISSING)', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const result = execute(doc, 'remove_galvanic_group', { material: 'm_plate' });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual(['m_plate']);
    expect(result.document.materials['m_plate']).toBeDefined();
    expect(Object.keys(result.document.corrosion?.materials ?? {})).toEqual(['m_block']);
    const after = check(withEnvironment(result.document, 'normal'));
    expect(after.items[0]).toMatchObject({ status: 'unknown', code: 'COR_GROUP_MISSING' });
  });

  it('refuses a material without an entry with COR_GROUP_NOT_SET and the document unchanged', () => {
    const { doc } = pair();
    const result = execute(doc, 'remove_galvanic_group', { material: 'm_plate' });
    expect(result.error?.code).toBe('COR_GROUP_NOT_SET');
    expect(result.document).toBe(doc);
  });

  it('is pure', () => {
    const { doc } = pair(['aluminium_wrought_other', null]);
    const before = structuredClone(doc);
    execute(doc, 'remove_galvanic_group', { material: 'm_plate' });
    expect(doc).toEqual(before);
  });
});

describe('check_material_compatibility data.orphans (COR_REFERENCE_ORPHANED)', () => {
  it('a clean document has no orphans', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    expect(orphansOf(withEnvironment(doc, 'normal'))).toEqual([]);
  });

  it('reports dangling entries of a file written before the guard (surface system, isolation, galvanic group), never as a status change', () => {
    const { doc, plate } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    let next = run(doc, 'assign_surface_system', { entityIds: [plate], layers: [{ class: 'anodize' }] });
    next = withEnvironment(next, 'normal');
    const corrosion = next.corrosion;
    if (corrosion === undefined) throw new Error('no slice');
    const [systemId] = Object.keys(corrosion.surfaceSystems);
    const dangling: CadDocument = {
      ...next,
      corrosion: {
        ...corrosion,
        surfaceSystems: { [systemId ?? '']: { id: systemId ?? '', entityIds: [plate, 'gone-1.1'], layers: [{ class: 'anodize' }] } },
        isolations: { 'iso-x': { id: 'iso-x', pair: [plate, 'ghost/child'], method: 'sealant_faying' } },
        materials: { ...corrosion.materials, ghost_material: { galvanicGroup: 'zinc', source: { citation: 'test' } } },
      },
    };
    const answer = execute(dangling, 'check_material_compatibility', {});
    const orphans = (answer.data as { orphans: Orphan[]; status: string }).orphans;
    expect(orphans.map((orphan) => [orphan.kind, orphan.missing, orphan.remedy.split(' ')[0]])).toEqual([
      ['galvanic_group', ['ghost_material'], 'remove_galvanic_group'],
      ['isolation', ['ghost'], 'remove_isolation'],
      ['surface_system', ['gone-1.1'], 'remove_surface_system'],
    ]);
    expect(orphans.every((orphan) => orphan.code === 'COR_REFERENCE_ORPHANED')).toBe(true);
    expect(answer.summary).toContain('3 orphaned entries (COR_REFERENCE_ORPHANED');
    expect((answer.data as { status: string }).status).toBe(check(next).status);
    const cleaned = run(
      run(run(dangling, 'remove_surface_system', { id: systemId ?? '' }), 'remove_galvanic_group', { material: 'ghost_material' }),
      'remove_isolation',
      { id: 'iso-x' },
    );
    expect(orphansOf(cleaned)).toEqual([]);
  });

  it('an acceptance whose part was deleted is reported orphaned (acceptances are not guarded)', () => {
    const { doc, plate, block } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const env = withEnvironment(doc, 'normal');
    const key = `galvanic:${plate}|${block}`;
    const accepted = run(
      env,
      'accept_corrosion_item',
      { itemKey: key, decision: 'accepted', justification: 'sealed per drawing note 4', confirmation: { nonce: 'n1' } },
      signingContext,
    );
    const deleted = execute(accepted, 'delete_entities', { ids: [block] });
    expect(deleted.error).toBeUndefined();
    const orphans = orphansOf(deleted.document);
    expect(orphans).toEqual([expect.objectContaining({ kind: 'acceptance', id: key, missing: [block], code: 'COR_REFERENCE_ORPHANED' })]);
    expect(execute(deleted.document, 'check_material_compatibility', {}).summary).toContain(
      `1 orphaned entry (COR_REFERENCE_ORPHANED: acceptance ${key})`,
    );
  });
});

describe('orphanedEntries (direct)', () => {
  it('groups the missing ids per entry, ignores skipped:<id> keys (a skipped item is never acceptable) and sorts by kind then id', () => {
    const { doc, plate } = pair(['aluminium_wrought_other', null]);
    const corrosion = doc.corrosion;
    if (corrosion === undefined) throw new Error('no slice');
    const acceptance = {
      decision: 'accepted',
      justification: 'j',
      fingerprint: '0'.repeat(64),
      signer: 's',
      signatureId: 'x',
      signature: null,
      documentUid: 'u',
    } as const;
    const dangling: CadDocument = {
      ...doc,
      corrosion: {
        ...corrosion,
        isolations: {
          'iso-b': { id: 'iso-b', pair: ['gone-2', 'gone-1/c'], method: 'primer' },
          'iso-a': { id: 'iso-a', entityId: 'gone-1', method: 'primer' },
          'iso-ok': { id: 'iso-ok', entityId: plate, method: 'primer' },
        },
        acceptances: {
          'galvanic:gone-9|gone-8': { ...acceptance, itemKey: 'galvanic:gone-9|gone-8' },
          'skipped:gone-7': { ...acceptance, itemKey: 'skipped:gone-7' },
          [`galvanic:${plate}|${plate}`]: { ...acceptance, itemKey: `galvanic:${plate}|${plate}` },
        },
      },
    };
    expect(orphanedEntries(dangling).map((orphan) => [orphan.kind, orphan.id, orphan.missing])).toEqual([
      ['acceptance', 'galvanic:gone-9|gone-8', ['gone-8', 'gone-9']],
      ['isolation', 'iso-a', ['gone-1']],
      ['isolation', 'iso-b', ['gone-1', 'gone-2']],
    ]);
  });

  it('remediationOfCor falls back for an unknown code', () => {
    expect(remediationOfCor('COR_REFERENCE_IN_USE')).toContain('remove_isolation');
    expect(remediationOfCor('COR_NO_SUCH_CODE')).toBe('follow the command description');
  });
});
