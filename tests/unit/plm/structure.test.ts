/** 09 PLM M4 (VC-PLM-10, 11): sub-items bound to components, engineering_bom, release with children, baselines and their comparison (S3 steps 1-3). */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { membersHash } from '@plm/structure';
import { T, approveAll } from './fixtures';
import { agentContext, run } from './scenarioRunner';

const HASH_C = 'c'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_A = 'a'.repeat(64);

/** An assembly LL-3000 (in_work) with three components: fitting x2, pin x1, bush x2 (the S3 given). */
function assembly(): CadDocument {
  let doc = createEmptyDocument();
  for (const [componentId, name, instances] of [
    ['comp-fitting', 'Fitting', 2],
    ['comp-pin', 'Pin', 1],
    ['comp-bush', 'Bush', 2],
  ] as const) {
    const added = run(doc, 'add_box', { size: [10, 10, 10] });
    const box = added.affected[0] as string;
    doc = added.document;
    doc = run(doc, 'create_component', { name, entityIds: [box], componentId }).document;
    for (let n = 1; n < instances; n += 1) doc = run(doc, 'insert_instance', { componentId, position: [n * 20, 0, 0] }).document;
  }
  return run(doc, 'set_item_identity', {
    partNumber: 'LL-3000',
    name: 'Hinge assembly',
    itemType: 'assembly',
    policy: { humanSignatureRequired: false },
    at: T,
    by: 'u-1',
  }).document;
}

const bind = (
  doc: CadDocument,
  componentId: string,
  partNumber: string,
  revision: string,
  state: string,
  contentHash?: string,
): CadDocument =>
  run(doc, 'bind_component_item', {
    componentId,
    partNumber,
    revision,
    state,
    ...(contentHash !== undefined ? { contentHash } : {}),
    at: T,
  }).document;

/** The S3 given: every child released. */
function bound(): CadDocument {
  let doc = assembly();
  doc = bind(doc, 'comp-fitting', 'LL-1001', 'B', 'released', HASH_B);
  doc = bind(doc, 'comp-pin', 'LL-1002', 'A', 'released', HASH_A);
  return bind(doc, 'comp-bush', 'LL-1003', 'C', 'released', HASH_C);
}

/** The assembly released as rev A with its three released children. */
function releasedAssembly(): CadDocument {
  const review = run(bound(), 'submit_for_review', { at: T, by: 'u-1' }).document;
  const eco = run(review, 'create_change_order', { id: 'ECO-1', purpose: 'initial-release', at: T, by: 'u-1' }).document;
  return run(approveAll(eco), 'release_item', { changeOrder: 'ECO-1', at: T, by: 'u-1' }).document;
}

const code = (doc: CadDocument, command: string, params: unknown): string | undefined => run(doc, command, params).error?.code;

describe('bind_component_item', () => {
  it('records the child as the signer attests it, under the signer (not a param), and is pure', () => {
    const doc = assembly();
    const before = JSON.stringify(doc);
    const result = run(doc, 'bind_component_item', {
      componentId: 'comp-fitting',
      partNumber: 'LL-1001',
      revision: 'B',
      state: 'released',
      contentHash: HASH_B,
      by: 'liar',
      at: T,
    });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document.plm?.subItems?.['LL-1001']).toMatchObject({
      componentId: 'comp-fitting',
      name: 'Fitting',
      revision: 'B',
      state: 'released',
      contentHash: HASH_B,
      boundBy: 'liar',
      boundAt: T,
    });
    expect(result.affected).toEqual([]);
  });

  it('is a human act: an agent (no key) and an unsigned call get PLM_HUMAN_GATE', () => {
    const doc = assembly();
    const params = { componentId: 'comp-fitting', partNumber: 'LL-1001', revision: 'B', state: 'released', contentHash: HASH_B };
    expect(run(doc, 'bind_component_item', params, agentContext()).error?.code).toBe('PLM_HUMAN_GATE');
    expect(run(doc, 'unbind_component_item', { partNumber: 'LL-1001' }, agentContext()).error?.code).toBe('PLM_HUMAN_GATE');
  });

  it('refuses unknown components, bad part numbers and revisions, the item itself, hashless frozen children and a component bound twice', () => {
    const doc = assembly();
    const base = { componentId: 'comp-fitting', partNumber: 'LL-1001', revision: 'B', state: 'in_work' };
    expect(code(doc, 'bind_component_item', { ...base, componentId: 'comp-none' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'bind_component_item', { ...base, partNumber: 'bad pn!' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'bind_component_item', { ...base, partNumber: 'LL-3000' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'bind_component_item', { ...base, revision: '../x' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'bind_component_item', { ...base, state: 'released' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'bind_component_item', { ...base, contentHash: 'xyz' })).toBe('PLM_PARAM_INVALID');
    expect(code(bind(doc, 'comp-fitting', 'LL-1001', 'B', 'in_work'), 'bind_component_item', { ...base, partNumber: 'LL-1009' })).toBe(
      'PLM_PARAM_INVALID',
    );
  });

  it('re-binding the same part number replaces it; unbind removes it; both need an in_work assembly', () => {
    let doc = bind(assembly(), 'comp-fitting', 'LL-1001', 'B', 'in_work');
    doc = bind(doc, 'comp-fitting', 'LL-1001', 'C', 'in_work');
    expect(doc.plm?.subItems?.['LL-1001']?.revision).toBe('C');
    const locked = run(doc, 'submit_for_review', { at: T, by: 'u-1' }).document;
    expect(code(locked, 'bind_component_item', { componentId: 'comp-pin', partNumber: 'LL-1002', revision: 'A', state: 'in_work' })).toBe(
      'PLM_LOCKED',
    );
    expect(code(locked, 'unbind_component_item', { partNumber: 'LL-1001' })).toBe('PLM_LOCKED');
    expect(code(doc, 'unbind_component_item', { partNumber: 'LL-9' })).toBe('PLM_PARAM_INVALID');
    expect(run(doc, 'unbind_component_item', { partNumber: 'LL-1001' }).document.plm?.subItems).toEqual({});
  });

  it('is refused on a document that is not a managed item', () => {
    expect(
      code(createEmptyDocument(), 'bind_component_item', { componentId: 'c', partNumber: 'LL-1', revision: 'A', state: 'in_work' }),
    ).toBe('PLM_NOT_MANAGED');
    expect(code(createEmptyDocument(), 'unbind_component_item', { partNumber: 'LL-1' })).toBe('PLM_NOT_MANAGED');
  });
});

describe('engineering_bom (VC-PLM-10, S3 step 1)', () => {
  it('lists each child with its revision, state and instance count, and totals them', () => {
    const result = run(bound(), 'engineering_bom', { levels: 'all' });
    expect(result.data).toMatchObject({
      rows: [
        { level: 1, partNumber: 'LL-1001', revision: 'B', quantity: 2, state: 'released' },
        { level: 1, partNumber: 'LL-1002', revision: 'A', quantity: 1, state: 'released' },
        { level: 1, partNumber: 'LL-1003', revision: 'C', quantity: 2, state: 'released' },
      ],
      totalQuantity: 5,
      unreleasedChildren: 0,
      unmanaged: [],
    });
    expect(result.affected).toEqual([]);
  });

  it('reports unreleased children and components without a part number', () => {
    const doc = bind(assembly(), 'comp-fitting', 'LL-1001', 'A', 'in_work');
    const data = run(doc, 'engineering_bom', {}).data as {
      unreleasedChildren: number;
      unreleased: string[];
      unmanaged: { componentId: string; quantity: number }[];
    };
    expect(data.unreleasedChildren).toBe(1);
    expect(data.unreleased).toEqual(['LL-1001']);
    expect(data.unmanaged.map((row) => [row.componentId, row.quantity])).toEqual([
      ['comp-bush', 2],
      ['comp-pin', 1],
    ]);
  });

  it('returns the structure frozen at release for a released revision, and refuses an unknown revision', () => {
    const doc = releasedAssembly();
    const frozen = doc.plm?.item.revisions['A']?.releasedStructure;
    expect(frozen?.map((row) => row.partNumber)).toEqual(['LL-1001', 'LL-1002', 'LL-1003']);
    expect((run(doc, 'engineering_bom', { revision: 'A' }).data as { source: string }).source).toContain('frozen at release of A');
    expect(code(doc, 'engineering_bom', { revision: 'Z' })).toBe('PLM_REVISION_UNKNOWN');
    expect(code(createEmptyDocument(), 'engineering_bom', {})).toBe('PLM_NOT_MANAGED');
  });
});

describe('releasing an assembly (FR-PLM-24)', () => {
  it('is refused with PLM_CHILDREN_UNRELEASED while a child is not released, and readiness reports the same finding', () => {
    const doc = bind(bound(), 'comp-bush', 'LL-1003', 'D', 'in_work');
    const review = run(doc, 'submit_for_review', { at: T, by: 'u-1' }).document;
    const eco = run(review, 'create_change_order', { id: 'ECO-1', purpose: 'initial-release', at: T, by: 'u-1' }).document;
    const ready = approveAll(eco);
    const refused = run(ready, 'release_item', { changeOrder: 'ECO-1', at: T, by: 'u-1' });
    expect(refused.error?.code).toBe('PLM_CHILDREN_UNRELEASED');
    expect(refused.error?.ids).toEqual(['LL-1003']);
    const findings = (run(ready, 'check_release_readiness', {}).data as { findings: { code: string }[] }).findings;
    expect(findings.map((finding) => finding.code)).toContain('PLM_CHILDREN_UNRELEASED');
  });

  it('freezes the structure in the release and in the signed manifest, and the frozen structure no longer moves', () => {
    const doc = releasedAssembly();
    expect(doc.plm?.item.revisions['A']?.state).toBe('released');
    const body = (
      run(doc, 'release_manifest', { revision: 'A' }).data as { body: { structure: { partNumber: string; quantity: number }[] } }
    ).body;
    expect(body.structure.map((row) => [row.partNumber, row.quantity])).toEqual([
      ['LL-1001', 2],
      ['LL-1002', 1],
      ['LL-1003', 2],
    ]);
  });
});

describe('baselines (VC-PLM-11, S3 steps 2-3)', () => {
  it('freezes the released item and its sub-items sorted by part number, with the canonical hash', () => {
    const doc = releasedAssembly();
    const result = run(doc, 'create_baseline', { id: 'BL-PBL-0003', name: 'Hinge PBL', kind: 'product', at: T, by: 'u-7' });
    const baseline = result.document.plm?.baselines?.['BL-PBL-0003'];
    expect(baseline?.members.map((member) => `${member.partNumber} ${member.revision}`)).toEqual([
      'LL-1001 B',
      'LL-1002 A',
      'LL-1003 C',
      'LL-3000 A',
    ]);
    expect(baseline?.members.every((member) => /^[0-9a-f]{64}$/.test(member.contentHash))).toBe(true);
    expect(baseline?.hash).toBe(membersHash(baseline?.members ?? []));
    expect(run(doc, 'create_baseline', { name: 'next', kind: 'custom' }).document.plm?.baselines).toHaveProperty('BL-0001');
  });

  it('refuses an unreleased root or sub-item, a duplicate id and an empty name', () => {
    expect(code(bound(), 'create_baseline', { name: 'x', kind: 'product' })).toBe('PLM_BASELINE_MEMBER_UNRELEASED');
    const doc = releasedAssembly();
    const revised = run(
      run(doc, 'create_change_order', { id: 'ECO-2', classification: 'minor', classificationJustification: 'j', at: T, by: 'u-1' })
        .document,
      'revise_item',
      { changeOrder: 'ECO-2', at: T, by: 'u-1' },
    ).document;
    const withDraft = bind(revised, 'comp-bush', 'LL-1003', 'D', 'in_work');
    const refused = run(withDraft, 'create_baseline', { name: 'x', kind: 'product' });
    expect(refused.error).toMatchObject({ code: 'PLM_BASELINE_MEMBER_UNRELEASED', ids: ['LL-1003'] });
    const first = run(doc, 'create_baseline', { id: 'BL-1', name: 'a', kind: 'functional' }).document;
    expect(code(first, 'create_baseline', { id: 'BL-1', name: 'b', kind: 'functional' })).toBe('PLM_ID_EXISTS');
    expect(code(doc, 'create_baseline', { name: ' ', kind: 'functional' })).toBe('PLM_PARAM_INVALID');
    expect(code(createEmptyDocument(), 'create_baseline', { name: 'x', kind: 'product' })).toBe('PLM_NOT_MANAGED');
  });

  it('a sub-item bound as superseded is allowed in a baseline, but binding needs an in_work assembly', () => {
    const doc = bind(assembly(), 'comp-bush', 'LL-1003', 'C', 'superseded', HASH_C);
    expect(doc.plm?.subItems?.['LL-1003']?.state).toBe('superseded');
    expect(
      code(releasedAssembly(), 'bind_component_item', {
        componentId: 'comp-bush',
        partNumber: 'LL-1003',
        revision: 'C',
        state: 'superseded',
        contentHash: HASH_C,
      }),
    ).toBe('PLM_LOCKED');
  });

  it('compares a baseline with WORKING: the new revisions show as changed (LL-1003 C -> D in_work)', () => {
    const doc = releasedAssembly();
    const baselined = run(doc, 'create_baseline', { id: 'BL-PBL-0003', name: 'Hinge PBL', kind: 'product' }).document;
    const eco = run(baselined, 'create_change_order', {
      id: 'ECO-2',
      classification: 'minor',
      classificationJustification: 'j',
      at: T,
      by: 'u-1',
    }).document;
    const revised = run(eco, 'revise_item', { changeOrder: 'ECO-2', at: T, by: 'u-1' }).document;
    const working = bind(revised, 'comp-bush', 'LL-1003', 'D', 'in_work');
    const data = run(working, 'compare_baselines', { from: 'BL-PBL-0003', to: 'WORKING' }).data as {
      added: unknown[];
      removed: unknown[];
      changed: { partNumber: string; from: string; to: string; toState: string; hashChanged: boolean }[];
    };
    expect(data.added).toEqual([]);
    expect(data.removed).toEqual([]);
    expect(data.changed.map((c) => `${c.partNumber} ${c.from}->${c.to} ${c.toState} ${c.hashChanged}`)).toEqual([
      'LL-1003 C->D in_work true',
      'LL-3000 A->B in_work false',
    ]);
  });

  it('compares two baselines (added and removed members) and refuses an unknown one', () => {
    const doc = releasedAssembly();
    const first = run(doc, 'create_baseline', { id: 'BL-1', name: 'a', kind: 'product' }).document;
    const unbound = run(
      run(first, 'create_change_order', { id: 'ECO-2', classification: 'minor', classificationJustification: 'j' }).document,
      'revise_item',
      { changeOrder: 'ECO-2' },
    ).document;
    const smaller = run(unbound, 'unbind_component_item', { partNumber: 'LL-1002' }).document;
    const second = { ...smaller, plm: { ...smaller.plm, baselines: first.plm?.baselines } } as CadDocument;
    expect(code(second, 'compare_baselines', { from: 'BL-1', to: 'BL-X' })).toBe('PLM_BASELINE_UNKNOWN');
    expect(code(second, 'compare_baselines', { from: 'BL-X', to: 'WORKING' })).toBe('PLM_BASELINE_UNKNOWN');
    const data = run(second, 'compare_baselines', { from: 'BL-1', to: 'WORKING' }).data as { removed: { partNumber: string }[] };
    expect(data.removed.map((member) => member.partNumber)).toEqual(['LL-1002']);
    expect(code(createEmptyDocument(), 'compare_baselines', { from: 'a', to: 'b' })).toBe('PLM_NOT_MANAGED');
  });

  it('a baseline edited by hand fails validation on load', () => {
    const doc = run(releasedAssembly(), 'create_baseline', { id: 'BL-1', name: 'a', kind: 'product' }).document;
    const baseline = doc.plm?.baselines?.['BL-1'];
    const forged = { ...doc, plm: { ...doc.plm, baselines: { 'BL-1': { ...baseline, members: baseline?.members.slice(1) } } } };
    const loaded = run(createEmptyDocument(), 'load_document', {
      json: JSON.stringify({ format: 'llull-document', version: 3, document: forged }),
    });
    expect(loaded.summary).toContain('does not hash to its recorded hash');
    expect(loaded.document.plm).toBeUndefined();
    const intact = run(createEmptyDocument(), 'load_document', {
      json: JSON.stringify({ format: 'llull-document', version: 3, document: doc }),
    });
    expect(intact.document.plm?.baselines?.['BL-1']).toBeDefined();
  });
});
