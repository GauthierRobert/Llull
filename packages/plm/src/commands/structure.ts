/** Product structure commands (FR-PLM-23/24): bind components to managed items, the EBOM, baselines and their comparison. */

import { nextFreeId } from '@lib/id';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { Baseline, SubItem } from '@core/model/plm';
import { PART_NUMBER } from '../document';
import { humanAct } from '../gate';
import { atSchema, bySchema, confirmationSchema } from '../params';
import { refusePlm } from '../refusal';
import { withPlm } from '../revisions';
import { REVISION_LABEL } from '../schemes';
import { NOT_MANAGED, currentRevisionOf, revisionText } from '../state';
import {
  baselineRoot,
  isFrozenState,
  liveStructure,
  membersHash,
  unmanagedComponents,
  unreleasedChildren,
  workingMembers,
} from '../structure';

const HASH = /^[0-9a-f]{64}$/;

/**
 * @affects doc.plm.subItems[partNumber] (binds a component of this document to a managed item of another document, with the revision and state attested)
 * @invariant a human attests the child's revision / state / content hash (signed over exactly these params): an agent cannot declare a child released;
 *   one component binds one part number; only while the assembly's own revision is in_work (the structure is frozen at release)
 * @failure agent / no trusted signature -> PLM_HUMAN_GATE; unknown component, bad part number or revision, the item itself, a frozen state without a
 *   content hash, a component already bound to another part number -> PLM_PARAM_INVALID; assembly revision not in_work -> PLM_LOCKED (refusals, unchanged doc)
 */
export const bindComponentItem = defineCommand({
  name: 'bind_component_item',
  description:
    'Bind a component of this assembly (doc.components) to a managed item of another document: part number, revision, lifecycle state and, ' +
    'for a released / superseded / obsolete child, its release content hash (64 hex). HUMAN GATE. The signer attests these facts; llull cannot read the child ' +
    'document from here, and an agent can never declare a child released. Re-binding the same part number replaces its record (e.g. a new revision). ' +
    'Allowed only while this assembly revision is in_work. Needs `confirmation` (plm_act_payload): an agent gets PLM_HUMAN_GATE and hands over.',
  annotations: { metaHistory: true },
  params: z.object({
    componentId: z.string().describe('Id of a component of this document (doc.components); its instances are the quantity in the EBOM.'),
    partNumber: z.string().describe('Part number of the managed item this component is (A-Z 0-9 . _ - /, at most 64 characters).'),
    name: z.string().optional().describe('Item name; default = the component name.'),
    revision: z.string().describe('Revision label of the child that this assembly uses, e.g. "B".'),
    state: z
      .enum(['in_work', 'in_review', 'released', 'superseded', 'obsolete', 'cancelled'])
      .describe('Lifecycle state of that child revision, as the signer attests it.'),
    contentHash: z
      .string()
      .optional()
      .describe('Release content hash (64 lowercase hex) of that child revision; required when state is released, superseded or obsolete.'),
    confirmation: confirmationSchema,
    at: atSchema.optional(),
    by: bySchema.optional().describe('Ignored: the binding is recorded under the signer of the confirmation.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'bind_component_item', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanAct(doc, 'bind_component_item', params, ctx);
    if ('refusal' in gate) return gate.refusal;
    const { componentId, partNumber, revision, state, contentHash } = params;
    const invalid = (message: string, path: string): CommandResult =>
      refusePlm(doc, 'bind_component_item', 'PLM_PARAM_INVALID', message, [componentId, partNumber], [path]);
    const component = doc.components[componentId];
    if (component === undefined) return invalid(`no component '${componentId}' in this document`, 'componentId');
    if (!PART_NUMBER.test(partNumber)) return invalid(`'${partNumber}' is not a valid part number`, 'partNumber');
    if (partNumber === plm.item.partNumber) return invalid(`${partNumber} is this assembly itself`, 'partNumber');
    if (!REVISION_LABEL.test(revision)) return invalid(`'${revision}' is not a revision label (1-16 of A-Z, 0-9, -)`, 'revision');
    if (isFrozenState(state) && (contentHash === undefined || !HASH.test(contentHash)))
      return invalid(`a ${state} child needs its release contentHash (64 lowercase hex)`, 'contentHash');
    if (contentHash !== undefined && !HASH.test(contentHash))
      return invalid('contentHash must be 64 lowercase hex characters', 'contentHash');
    const taken = Object.values(plm.subItems ?? {}).find((sub) => sub.componentId === componentId && sub.partNumber !== partNumber);
    if (taken !== undefined) return invalid(`component ${componentId} is already bound to ${taken.partNumber}`, 'componentId');
    const own = currentRevisionOf(plm);
    if (own?.state !== 'in_work')
      return refusePlm(
        doc,
        'bind_component_item',
        'PLM_LOCKED',
        `${revisionText(plm)} is ${own?.state ?? 'missing'}; the structure changes only in an in_work revision (open an ECO and revise_item)`,
        [plm.item.partNumber],
      );
    const sub: SubItem = {
      partNumber,
      name: params.name ?? component.name,
      componentId,
      revision,
      state,
      ...(contentHash !== undefined ? { contentHash } : {}),
      boundBy: gate.signer,
      ...(params.at !== undefined ? { boundAt: params.at } : {}),
    };
    return changed(
      withPlm(doc, { ...plm, subItems: { ...plm.subItems, [partNumber]: sub } }),
      `${plm.item.partNumber}: component ${componentId} bound to ${partNumber} rev ${revision} (${state}) by ${gate.signer}.`,
      [],
    );
  },
});

/**
 * @affects doc.plm.subItems (removes one binding)
 * @invariant same gate and same in_work rule as bind_component_item
 * @failure agent -> PLM_HUMAN_GATE; unknown part number -> PLM_PARAM_INVALID; revision not in_work -> PLM_LOCKED (refusals, unchanged doc)
 */
export const unbindComponentItem = defineCommand({
  name: 'unbind_component_item',
  description:
    'Remove the binding of a sub-item (by part number) from this assembly. HUMAN GATE. Allowed only while the assembly revision is in_work. Needs `confirmation` ' +
    '(plm_act_payload): an agent gets PLM_HUMAN_GATE.',
  annotations: { destructive: true, metaHistory: true },
  params: z.object({
    partNumber: z.string().describe('Part number of the bound sub-item to remove.'),
    confirmation: confirmationSchema,
    at: atSchema.optional(),
    by: bySchema.optional().describe('Ignored.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'unbind_component_item', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanAct(doc, 'unbind_component_item', params, ctx);
    if ('refusal' in gate) return gate.refusal;
    const { partNumber } = params;
    if (plm.subItems?.[partNumber] === undefined)
      return refusePlm(doc, 'unbind_component_item', 'PLM_PARAM_INVALID', `no sub-item ${partNumber}`, [partNumber], ['partNumber']);
    const own = currentRevisionOf(plm);
    if (own?.state !== 'in_work')
      return refusePlm(
        doc,
        'unbind_component_item',
        'PLM_LOCKED',
        `${revisionText(plm)} is ${own?.state ?? 'missing'}; revise_item first`,
        [plm.item.partNumber],
      );
    const rest = Object.fromEntries(Object.entries(plm.subItems).filter(([key]) => key !== partNumber));
    return changed(withPlm(doc, { ...plm, subItems: rest }), `${plm.item.partNumber}: sub-item ${partNumber} unbound.`, []);
  },
});

/**
 * @affects nothing (read-only)
 * @invariant level 1 of this definition only: a child's own structure lives in the child's document; a released revision reports its frozen structure
 */
export const engineeringBom = defineCommand({
  name: 'engineering_bom',
  description:
    'Engineering bill of materials of the managed PLM assembly (by part number and revision; for a plain parts/mass count of any document use bill_of_materials, for building quantities quantity_takeoff): one row per bound sub-item { level, partNumber, revision, state, quantity } where quantity is ' +
    'the number of instances of its component placed in this document, the total, how many children are not released and the components with instances ' +
    "that no sub-item covers. Only level 1 is available from one document (a child's own structure is in its own document). For a released revision the " +
    'structure frozen at release is returned. Extends bill_of_materials, which counts components and materials. Read-only.',
  annotations: { readOnly: true },
  params: z.object({
    levels: z
      .union([z.number().int().min(1), z.literal('all')])
      .optional()
      .describe('Levels wanted; only level 1 exists in one document (default "all" = 1).'),
    revision: z.string().optional().describe('A released revision whose frozen structure to return; default = the live structure.'),
  }),
  run: (doc, { revision: label }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'engineering_bom', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const named = label === undefined ? undefined : plm.item.revisions[label];
    if (label !== undefined && named === undefined)
      return refusePlm(doc, 'engineering_bom', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [label]);
    const frozen = named?.releasedStructure;
    const structure = frozen ?? liveStructure(doc, plm);
    const rows = structure.map((row) => ({ level: 1, ...row }));
    const unreleased =
      frozen === undefined ? unreleasedChildren(plm) : structure.filter((row) => row.state !== 'released').map((row) => row.partNumber);
    const totalQuantity = structure.reduce((sum, row) => sum + row.quantity, 0);
    const unmanaged = unmanagedComponents(doc, plm);
    return report(
      doc,
      `${plm.item.partNumber} EBOM${label === undefined ? '' : ` rev ${label}`}: ${rows.length} item(s), ${totalQuantity} instance(s), ${unreleased.length} unreleased child(ren)` +
        `${unmanaged.length > 0 ? `, ${unmanaged.length} component(s) without a part number` : ''}.`,
      {
        rows,
        totalQuantity,
        unreleasedChildren: unreleased.length,
        unreleased,
        unmanaged,
        source: frozen === undefined ? 'live structure' : `structure frozen at release of ${label}`,
      },
    );
  },
});

const nextBaselineId = (ids: readonly string[]): string => nextFreeId('BL', (id) => ids.includes(id), { pad: 4, start: ids.length + 1 });

/**
 * @affects doc.plm.baselines[id] (adds a baseline: the item's latest released revision plus every bound sub-item, sorted by part number, hash = sha256(jcs(members)))
 * @invariant members are released or superseded only; a baseline is never edited (no command changes or removes one; a hand edit breaks its hash on load)
 * @failure not managed -> PLM_NOT_MANAGED; the item has no released revision or a sub-item is not released / superseded -> PLM_BASELINE_MEMBER_UNRELEASED;
 *   duplicate id -> PLM_ID_EXISTS; empty name -> PLM_PARAM_INVALID (refusals, unchanged doc)
 */
export const createBaseline = defineCommand({
  name: 'create_baseline',
  description:
    'Freeze the product structure as a baseline (functional, allocated, product or custom): the managed item at its latest released revision plus every ' +
    'bound sub-item at its bound revision, each with its content hash, sorted by part number, hashed as SHA-256 of the canonical member list. Every member ' +
    'must be released or superseded; otherwise refused with PLM_BASELINE_MEMBER_UNRELEASED naming it. Baselines are never edited. An agent may create one: ' +
    'it can only freeze what humans released and bound. Compare later with compare_baselines.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().optional().describe("Baseline id; omitted = the next 'BL-nnnn'."),
    name: z.string().describe('Baseline name (non-empty), e.g. "Hinge PBL".'),
    kind: z.enum(['functional', 'allocated', 'product', 'custom']).describe('Baseline kind (MIL-HDBK-61B vocabulary).'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'create_baseline', 'PLM_NOT_MANAGED', NOT_MANAGED);
    if (params.name.trim() === '') return refusePlm(doc, 'create_baseline', 'PLM_PARAM_INVALID', 'a baseline needs a name', [], ['name']);
    const existing = plm.baselines ?? {};
    const id = params.id ?? nextBaselineId(Object.keys(existing));
    if (Object.hasOwn(existing, id)) return refusePlm(doc, 'create_baseline', 'PLM_ID_EXISTS', `baseline '${id}' already exists`, [id]);
    const root = baselineRoot(plm);
    if (root === undefined || root.contentHash === undefined)
      return refusePlm(
        doc,
        'create_baseline',
        'PLM_BASELINE_MEMBER_UNRELEASED',
        `${plm.item.partNumber} has no released revision (current ${plm.item.currentRevision} is ${currentRevisionOf(plm)?.state ?? '?'})`,
        [plm.item.partNumber],
      );
    const blocked = Object.values(plm.subItems ?? {}).filter((sub) => sub.state !== 'released' && sub.state !== 'superseded');
    if (blocked.length > 0)
      return refusePlm(
        doc,
        'create_baseline',
        'PLM_BASELINE_MEMBER_UNRELEASED',
        `${blocked.map((sub) => `${sub.partNumber} rev ${sub.revision} is ${sub.state}`).join('; ')}`,
        blocked.map((sub) => sub.partNumber),
      );
    const members = [
      { partNumber: plm.item.partNumber, revision: root.label, contentHash: root.contentHash },
      ...Object.values(plm.subItems ?? {}).map((sub) => ({
        partNumber: sub.partNumber,
        revision: sub.revision,
        contentHash: sub.contentHash ?? '',
      })),
    ].sort((a, b) => (a.partNumber < b.partNumber ? -1 : a.partNumber > b.partNumber ? 1 : 0));
    const baseline: Baseline = {
      id,
      name: params.name,
      kind: params.kind,
      members,
      hash: membersHash(members),
      ...(params.at !== undefined ? { at: params.at } : {}),
      ...(params.by !== undefined ? { by: params.by } : {}),
    };
    return changed(
      withPlm(doc, { ...plm, baselines: { ...existing, [id]: baseline } }),
      `Baseline ${id} (${params.kind}) frozen: ${members.length} member(s), hash ${baseline.hash.slice(0, 12)}….`,
      [],
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant added / removed / changed are by part number between the two member lists; "changed" means another revision or another content hash
 * @failure unknown baseline -> PLM_BASELINE_UNKNOWN (refusal)
 */
export const compareBaselines = defineCommand({
  name: 'compare_baselines',
  description:
    'Compare a baseline with another baseline or with "WORKING" (the item at its current revision plus the bound sub-items as they are now). Returns data ' +
    '{ added, removed, changed } by part number; a change lists the revision and content hash on both sides and, for WORKING, its lifecycle state ' +
    '(e.g. LL-1003 C -> D in_work). Read-only.',
  annotations: { readOnly: true },
  params: z.object({
    from: z.string().describe('Baseline id.'),
    to: z.string().describe('Baseline id, or "WORKING" for the live structure.'),
  }),
  run: (doc, { from, to }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'compare_baselines', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const side = (id: string): readonly { partNumber: string; revision: string; contentHash: string; state?: string }[] | null =>
      id === 'WORKING' ? workingMembers(plm) : (plm.baselines?.[id]?.members ?? null);
    const [a, b] = [side(from), side(to)];
    if (a === null || b === null)
      return refusePlm(doc, 'compare_baselines', 'PLM_BASELINE_UNKNOWN', `unknown baseline '${a === null ? from : to}'`, [
        a === null ? from : to,
      ]);
    const before = new Map(a.map((member) => [member.partNumber, member]));
    const after = new Map(b.map((member) => [member.partNumber, member]));
    const added = b
      .filter((member) => !before.has(member.partNumber))
      .map((member) => ({ partNumber: member.partNumber, revision: member.revision }));
    const removed = a
      .filter((member) => !after.has(member.partNumber))
      .map((member) => ({ partNumber: member.partNumber, revision: member.revision }));
    const changedMembers = b.flatMap((member) => {
      const old = before.get(member.partNumber);
      if (old === undefined || (old.revision === member.revision && old.contentHash === member.contentHash)) return [];
      return [
        {
          partNumber: member.partNumber,
          from: old.revision,
          to: member.revision,
          ...(member.state !== undefined ? { toState: member.state } : {}),
          hashChanged: old.contentHash !== member.contentHash,
        },
      ];
    });
    return report(doc, `${from} -> ${to}: ${added.length} added, ${removed.length} removed, ${changedMembers.length} changed.`, {
      added,
      removed,
      changed: changedMembers,
    });
  },
});
