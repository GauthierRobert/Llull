/** Lookups of the authoring commands: sheet / item / line by id, number or tag, derived tag index, tag rules, and the working copy of the item map. */

import type { CadDocument } from '@core/model/types';
import { nextId } from '@lib/id';
import type { CommandResult } from '@core/commands/types';
import { refusePid } from '../dexpi/codes';
import type { PidItem, PidLine, PidModel, PidSegment, PidSheet } from '../model';

/** A refusal found while resolving params: the command turns it into a coded no-op. */
export interface Fail {
  readonly fail: true;
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
  readonly ids: readonly string[];
}

export const fail = (code: string, message: string, paths: readonly string[] = [], ids: readonly string[] = []): Fail => ({
  fail: true,
  code,
  message,
  paths,
  ids,
});

export const isFail = (value: unknown): value is Fail => typeof value === 'object' && value !== null && 'fail' in value;

export const refuse = (doc: CadDocument, command: string, f: Fail): CommandResult =>
  refusePid(doc, command, f.code, f.message, f.ids, f.paths);

/** Kinds whose `tag` is unique in the document (loops, annotations and segments carry derived or imported tags). */
const TAGGED_KINDS: ReadonlySet<PidItem['kind']> = new Set(['equipment', 'inline', 'instrument', 'actuating']);

export const MAX_TAG_LENGTH = 64;

/** Trimmed, single-spaced, upper-cased tag: the key of the derived tag index. */
export const normaliseTag = (tag: string): string => tag.trim().replace(/\s+/g, ' ').toUpperCase();

export function findSheet(pid: PidModel, ref: string, path = 'sheet'): PidSheet | Fail {
  const sheet = Object.hasOwn(pid.sheets, ref) ? pid.sheets[ref] : Object.values(pid.sheets).find((s) => s.number === ref);
  return sheet ?? fail('PID_SHEET_NOT_FOUND', `no sheet "${ref}"`, [path]);
}

/** The item `ref` names: an item id, else the unique tag (document scope). */
export function findItem(pid: PidModel, ref: string, path: string): PidItem | Fail {
  if (Object.hasOwn(pid.items, ref)) {
    const byId = pid.items[ref];
    if (byId !== undefined) return byId;
  }
  const key = normaliseTag(ref);
  const hits = pid.itemOrder.flatMap((id) => {
    const item = pid.items[id];
    return item?.tag !== undefined && TAGGED_KINDS.has(item.kind) && normaliseTag(item.tag) === key ? [item] : [];
  });
  const first = hits[0];
  if (first === undefined) return fail('PID_ITEM_NOT_FOUND', `no item with id or tag "${ref}"`, [path]);
  if (hits.length > 1)
    return fail(
      'PID_TAG_DUPLICATE',
      `the tag "${ref}" names ${hits.length} items; use an item id`,
      [path],
      hits.map((h) => h.id),
    );
  return first;
}

/** A line by id or line number (a segment id names its line). */
export function findLine(pid: PidModel, ref: string, path: string): PidLine | Fail {
  const byId = Object.hasOwn(pid.items, ref) ? pid.items[ref] : undefined;
  const direct = byId?.kind === 'segment' ? pid.items[byId.lineId] : byId;
  if (direct?.kind === 'line') return direct;
  const byNumber = pid.itemOrder.flatMap((id) => {
    const item = pid.items[id];
    return item?.kind === 'line' && item.lineNumber === ref ? [item] : [];
  });
  const first = byNumber[0];
  if (first === undefined) return fail('PID_ITEM_NOT_FOUND', `no line with id or line number "${ref}"`, [path]);
  return first;
}

export function segmentsOf(pid: PidModel, line: PidLine): PidSegment[] {
  return line.segmentIds.flatMap((id) => {
    const segment = pid.items[id];
    return segment?.kind === 'segment' ? [segment] : [];
  });
}

/** A tag is free when no tagged item other than `except` uses it. */
export function tagTaken(pid: PidModel, tag: string, except?: string): PidItem | undefined {
  const key = normaliseTag(tag);
  for (const id of pid.itemOrder) {
    const item = pid.items[id];
    if (item !== undefined && item.id !== except && item.tag !== undefined && TAGGED_KINDS.has(item.kind) && normaliseTag(item.tag) === key)
      return item;
  }
  return undefined;
}

/** Checks a new tag: length, project tag format of the kind, uniqueness. Returns the tag to store or a refusal. */
export function checkTag(
  pid: PidModel,
  tag: string,
  kind: 'equipment' | 'instrument' | 'valve' | undefined,
  path: string,
  except?: string,
): string | Fail {
  const clean = tag.trim().replace(/\s+/g, ' ');
  if (clean === '' || clean.length > MAX_TAG_LENGTH)
    return fail('PID_TAG_FORMAT', `a tag has 1 to ${MAX_TAG_LENGTH} characters, got ${clean.length}`, [path]);
  const format = kind === undefined ? undefined : pid.tagFormats[kind];
  if (format !== undefined) {
    let matches = false;
    try {
      matches = new RegExp(format.pattern).test(clean);
    } catch {
      matches = false;
    }
    if (!matches)
      return fail('PID_TAG_FORMAT', `the tag "${clean}" does not match the project ${kind} tag format ${format.pattern}`, [path]);
  }
  const taken = tagTaken(pid, clean, except);
  if (taken !== undefined) return fail('PID_TAG_DUPLICATE', `the tag "${clean}" is already used by ${taken.id}`, [path], [taken.id]);
  return clean;
}

/** Working copy of the item map: edits are local, the input model is never touched. */
export class Draft {
  readonly items: Record<string, PidItem>;
  order: string[];

  constructor(readonly pid: PidModel) {
    this.items = { ...pid.items };
    this.order = [...pid.itemOrder];
  }

  put(item: PidItem): void {
    if (!Object.hasOwn(this.items, item.id)) this.order.push(item.id);
    this.items[item.id] = item;
  }

  get(id: string): PidItem | undefined {
    return Object.hasOwn(this.items, id) ? this.items[id] : undefined;
  }

  drop(ids: ReadonlySet<string>): void {
    for (const id of ids) delete this.items[id];
    this.order = this.order.filter((id) => !ids.has(id));
  }

  model(extra: Partial<PidModel> = {}): PidModel {
    return { ...this.pid, items: this.items, itemOrder: this.order, ...extra };
  }
}

/** Any item by id or tag, else a line by its line number. */
export function findAny(pid: PidModel, ref: string, path: string): PidItem | Fail {
  const item = findItem(pid, ref, path);
  if (!isFail(item) || item.code !== 'PID_ITEM_NOT_FOUND') return item;
  const line = findLine(pid, ref, path);
  return isFail(line) ? item : line;
}

/** A fresh step-scoped id: the next one `nextId` mints that no sheet or item of a (possibly hostile, hand-edited) file already uses. */
export function mintFree(pid: PidModel): string {
  let id = nextId('pid');
  for (let tries = 0; tries < 10_000 && (Object.hasOwn(pid.items, id) || Object.hasOwn(pid.sheets, id)); tries++) id = nextId('pid');
  return id;
}
