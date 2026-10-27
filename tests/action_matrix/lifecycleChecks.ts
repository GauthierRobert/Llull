/**
 * Document-lifecycle contract of the action matrix: properties every design (and the document after any command) must keep through
 * save / load, replay, undo / redo, deletion and clear_document. Each check returns findings (`check|target` -> detail), never throws.
 */

import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { listCommands } from '@core/commands/commandTable';
import type { ExecutionContext } from '@core/commands/types';
import { documentExtensions } from '@core/plugins/host';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { emptyHistory, recordChange, stepHistory, type History } from '@protocol/history';
import { canonicalJson } from '@lib/canonicalJson';
import { stableHash } from './stableHash';

export interface LifecycleFinding {
  /** `check|target`, appended to the design id to form the known-findings key. */
  readonly key: string;
  readonly detail: string;
}

type Findings = LifecycleFinding[];

/** Context of the design under test (a seed that needs a port, e.g. point clouds); every command the checks run uses it. */
let activeContext: ExecutionContext | undefined;

/** Runs `work` with `context` as the context of every command the checks execute. */
export function withLifecycleContext<T>(context: ExecutionContext | undefined, work: () => T): T {
  activeContext = context;
  try {
    return work();
  } finally {
    activeContext = undefined;
  }
}

const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
/** Keys whose values are bulk numeric / binary payloads, never id tables. */
const PAYLOAD_KEYS: ReadonlySet<string> = new Set(['blobs', 'mesh', 'positions', 'indices', 'normals', 'bytes']);

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n').slice(0, 3).join(' / ').slice(0, 300);
/** The saved form of `doc` with derived entities, key order ignored (a reload re-derives entities after the stored ones). */
const full = (doc: CadDocument): string => canonicalJson(JSON.parse(serializeDocument(doc, { includeDerived: true })));
/** `full` without the step counter: replay mints it from the steps, a direct build may not carry it (it only has to be monotonic). */
const withoutCounter = (doc: CadDocument): string => full({ ...doc, nextStepNumber: 1 });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** First differing position of two serialized documents, as a short excerpt (for the finding text). */
function firstDifference(a: string, b: string): string {
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return `at ${at}: ${a.slice(Math.max(0, at - 40), at + 60)} <> ${b.slice(Math.max(0, at - 40), at + 60)}`;
}

/** (a) save -> load through the real persistence path is equal and validates. */
export function checkRoundTrip(doc: CadDocument, target: string): Findings {
  try {
    const json = serializeDocument(doc);
    const loaded = deserializeDocument(json);
    if (full(loaded) !== full(doc))
      return [{ key: `roundtrip|${target}`, detail: `reloaded differs ${firstDifference(full(doc), full(loaded))}` }];
    if (serializeDocument(loaded) !== json) return [{ key: `roundtrip|${target}`, detail: 're-serialized text differs' }];
    return [];
  } catch (error) {
    return [{ key: `roundtrip|${target}`, detail: `does not load: ${message(error)}` }];
  }
}

/** (b) history replay equals the live document, ids included. */
export function checkReplay(doc: CadDocument, target: string): Findings {
  if (doc.featureHistory.length === 0) return [];
  try {
    const replayed = execute(doc, 'replay_history', {}, activeContext);
    if (replayed.error !== undefined) return [{ key: `replay|${target}`, detail: `replay failed: ${replayed.summary.slice(0, 300)}` }];
    if (withoutCounter(replayed.document) !== withoutCounter(doc))
      return [
        { key: `replay|${target}`, detail: `replay differs ${firstDifference(withoutCounter(doc), withoutCounter(replayed.document))}` },
      ];
    return checkIdHygiene(replayed.document, target).map((finding) => ({ ...finding, key: `replay-${finding.key}` }));
  } catch (error) {
    return [{ key: `replay|${target}`, detail: `replay threw: ${message(error)}` }];
  }
}

/** Entity-bag and table integrity: unique, non-reserved ids; keys equal their record's `id`; order lists point at existing records. */
export function checkIdHygiene(doc: CadDocument, target: string): Findings {
  const problems: string[] = [];
  const orderOf: readonly (readonly [string, readonly string[], Record<string, unknown>])[] = [
    ['order', doc.order, doc.entities],
    ['layerOrder', doc.layerOrder, doc.layers],
    ['constraintOrder', doc.constraintOrder, doc.constraints],
    ['jointOrder', doc.jointOrder, doc.joints],
    ['driveRelationOrder', doc.driveRelationOrder, doc.driveRelations],
  ];
  for (const [name, ids, table] of orderOf) {
    if (new Set(ids).size !== ids.length) problems.push(`${name} holds duplicate ids`);
    for (const id of ids) if (!Object.hasOwn(table, id)) problems.push(`${name} lists '${id}' which is not in its table`);
  }
  for (const id of doc.selection) if (!Object.hasOwn(doc.entities, id)) problems.push(`selection lists '${id}' which is not an entity`);
  const walk = (value: unknown, trail: string, depth: number): void => {
    if (depth > 10 || problems.length > 8) return;
    if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${trail}[${i}]`, depth + 1));
    if (!isRecord(value)) return;
    const entries = Object.entries(value);
    const records = entries.filter(([, child]) => isRecord(child) && typeof child['id'] === 'string');
    if (records.length > 0 && records.length === entries.length && entries.length > 1) {
      const idOf = (child: unknown): unknown => (child as Record<string, unknown>)['id'];
      if (new Set(entries.map(([, child]) => idOf(child))).size !== entries.length) problems.push(`${trail}: records share an id`);
      const matching = entries.filter(([key, child]) => idOf(child) === key).length;
      if (matching > 0 && matching < entries.length)
        problems.push(`${trail}: ${entries.length - matching} record key(s) differ from their id`);
    }
    for (const [key, child] of entries) {
      if (RESERVED_KEYS.has(key) && (key === '__proto__' || depth > 0)) problems.push(`${trail}: reserved key '${key}'`);
      if (!PAYLOAD_KEYS.has(key)) walk(child, `${trail}.${key}`, depth + 1);
    }
  };
  walk(doc, '$', 0);
  const entityIds = Object.keys(doc.entities);
  for (const id of entityIds)
    if (doc.entities[id]?.id !== id) problems.push(`entity key '${id}' differs from its id '${doc.entities[id]?.id}'`);
  return problems.length === 0 ? [] : [{ key: `ids|${target}`, detail: problems.slice(0, 4).join('; ') }];
}

/** (c) undo back to the start then redo everything equals, over the real snapshot-stack rule of the hosts. */
export function checkUndoRedo(
  start: CadDocument,
  steps: readonly { command: string; params: Record<string, unknown> }[],
  target: string,
): Findings {
  let history: History<CadDocument> = emptyHistory();
  let current = start;
  const startText = full(start);
  let applied = 0;
  for (const step of steps) {
    const result = execute(current, step.command, step.params, activeContext);
    if (result.document === current || result.rejected === true) continue;
    history = recordChange(history, current);
    current = result.document;
    applied++;
  }
  if (applied === 0) return [];
  const endText = full(current);
  const move = (direction: 'undo' | 'redo'): void => {
    const stepped = stepHistory(history, direction, current);
    if (stepped === null) return;
    history = stepped.history;
    current = stepped.target;
  };
  for (let i = 0; i < applied; i++) move('undo');
  if (full(current) !== startText)
    return [
      {
        key: `undo|${target}`,
        detail: `undo of ${applied} change(s) does not restore the start ${firstDifference(startText, full(current))}`,
      },
    ];
  for (let i = 0; i < applied; i++) move('redo');
  if (full(current) !== endText)
    return [
      { key: `redo|${target}`, detail: `redo of ${applied} change(s) does not restore the end ${firstDifference(endText, full(current))}` },
    ];
  return [];
}

/** A reconcile of an already reconciled document must change nothing. */
function reconcileProblems(before: CadDocument, after: CadDocument): string[] {
  const problems: string[] = [];
  for (const extension of documentExtensions()) {
    if (extension.reconcile === undefined) continue;
    const again = extension.reconcile(before, after);
    if (again.document !== after && full(again.document) !== full(after))
      problems.push(`second reconcile changed the document ${firstDifference(full(after), full(again.document))}`);
  }
  return problems;
}

/**
 * Core tables that must not keep a reference to a deleted entity. Plugin slices (aero, composites, cfd, piping ports ...) and dimension entities keep
 * a stale record on purpose (their commands and checks report it), so they are not enforced here.
 */
const REFERENCE_TABLES = ['groups', 'components', 'constraints', 'joints', 'driveRelations', 'animations'] as const;

/** Paths in the core reference tables of `doc` that still hold `id` as a whole string: references the deletion orphaned. */
function danglingReferences(doc: CadDocument, id: string): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, trail: string, depth: number): void => {
    if (depth > 8 || paths.length > 3) return;
    if (value === id) paths.push(trail);
    else if (Array.isArray(value)) value.slice(0, 500).forEach((item, i) => walk(item, `${trail}[${i}]`, depth + 1));
    else if (isRecord(value))
      for (const [key, child] of Object.entries(value)) {
        if (key === id) paths.push(`${trail}.${key}`);
        if (!PAYLOAD_KEYS.has(key)) walk(child, `${trail}.${key}`, depth + 1);
      }
  };
  for (const table of REFERENCE_TABLES) walk(doc[table], `$.${table}`, 1);
  return paths;
}

/** (d) after a deletion: the result loads, reconcile is clean, replay of the result equals it, ids stay sound. */
export function checkAfterDelete(before: CadDocument, after: CadDocument, target: string, deletedId: string): Findings {
  const findings: Findings = [];
  const dangling = danglingReferences(after, deletedId);
  if (dangling.length > 0 && !(deletedId in after.entities))
    findings.push({ key: `delete-dangling|${target}`, detail: `still referenced at ${dangling.join(', ')}` });
  try {
    const problems = reconcileProblems(before, after);
    if (problems.length > 0) findings.push({ key: `delete-reconcile|${target}`, detail: problems[0] as string });
  } catch (error) {
    findings.push({ key: `delete-reconcile|${target}`, detail: `reconcile threw: ${message(error)}` });
  }
  const roundTrip = checkRoundTrip(after, target);
  findings.push(...roundTrip.map((f) => ({ ...f, key: `delete-${f.key}` })));
  if (roundTrip.length === 0) findings.push(...checkReplay(after, target).map((f) => ({ ...f, key: `delete-${f.key}` })));
  findings.push(...checkIdHygiene(after, target).map((f) => ({ ...f, key: `delete-${f.key}` })));
  return findings;
}

/** (e) clear_document then load: validates, plugin slices empty or absent. */
export function checkClear(doc: CadDocument, target: string): Findings {
  try {
    const cleared = execute(doc, 'clear_document', {}, activeContext).document;
    const loaded = deserializeDocument(serializeDocument(cleared));
    const blank = createEmptyDocument() as unknown as Record<string, unknown>;
    const kept = new Set(['camera', 'units', 'displayPrecision', 'kernelSettings', 'nextStepNumber', 'layers', 'layerOrder']);
    const left = Object.entries(loaded as unknown as Record<string, unknown>)
      .filter(([key, value]) => !kept.has(key) && value !== undefined)
      .filter(([key, value]) => key !== 'featureHistory' || (value as { name: string }[]).some((step) => step.name !== 'clear_document'))
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(blank[key] ?? null) && !isEmptyValue(value))
      .map(([key]) => key);
    return left.length === 0 ? [] : [{ key: `clear|${target}`, detail: `slices survive clear_document + load: ${left.join(', ')}` }];
  } catch (error) {
    return [{ key: `clear|${target}`, detail: `cleared document does not load: ${message(error)}` }];
  }
}

const isEmptyValue = (value: unknown): boolean =>
  Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0;

interface DeleteTool {
  readonly name: string;
  /** The single required parameter and whether it takes a list of ids. */
  readonly param: string;
  readonly list: boolean;
}

const NOT_ENTITY_OWNED = /^(delete_entities|delete_step|delete_parameter|delete_layer|delete_faces)$/;

/** Registered delete / remove commands whose only required parameter is one id (or a list of ids). */
function deleteTools(): DeleteTool[] {
  const tools: DeleteTool[] = [];
  for (const command of listCommands()) {
    if (!/^(delete|remove)_/.test(command.name) || NOT_ENTITY_OWNED.test(command.name)) continue;
    const required = command.paramsSchema.required;
    const only = required.length === 1 ? command.paramsSchema.properties[required[0] as string] : undefined;
    if (only === undefined) continue;
    if (only.type === 'string') tools.push({ name: command.name, param: required[0] as string, list: false });
    else if (only.type === 'array' && only.items?.type === 'string')
      tools.push({ name: command.name, param: required[0] as string, list: true });
  }
  return tools;
}

interface Candidate {
  readonly id: string;
  /** Lower-cased names the id was found under (table key, `*Id` field), to pair it with the delete command that takes it. */
  readonly hints: ReadonlySet<string>;
}

/** Ids of plugin-owned records: `id` fields, `*Id` / `name` strings and keys of record tables, outside the entity bag, history and payloads. */
function definitionIds(doc: CadDocument, seed: number, limit: number): Candidate[] {
  const found = new Map<string, Set<string>>();
  const note = (id: string, hint: string): void => {
    if (id === '' || found.size > 600) return;
    found.set(id, (found.get(id) ?? new Set<string>()).add(hint.toLowerCase()));
  };
  const walk = (value: unknown, hint: string, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(value)) return value.slice(0, 50).forEach((item) => walk(item, hint, depth + 1));
    if (!isRecord(value)) return;
    const entries = Object.entries(value);
    const table = entries.length > 0 && entries.every(([, child]) => isRecord(child));
    for (const [key, child] of entries) {
      if (PAYLOAD_KEYS.has(key)) continue;
      if (typeof child === 'string' && (/Id$/.test(key) || key === 'id' || key === 'name' || key === 'tag'))
        note(child, key === 'id' ? hint : key);
      if (table) note(key, hint);
      walk(child, key, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(doc))
    if (key !== 'entities' && key !== 'featureHistory' && key !== 'order' && key !== 'selection') walk(value, key, 0);
  for (const id of Object.keys(doc.entities)) found.delete(id);
  return [...found]
    .map(([id, hints]) => ({ id, hints }))
    .sort((x, y) => stableHash(x.id, seed) - stableHash(y.id, seed) || (x.id < y.id ? -1 : 1))
    .slice(0, limit);
}

/** Whether delete command `tool` plausibly takes `candidate`: a generic id parameter takes any, a named one needs a matching table or field name. */
function pairs(tool: DeleteTool, candidate: Candidate): boolean {
  if (/^(id|ids|name|elementIds)$/.test(tool.param)) return true;
  const words = [tool.param.replace(/(Ids?|Name)$/, ''), ...tool.name.split('_').slice(1)]
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 2);
  return [...candidate.hints].some((hint) =>
    words.some((word) => hint.includes(word) || word.includes(hint.replace(/(ids?|name)$/, '') || '~')),
  );
}

interface DeleteAttempt {
  readonly command: string;
  readonly id: string;
  readonly after: CadDocument;
}

/**
 * Deletions that changed `doc`: the first `entities` top-level entities, and plugin-owned definitions through their delete commands (at most
 * `perTool` per command, `definitions` in all).
 */
export function deletions(doc: CadDocument, entities: number, definitions: number, perTool: number, seed: number): DeleteAttempt[] {
  const attempts: DeleteAttempt[] = [];
  for (const id of doc.order.slice(0, entities)) {
    const result = execute(doc, 'delete_entities', { ids: [id] }, activeContext);
    if (result.document !== doc && result.affected.length > 0) attempts.push({ command: 'delete_entities', id, after: result.document });
  }
  const candidates = definitionIds(doc, seed, 120);
  let definitionCount = 0;
  for (const tool of deleteTools()) {
    let taken = 0;
    for (const candidate of candidates) {
      if (taken >= perTool || definitionCount >= definitions) break;
      if (!pairs(tool, candidate)) continue;
      const result = execute(doc, tool.name, { [tool.param]: tool.list ? [candidate.id] : candidate.id }, activeContext);
      if (result.document === doc || result.affected.length === 0 || result.rejected === true) continue;
      attempts.push({ command: tool.name, id: candidate.id, after: result.document });
      taken++;
      definitionCount++;
    }
  }
  return attempts;
}
