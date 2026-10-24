/**
 * Spec editing operations (FR-PSC-16): `edit_pipe_spec` ops applied in order to the spec in file form, then re-parsed as a whole, so every
 * edit is validated by the same schema as an import and an invalid op leaves nothing changed (all or nothing). Pure.
 */

import { z } from '@core/commands/schema';
import { parseSize } from './size';
import { BRANCH_FITTINGS } from './types';

const nominal = z.union([z.number(), z.string()]);
const json = z.record(z.string(), z.unknown());

export const editOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('addComponent').describe('Add a component to the spec.'),
    component: json.describe(
      'Component in file form: { id, type, fromNps/toNps or fromDn/toDn, catalogRef, ends?, facing?, class?, pn?, radius?, schedule? | scheduleFromPipe?, wallMm?, priority?, branchFromNps/branchToNps?, commodityCode?, description?, material? }.',
    ),
  }),
  z.object({
    op: z.literal('updateComponent').describe('Change members of one component.'),
    id: z.string().describe('Id of the component to change.'),
    changes: json.describe(
      'Members to set; a member set to null is removed. The id cannot change. Setting fromNps / toNps replaces fromDn / toDn and vice versa.',
    ),
  }),
  z.object({
    op: z.literal('removeComponent').describe('Remove one component.'),
    id: z.string().describe('Id of the component to remove.'),
  }),
  z.object({
    op: z.literal('setSizeRange').describe('Replace the spec size range.'),
    sizeRange: json.describe('New spec size range { fromNps, toNps } or { fromDn, toDn }.'),
  }),
  z.object({
    op: z.literal('setBranchCell').describe('Set one branch-table cell.'),
    header: nominal.describe('Header size key (NPS or DN, in the system of the spec size range).'),
    branch: nominal.describe('Branch size key, same system.'),
    fitting: z
      .enum(BRANCH_FITTINGS)
      .describe('T equal tee, RT reducing tee, W weldolet, S sockolet, TH threadolet, SI stub-in, SIR reinforced stub-in.'),
  }),
  z.object({
    op: z.literal('clearBranchCell').describe('Empty one branch-table cell.'),
    header: nominal.describe('Header size key.'),
    branch: nominal.describe('Branch size key.'),
  }),
  z.object({
    op: z.literal('setHeader').describe('Set header members of the spec.'),
    fields: json.describe(
      'Header members to set (a member set to null is removed, except the required ones): title, service, dimensionalStandard, rating, materials, corrosionAllowance { value, unit }, millTolerance, designLimits, catalogs, elbowAngles, provenance.',
    ),
  }),
]);

export type EditOp = z.infer<typeof editOpSchema>;
type Json = Record<string, unknown>;

export interface EditIssue {
  readonly path: string;
  readonly message: string;
}

const HEADER_KEYS: ReadonlySet<string> = new Set([
  'title',
  'service',
  'dimensionalStandard',
  'rating',
  'materials',
  'corrosionAllowance',
  'millTolerance',
  'designLimits',
  'catalogs',
  'elbowAngles',
  'provenance',
]);
const REQUIRED_HEADER_KEYS: ReadonlySet<string> = new Set(['dimensionalStandard', 'rating', 'corrosionAllowance', 'catalogs']);
const SIZE_KEYS = {
  nps: ['fromNps', 'toNps'],
  dn: ['fromDn', 'toDn'],
  branchNps: ['branchFromNps', 'branchToNps'],
  branchDn: ['branchFromDn', 'branchToDn'],
} as const;

/** Sets the members of `changes` on `target` (null removes); setting one size system removes the other's keys. */
function merge(target: Json, changes: Json): Json {
  const next: Json = { ...target };
  const touches = (keys: readonly string[]): boolean => keys.some((key) => key in changes && changes[key] !== null);
  if (touches(SIZE_KEYS.nps)) for (const key of SIZE_KEYS.dn) delete next[key];
  if (touches(SIZE_KEYS.dn)) for (const key of SIZE_KEYS.nps) delete next[key];
  if (touches(SIZE_KEYS.branchNps)) for (const key of SIZE_KEYS.branchDn) delete next[key];
  if (touches(SIZE_KEYS.branchDn)) for (const key of SIZE_KEYS.branchNps) delete next[key];
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function cellKey(file: Json, value: string | number): string | null {
  const range = file['sizeRange'] as Json | undefined;
  const dn = range !== undefined && ('fromDn' in range || 'toDn' in range);
  return parseSize(dn ? 'dn' : 'nps', value)?.key ?? null;
}

/** Applies `ops` to a spec in file form; the edited file, or the first op that cannot apply. */
export function applyEditOps(file: Json, ops: readonly EditOp[]): { readonly file: Json } | { readonly issue: EditIssue } {
  let current: Json = file;
  for (const [index, op] of ops.entries()) {
    const at = `ops.${index}`;
    const bad = (path: string, message: string): { readonly issue: EditIssue } => ({
      issue: { path: `${at}.${path}`, message: `${at} (${op.op}): ${message}` },
    });
    const components = (current['components'] as Json[] | undefined) ?? [];
    const position = 'id' in op ? components.findIndex((component) => component['id'] === op.id) : -1;
    switch (op.op) {
      case 'addComponent':
        if (components.some((component) => component['id'] === op.component['id']))
          return bad('component.id', `component id ${String(op.component['id'])} already exists`);
        current = { ...current, components: [...components, op.component] };
        break;
      case 'updateComponent':
        if (position < 0) return bad('id', `no component "${op.id}"`);
        if ('id' in op.changes && op.changes['id'] !== op.id)
          return bad('changes.id', 'the id of a component cannot change; remove and add it');
        current = { ...current, components: components.map((component, k) => (k === position ? merge(component, op.changes) : component)) };
        break;
      case 'removeComponent':
        if (position < 0) return bad('id', `no component "${op.id}"`);
        current = { ...current, components: components.filter((_, k) => k !== position) };
        break;
      case 'setSizeRange':
        current = { ...current, sizeRange: op.sizeRange };
        break;
      case 'setBranchCell':
      case 'clearBranchCell': {
        const header = cellKey(current, op.header);
        const branch = cellKey(current, op.branch);
        if (header === null || branch === null)
          return bad(header === null ? 'header' : 'branch', 'not a size key in the system of the spec size range');
        const table = (current['branchTable'] as Json | undefined) ?? {};
        const cells = { ...((table['cells'] as Record<string, Record<string, string>> | undefined) ?? {}) };
        const row = { ...cells[header] };
        if (op.op === 'setBranchCell') row[branch] = op.fitting;
        else delete row[branch];
        if (Object.keys(row).length === 0) delete cells[header];
        else cells[header] = row;
        current = { ...current, branchTable: { ...table, cells } };
        break;
      }
      case 'setHeader': {
        const unknown = Object.keys(op.fields).find((key) => !HEADER_KEYS.has(key));
        if (unknown !== undefined) return bad(`fields.${unknown}`, `"${unknown}" is not a header member (${[...HEADER_KEYS].join(', ')})`);
        const required = Object.keys(op.fields).find((key) => REQUIRED_HEADER_KEYS.has(key) && op.fields[key] === null);
        if (required !== undefined) return bad(`fields.${required}`, `"${required}" is required and cannot be removed`);
        current = merge(current, op.fields);
        break;
      }
    }
  }
  return { file: current };
}
