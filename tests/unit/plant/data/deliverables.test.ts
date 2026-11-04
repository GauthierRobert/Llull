/**
 * Plant 08 DAT-M6 (TR-DAT-28, VC-DAT-15): `set_deliverable_status`. The status machine, the human gate (signature bound to the exact payload, spent once, checks before
 * spending), supersession, scope, persistence, and what a history replay does to a signed status.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { humanGatePayload } from '@core/model/humanGate';
import { withDocumentUid } from '@core/model/documentUid';
import type { CadDocument } from '@core/model/types';
import { copyObject, getPlantData, type DeliverableStep } from '@aec/plant/data/model';
import { plantDataErrors } from '@aec/plant/data/validate';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectBoundToDocument } from '../../../helpers/documentBinding';
import { plantDataPlugin } from '@aec/plant/data/plugin';
import { addEquipment, assignPump, libraryDocument, scDat01Document, withData } from './dataFixtures';

const AT = '2026-11-02T09:30:00Z';

interface Signature {
  readonly payload: string;
  readonly nonce: string;
  readonly signer?: string;
}

/** A port that accepts a signature only for the exact payload it names (what an Ed25519 signature over the payload hash gives) and spends it once. */
function ledgerPort(): { port: HumanSignaturePort; spent: string[] } {
  const spent: string[] = [];
  const port: HumanSignaturePort = {
    verify: (signature, payload) => {
      const sig = signature as Partial<Signature>;
      return sig.payload === payload ? { signer: sig.signer ?? 'alice', signatureId: `sig-${payload.slice(0, 8)}` } : null;
    },
    spend: (signature, payload) => {
      const key = `${(signature as Signature).nonce}|${payload}`;
      if (spent.includes(key)) return false;
      spent.push(key);
      return true;
    },
  };
  return { port, spent };
}

const withPort = (humanSignature: HumanSignaturePort | null): ExecutionContext => ({ ...defaultContext(), humanSignature });

/** The signature a human would produce in the desktop app for this exact act. */
const signFor = (
  deliverable: string,
  details: { revision: string; from: string | null; status: string; contentSha256: string; hierarchyId?: string | null; at?: string },
  nonce = 'n1',
  signer?: string,
): Signature => ({
  payload: humanGatePayload(
    'plant:set_deliverable_status',
    [deliverable],
    withDocumentUid({ hierarchyId: null, at: AT, ...details }, pumpDocument()),
    nonce,
  ),
  nonce,
  ...(signer === undefined ? {} : { signer }),
});

/** Hierarchy, library, one classified pump with a description: check_plant_data passes. */
function pumpDocument(): CadDocument {
  return assignPump(addEquipment(libraryDocument(), { name: 'A' }).doc, 'equipment-1').doc;
}

const level = (
  doc: CadDocument,
  deliverable: string,
  revision: string,
  status: string,
  extra: Record<string, unknown> = {},
  ctx?: ExecutionContext,
): CommandResult => execute(doc, 'set_deliverable_status', { at: AT, deliverable, revision, status, ...extra }, ctx);

const stepsOf = (doc: CadDocument, deliverable: string, revision: string): readonly DeliverableStep[] =>
  getPlantData(doc).deliverables?.[deliverable]?.revisions.find((entry) => entry.label === revision)?.steps ?? [];

describe('status machine (agent steps)', () => {
  it('a new revision starts at in_work, then issued_for_review: steps and the content hash are stored, no feature step, reviewRequired true', () => {
    const doc = pumpDocument();
    const first = level(doc, 'equipment_list', 'A', 'in_work');
    expect(first.rejected).toBeUndefined();
    expect(first.document.featureHistory).toHaveLength(doc.featureHistory.length);
    const second = level(first.document, 'equipment_list', 'A', 'issued_for_review');
    const result = second.data as Record<string, unknown>;
    expect(result).toMatchObject({
      deliverable: 'equipment_list',
      revision: 'A',
      status: 'issued_for_review',
      from: 'in_work',
      reviewRequired: true,
      hierarchy: null,
      superseded: [],
    });
    expect(String(result['reviewReason'])).toContain('not approved');
    expect(second.affected).toEqual(['equipment_list/A']);
    const steps = stepsOf(second.document, 'equipment_list', 'A');
    expect(steps.map((step) => step.status)).toEqual(['in_work', 'issued_for_review']);
    expect(steps[1]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(steps[1]?.signer).toBeUndefined();
  });

  it('the content hash is a function of the content: the same document gives the same hash, an edit gives another', () => {
    const doc = pumpDocument();
    const a = level(doc, 'tag_register', 'A', 'issued_for_review').data as { contentSha256: string };
    const b = level(doc, 'tag_register', 'B', 'issued_for_review').data as { contentSha256: string };
    expect(a.contentSha256).toBe(b.contentSha256);
    const edited = apply(doc, 'set_plant_properties', {
      edits: [{ object: getPlantData(doc).objectOrder[0], property: 'Description', value: 'changed' }],
    });
    const c = level(edited, 'equipment_list', 'A', 'issued_for_review').data as { contentSha256: string };
    const d = level(doc, 'equipment_list', 'A', 'issued_for_review').data as { contentSha256: string };
    expect(c.contentSha256).not.toBe(d.contentSha256);
  });

  it('refuses a skipped step, a step back, a repeat, and a final state (DAT_STATUS_TRANSITION) with the allowed list', () => {
    const doc = pumpDocument();
    const reviewed = level(doc, 'tag_register', 'A', 'issued_for_review').document;
    for (const [from, status] of [
      [doc, 'issued_for_approval'],
      [reviewed, 'issued_for_construction'],
      [reviewed, 'in_work'],
      [reviewed, 'issued_for_review'],
    ] as const) {
      const result = expectRefusal(
        from,
        'set_deliverable_status',
        { at: AT, deliverable: 'tag_register', revision: 'A', status },
        'DAT_STATUS_TRANSITION',
      );
      expect(result.summary).toContain('allowed:');
    }
  });

  it('superseded cannot be set by hand (the schema refuses it)', () => {
    const doc = pumpDocument();
    const result = level(doc, 'tag_register', 'A', 'superseded');
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(doc);
  });

  it('refuses an unknown deliverable, an unknown hierarchy, a scope on ifc and a scope change', () => {
    const doc = pumpDocument();
    expectRefusal(
      doc,
      'set_deliverable_status',
      { at: AT, deliverable: 'nope', revision: 'A', status: 'in_work' },
      'DAT_PARAM_INVALID',
      'deliverable',
    );
    expectRefusal(
      doc,
      'set_deliverable_status',
      { at: AT, deliverable: 'mto', revision: 'A', status: 'in_work', hierarchy: 'ZZ' },
      'DAT_HIERARCHY_UNKNOWN',
    );
    expectRefusal(
      doc,
      'set_deliverable_status',
      { at: AT, deliverable: 'ifc', revision: 'A', status: 'in_work', hierarchy: 'U10' },
      'DAT_PARAM_INVALID',
      'hierarchy',
    );
    const scoped = level(doc, 'tag_register', 'A', 'in_work', { hierarchy: 'S1/P1/U10' });
    expect((scoped.data as { hierarchy: string }).hierarchy).toBe('S1/P1/U10');
    expectRefusal(
      scoped.document,
      'set_deliverable_status',
      { at: AT, deliverable: 'tag_register', revision: 'A', status: 'issued_for_review', hierarchy: 'P2' },
      'DAT_PARAM_INVALID',
      'hierarchy',
    );
  });

  it('is pure: the input document is not mutated', () => {
    const doc = pumpDocument();
    const before = JSON.stringify(doc);
    level(doc, 'tag_register', 'A', 'issued_for_review');
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('a saved report definition is a deliverable by its id', () => {
    const doc = apply(pumpDocument(), 'save_report_definition', { id: 'pumps', kind: 'equipment_list', columns: ['tag', 'className'] });
    const result = level(doc, 'pumps', 'A', 'issued_for_review');
    expect(result.rejected).toBeUndefined();
    const base = level(doc, 'equipment_list', 'A', 'issued_for_review').data as { contentSha256: string };
    expect((result.data as { contentSha256: string }).contentSha256).not.toBe(base.contentSha256);
  });
});

describe('the human gate (VC-DAT-15)', () => {
  const reviewed = (): { doc: CadDocument; sha: string } => {
    const result = level(pumpDocument(), 'equipment_list', 'A', 'issued_for_review');
    return { doc: result.document, sha: (result.data as { contentSha256: string }).contentSha256 };
  };
  const approval = (sha: string, nonce = 'n1'): Signature =>
    signFor('equipment_list', { revision: 'A', from: 'issued_for_review', status: 'issued_for_approval', contentSha256: sha }, nonce);

  it('a signature made for one document does not verify in a copy of it (GATE-UID)', () => {
    expectBoundToDocument(
      reviewed().doc,
      (document, confirmation, ctx) => level(document, 'equipment_list', 'A', 'issued_for_approval', { confirmation }, ctx),
      'DAT_HUMAN_GATE',
    );
  });

  it('an agent (no confirmation, true, no port, a foreign signature, no nonce) never reaches a signed status and nothing is spent', () => {
    const { doc, sha } = reviewed();
    const { port, spent } = ledgerPort();
    const foreign = signFor('equipment_list', {
      revision: 'B',
      from: 'issued_for_review',
      status: 'issued_for_approval',
      contentSha256: sha,
    });
    for (const [confirmation, ctx] of [
      [undefined, withPort(port)],
      [false, withPort(port)],
      [true, withPort(port)],
      [approval(sha), withPort(null)],
      [foreign, withPort(port)],
      [{ payload: approval(sha).payload }, withPort(port)],
    ] as const) {
      const result = execute(
        doc,
        'set_deliverable_status',
        { at: AT, deliverable: 'equipment_list', revision: 'A', status: 'issued_for_approval', confirmation },
        ctx,
      );
      expect(result.error?.code, result.summary).toBe('DAT_HUMAN_GATE');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
    expect(spent).toEqual([]);
  });

  it('a verified signature bound to this payload approves: signer and signature id stored, reviewRequired false', () => {
    const { doc, sha } = reviewed();
    const { port, spent } = ledgerPort();
    const result = level(
      doc,
      'equipment_list',
      'A',
      'issued_for_approval',
      {
        confirmation: signFor(
          'equipment_list',
          { revision: 'A', from: 'issued_for_review', status: 'issued_for_approval', contentSha256: sha },
          'n1',
          'carol',
        ),
      },
      withPort(port),
    );
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ status: 'issued_for_approval', signer: 'carol', reviewRequired: false, contentSha256: sha });
    expect(spent).toHaveLength(1);
    const step = stepsOf(result.document, 'equipment_list', 'A').at(-1);
    expect(step).toMatchObject({ status: 'issued_for_approval', signer: 'carol', contentSha256: sha });
    expect(step?.signatureId).toMatch(/^sig-/);
  });

  it('the signature is bound to the content: after an edit the old signature no longer verifies', () => {
    const { doc, sha } = reviewed();
    const edited = apply(doc, 'set_plant_properties', {
      edits: [{ object: getPlantData(doc).objectOrder[0], property: 'Description', value: 'changed after the review' }],
    });
    const { port, spent } = ledgerPort();
    const result = level(edited, 'equipment_list', 'A', 'issued_for_approval', { confirmation: approval(sha) }, withPort(port));
    expect(result.error?.code).toBe('DAT_HUMAN_GATE');
    expect(spent).toEqual([]);
  });

  it('is bound to the previous status and spent once: the same signature cannot replay the act (undo / resend)', () => {
    const { doc, sha } = reviewed();
    const { port } = ledgerPort();
    const confirmation = approval(sha);
    expect(level(doc, 'equipment_list', 'A', 'issued_for_approval', { confirmation }, withPort(port)).error).toBeUndefined();
    const again = level(doc, 'equipment_list', 'A', 'issued_for_approval', { confirmation }, withPort(port));
    expect(again.error?.code).toBe('DAT_HUMAN_GATE');
    expect(again.document).toBe(doc);
  });

  it('check_plant_data runs before the gate: a failing finding refuses with DAT_CHECK_FAILED and the signature is not spent', () => {
    const broken = withData(reviewed().doc, (current) => {
      const id = current.objectOrder[0] as string;
      return { ...current, objects: { ...current.objects, [id]: copyObject(current.objects[id]!, { tag: 'WRONG-TAG' }) } };
    });
    const { port, spent } = ledgerPort();
    const content = stepsOf(broken, 'equipment_list', 'A').at(-1)?.contentSha256 ?? '';
    const result = level(broken, 'equipment_list', 'A', 'issued_for_approval', { confirmation: approval(content) }, withPort(port));
    expect(result.error?.code).toBe('DAT_CHECK_FAILED');
    expect(result.error?.ids.length).toBeGreaterThan(0);
    expect(result.summary).toContain('DAT_TAG_FORMAT');
    expect(spent).toEqual([]);
  });

  it('the check covers the deliverable scope only: a failure outside the scoped node does not block', () => {
    const base = pumpDocument();
    const scoped = level(base, 'equipment_list', 'A', 'issued_for_review', { hierarchy: 'P2' });
    const broken = withData(scoped.document, (current) => {
      const id = current.objectOrder[0] as string;
      return { ...current, objects: { ...current.objects, [id]: copyObject(current.objects[id]!, { tag: 'WRONG-TAG' }) } };
    });
    const content = (scoped.data as { contentSha256: string }).contentSha256;
    const { port } = ledgerPort();
    const signature = signFor('equipment_list', {
      revision: 'A',
      from: 'issued_for_review',
      status: 'issued_for_approval',
      contentSha256: content,
      hierarchyId: Object.values(getPlantData(base).hierarchy).find((node) => node.code === 'P2')?.id ?? null,
    });
    const inScope = level(broken, 'equipment_list', 'A', 'issued_for_approval', { confirmation: signature }, withPort(port));
    expect(inScope.error, inScope.summary).toBeUndefined();
  });
});

describe('supersession', () => {
  it('a newer revision issued at the same or a higher status supersedes the older one, which can then not move', () => {
    const doc = pumpDocument();
    const a = level(doc, 'tag_register', 'A', 'issued_for_review').document;
    const b = level(a, 'tag_register', 'B', 'issued_for_review');
    expect((b.data as { superseded: string[] }).superseded).toEqual(['A']);
    expect(stepsOf(b.document, 'tag_register', 'A').map((step) => step.status)).toEqual(['issued_for_review', 'superseded']);
    expectRefusal(
      b.document,
      'set_deliverable_status',
      { at: AT, deliverable: 'tag_register', revision: 'A', status: 'issued_for_approval' },
      'DAT_STATUS_TRANSITION',
    );
  });

  it('an agent review issue never retires a signed revision; the signed issue of the newer revision does', () => {
    const doc = pumpDocument();
    const { port } = ledgerPort();
    const ctx = withPort(port);
    const reviewA = level(doc, 'tag_register', 'A', 'issued_for_review');
    const shaA = (reviewA.data as { contentSha256: string }).contentSha256;
    const approvedA = level(
      reviewA.document,
      'tag_register',
      'A',
      'issued_for_approval',
      {
        confirmation: signFor('tag_register', {
          revision: 'A',
          from: 'issued_for_review',
          status: 'issued_for_approval',
          contentSha256: shaA,
        }),
      },
      ctx,
    );
    expect(approvedA.error).toBeUndefined();
    const reviewB = level(approvedA.document, 'tag_register', 'B', 'issued_for_review');
    expect((reviewB.data as { superseded: string[] }).superseded).toEqual([]);
    expect(stepsOf(reviewB.document, 'tag_register', 'A').at(-1)?.status).toBe('issued_for_approval');
    const approvedB = level(
      reviewB.document,
      'tag_register',
      'B',
      'issued_for_approval',
      {
        confirmation: signFor(
          'tag_register',
          { revision: 'B', from: 'issued_for_review', status: 'issued_for_approval', contentSha256: shaA },
          'n2',
        ),
      },
      ctx,
    );
    expect((approvedB.data as { superseded: string[] }).superseded).toEqual(['A']);
    expect(stepsOf(approvedB.document, 'tag_register', 'A').at(-1)?.status).toBe('superseded');
  });
});

describe('the IFC deliverable', () => {
  it('hashes the IFC4X3_ADD2 export: reproducible, and changed by an edit of the plant', () => {
    const doc = scDat01Document();
    const a = (level(doc, 'ifc', 'A', 'issued_for_review').data as { contentSha256: string }).contentSha256;
    const b = (level(doc, 'ifc', 'B', 'issued_for_review').data as { contentSha256: string }).contentSha256;
    expect(a).toBe(b);
    const ifc = data<{ ifc: string }>(doc, 'export_ifc', { schema: 'IFC4X3_ADD2' }).ifc;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ifc.length).toBeGreaterThan(1000);
    const edited = apply(doc, 'set_plant_properties', {
      edits: [{ object: getPlantData(doc).objectOrder[0], property: 'Description', value: 'another description' }],
    });
    expect((level(edited, 'ifc', 'A', 'issued_for_review').data as { contentSha256: string }).contentSha256).not.toBe(a);
  });
});

describe('persistence, replay and regeneration', () => {
  const signedDocument = (): { doc: CadDocument; ctx: ExecutionContext } => {
    const base = pumpDocument();
    const reviewed = level(base, 'tag_register', 'A', 'issued_for_review');
    const sha = (reviewed.data as { contentSha256: string }).contentSha256;
    const ctx = withPort(ledgerPort().port);
    const approved = level(
      reviewed.document,
      'tag_register',
      'A',
      'issued_for_approval',
      {
        confirmation: signFor('tag_register', {
          revision: 'A',
          from: 'issued_for_review',
          status: 'issued_for_approval',
          contentSha256: sha,
        }),
      },
      ctx,
    );
    expect(approved.error, approved.summary).toBeUndefined();
    return { doc: approved.document, ctx };
  };

  it('save and load keep the deliverables byte for byte', () => {
    const { doc } = signedDocument();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(JSON.stringify(getPlantData(loaded).deliverables)).toBe(JSON.stringify(getPlantData(doc).deliverables));
  });

  it('a hand-edited file is refused: a signed step without a signer, a bad hash, a repeated revision label, a bad status', () => {
    const { doc } = signedDocument();
    const mutate = (change: (revision: { label: string; steps: Array<Record<string, unknown>> }) => void): string[] => {
      const copy = JSON.parse(JSON.stringify(getPlantData(doc))) as {
        deliverables: Record<string, { revisions: Array<{ label: string; steps: Array<Record<string, unknown>> }> }>;
      };
      change(copy.deliverables['tag_register']!.revisions[0]!);
      return plantDataErrors(copy);
    };
    expect(mutate((revision) => delete revision.steps[1]!['signer'])).toEqual([expect.stringContaining('payloadSha256')]);
    expect(mutate((revision) => (revision.steps[0]!['contentSha256'] = 'abc'))).toEqual([expect.stringContaining('64 hex')]);
    expect(mutate((revision) => (revision.steps[0]!['status'] = 'done'))).toEqual([expect.stringContaining('status')]);
    expect(mutate((revision) => (revision.steps = []))).toEqual([expect.stringContaining('steps must not be empty')]);
    expect(plantDataErrors({ ...getPlantData(doc), deliverables: [] })).toEqual(['plant.data.deliverables must be an object']);
    expect(plantDataErrors({ ...getPlantData(doc), deliverables: { x: { id: 'y', revisions: [] } } })).toEqual([
      expect.stringContaining('its key'),
    ]);
    const twice = JSON.parse(JSON.stringify(getPlantData(doc))) as { deliverables: Record<string, { revisions: unknown[] }> };
    twice.deliverables['tag_register']!.revisions.push(twice.deliverables['tag_register']!.revisions[0]);
    expect(plantDataErrors(twice)).toEqual([expect.stringContaining('used twice')]);
    const malformed = JSON.parse(JSON.stringify(getPlantData(doc))) as { deliverables: Record<string, { revisions: unknown[] }> };
    malformed.deliverables['tag_register']!.revisions = [{ label: '' }];
    expect(plantDataErrors(malformed)).toEqual([expect.stringContaining('must be { label')]);
  });

  it('REPLAY: a history replay keeps the signed status (the step is not a recipe step, the signature is never run twice)', () => {
    const { doc, ctx } = signedDocument();
    expect(doc.featureHistory.some((step) => step.name === 'set_deliverable_status')).toBe(false);
    const replayed = execute(doc, 'replay_history', {}, ctx);
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(replayed.document).not.toBe(doc);
    expect(JSON.stringify(getPlantData(replayed.document).deliverables)).toBe(JSON.stringify(getPlantData(doc).deliverables));
    expect(stepsOf(replayed.document, 'tag_register', 'A').at(-1)?.status).toBe('issued_for_approval');
  });

  it('REGENERATE: editing a step param that regenerates the plant keeps the signed status, and the register reports the content as no longer current', () => {
    const { doc, ctx } = signedDocument();
    const assign = doc.featureHistory.find((step) => step.name === 'assign_plant_object');
    const stepId = assign?.id as string;
    const edited = execute(
      doc,
      'edit_step_params',
      { stepId, params: { ...(assign?.params as object), properties: { Description: 'edited by a step edit', DesignPressure: 10 } } },
      ctx,
    );
    expect(edited.rejected, edited.summary).toBeUndefined();
    const object = getPlantData(edited.document).objects[getPlantData(edited.document).objectOrder[0] as string];
    expect(object?.properties['Description']).toBe('edited by a step edit');
    expect(stepsOf(edited.document, 'tag_register', 'A').at(-1)?.status).toBe('issued_for_approval');
    const register = data<{ registers: { document_register: { rows: Array<Record<string, unknown>> } } }>(
      edited.document,
      'export_handover',
      { profile: 'generic', registers: ['document_register'] },
    );
    expect(register.registers.document_register.rows[0]).toMatchObject({
      Deliverable: 'tag_register',
      Status: 'issued_for_approval',
      ContentCurrent: expect.any(Boolean),
    });
  });
});

describe('agent-chosen keys never reach the prototype', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    '%s is an unknown deliverable, definition, node, class and object',
    (key) => {
      const saved = apply(pumpDocument(), 'save_report_definition', { id: 'tags', kind: 'tag_register' });
      const doc = level(saved, 'tags', 'A', 'in_work').document; // reports and deliverables exist, so a prototype key would find something
      expectRefusal(
        doc,
        'set_deliverable_status',
        { at: AT, deliverable: key, revision: 'A', status: 'in_work' },
        'DAT_PARAM_INVALID',
        'deliverable',
      );
      expectRefusal(doc, 'plant_report', { definition: key }, 'DAT_PARAM_INVALID', 'definition');
      expectRefusal(doc, 'check_plant_data', { hierarchy: key }, 'DAT_HIERARCHY_UNKNOWN');
      expectRefusal(doc, 'check_plant_data', { classes: [key] }, 'DAT_CLASS_UNKNOWN');
      expectRefusal(doc, 'plant_data_table', { className: key }, 'DAT_CLASS_UNKNOWN');
      expectRefusal(doc, 'define_plant_class', { name: 'Ok', parent: key }, 'DAT_CLASS_PARENT_UNKNOWN');
      expectRefusal(doc, 'renumber_tags', { className: key, startSequence: 1 }, 'DAT_CLASS_UNKNOWN');
      expectRefusal(doc, 'set_plant_properties', { edits: [{ object: key, property: 'Description', value: 'x' }] }, 'DAT_OBJECT_UNKNOWN');
      // a revision label is data, not a key: any text is a plain label
      const labelled = level(doc, 'tag_register', key, 'in_work');
      expect(labelled.rejected).toBeUndefined();
      expect(stepsOf(labelled.document, 'tag_register', key)).toHaveLength(1);
    },
  );
});

describe('revision scope', () => {
  const nodeId = (doc: CadDocument, code: string): string =>
    Object.values(getPlantData(doc).hierarchy).find((node) => node.code === code)?.id ?? '';

  it('supersession only retires revisions with the same scope (two scoped revisions of one saved report)', () => {
    const doc = apply(pumpDocument(), 'save_report_definition', { id: 'tags', kind: 'tag_register' });
    const unit = level(doc, 'tags', 'U', 'issued_for_review', { hierarchy: 'U10' }).document;
    const plant2 = level(unit, 'tags', 'P', 'issued_for_review', { hierarchy: 'P2' });
    expect((plant2.data as { superseded: string[] }).superseded).toEqual([]);
    expect(stepsOf(plant2.document, 'tags', 'U').map((step) => step.status)).toEqual(['issued_for_review']);
    const unit2 = level(plant2.document, 'tags', 'V', 'issued_for_review', { hierarchy: 'U10' });
    expect((unit2.data as { superseded: string[] }).superseded).toEqual(['U']);
    expect(stepsOf(unit2.document, 'tags', 'P').map((step) => step.status)).toEqual(['issued_for_review']);
    const whole = level(unit2.document, 'tags', 'W', 'issued_for_review');
    expect((whole.data as { superseded: string[] }).superseded).toEqual([]);
  });

  it('an existing revision keeps the scope it was created with: a later hierarchy of the saved definition is never used', () => {
    const base = apply(pumpDocument(), 'save_report_definition', { id: 'tags', kind: 'tag_register' });
    const first = level(base, 'tags', 'A', 'in_work');
    expect((first.data as { hierarchy: string | null }).hierarchy).toBeNull();
    const rescoped = apply(first.document, 'save_report_definition', { id: 'tags', kind: 'tag_register', hierarchy: 'P2' });
    const second = level(rescoped, 'tags', 'A', 'issued_for_review');
    expect((second.data as { hierarchy: string | null }).hierarchy).toBeNull();
    expect(getPlantData(second.document).deliverables?.['tags']?.revisions[0]?.hierarchyId).toBeUndefined();
    const created = level(rescoped, 'tags', 'B', 'in_work');
    expect((created.data as { hierarchy: string | null }).hierarchy).toBe('S1/P2');
    const stored = getPlantData(created.document).deliverables?.['tags']?.revisions.find((revision) => revision.label === 'B');
    expect(stored?.hierarchyId).toBe(nodeId(rescoped, 'P2'));
  });

  it('a revision whose scope node was dropped (regenerate) is named in the refusal, the load warning and the document register', () => {
    const scoped = level(pumpDocument(), 'tag_register', 'A', 'in_work', { hierarchy: 'P2' }).document;
    const dropped = withData(scoped, (current) => {
      const id = nodeId(scoped, 'P2');
      const { [id]: removed, ...hierarchy } = current.hierarchy;
      void removed;
      return { ...current, hierarchy, hierarchyOrder: current.hierarchyOrder.filter((entry) => entry !== id) };
    });
    const refusal = expectRefusal(
      dropped,
      'set_deliverable_status',
      { at: AT, deliverable: 'tag_register', revision: 'A', status: 'issued_for_review' },
      'DAT_HIERARCHY_UNKNOWN',
    );
    expect(refusal.summary).toContain('no longer exists');
    expect(plantDataPlugin.document?.afterLoad?.(dropped)).toEqual([expect.stringContaining('no longer exists')]);
    expect(getPlantData(deserializeDocument(serializeDocument(dropped))).deliverables?.['tag_register']).toBeDefined();
    const rows = data<{ registers: { document_register: { rows: Array<Record<string, unknown>> } } }>(dropped, 'export_handover', {
      profile: 'generic',
      registers: ['document_register'],
    }).registers.document_register.rows;
    expect(rows[0]).toMatchObject({ ContentCurrent: '', IssuedAt: AT });
    expect(String(rows[0]?.['Scope'])).toContain('(missing)');
  });
});

describe('what a signed step records', () => {
  it('stores at, the signer and the payload hash that was signed; a signature over another time does not verify', () => {
    const reviewed = level(pumpDocument(), 'equipment_list', 'A', 'issued_for_review');
    const sha = (reviewed.data as { contentSha256: string }).contentSha256;
    const details = { revision: 'A', from: 'issued_for_review', status: 'issued_for_approval', contentSha256: sha };
    const { port, spent } = ledgerPort();
    const later = signFor('equipment_list', { ...details, at: '2026-11-03T00:00:00Z' });
    const refused = level(reviewed.document, 'equipment_list', 'A', 'issued_for_approval', { confirmation: later }, withPort(port));
    expect(refused.error?.code).toBe('DAT_HUMAN_GATE');
    expect(spent).toEqual([]);
    const good = signFor('equipment_list', details);
    const approved = level(reviewed.document, 'equipment_list', 'A', 'issued_for_approval', { confirmation: good }, withPort(port));
    expect(stepsOf(approved.document, 'equipment_list', 'A').at(-1)).toMatchObject({
      at: AT,
      payloadSha256: good.payload,
      signer: 'alice',
    });
  });

  it('DAT_CHECK_FAILED on the IFC deliverable refuses before the signature is spent', () => {
    const reviewed = level(scDat01Document(), 'ifc', 'A', 'issued_for_review');
    const broken = withData(reviewed.document, (current) => {
      const id = current.objectOrder[0] as string;
      return { ...current, objects: { ...current.objects, [id]: copyObject(current.objects[id]!, { tag: 'WRONG-TAG' }) } };
    });
    const content = data<{ contentSha256: string }>(broken, 'set_deliverable_status', {
      at: AT,
      deliverable: 'ifc',
      revision: 'B',
      status: 'in_work',
    }).contentSha256;
    const { port, spent } = ledgerPort();
    const signature = signFor('ifc', { revision: 'A', from: 'issued_for_review', status: 'issued_for_approval', contentSha256: content });
    const result = level(broken, 'ifc', 'A', 'issued_for_approval', { confirmation: signature }, withPort(port));
    expect(result.error?.code).toBe('DAT_CHECK_FAILED');
    expect(spent).toEqual([]);
  });
});
