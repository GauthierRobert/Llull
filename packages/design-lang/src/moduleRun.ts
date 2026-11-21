/**
 * One `use "file.lld" as ns with …` at run time: binds the typed arguments, runs the module body in its own scope (aliases namespaced
 * `ns.name`, only exported names stay visible, arguments shadow the document parameters), then puts what the instance created on its own
 * layer and group. All of it runs inside the single `design_source` step through the interpreter's own `exec`.
 * @invariant a module sees its arguments, document parameters and its own aliases, never the caller's loop variables or aliases
 * @failure DESIGN_MODULE_* naming the line; an error inside a module body names the file: `[fan.lld] …`
 */

import type { CadDocument } from '@core/model/types';
import { DesignError } from './errors';
import { buildFunctions } from './functions';
import { convertUnits } from './units';
import { MAX_MODULE_INSTANCES, moduleArguments, type ModuleTable } from './modules';
import type { Statement } from './parse';
import type { FnDef } from './valueEval';

type UseStatement = Extract<Statement, { kind: 'use' }>;

export interface ModuleScope {
  /** `ns.` of the instance being run (nested: `outer.inner.`), '' at the root. */
  readonly prefix: string;
  /** The instance's arguments, shadowing the document parameters. */
  readonly overlay: Readonly<Record<string, number>>;
  /** Module file being run, null for the root design. */
  readonly file: string | null;
}

export interface ModuleInstance {
  readonly ns: string;
  readonly path: string;
  readonly layerId: string | null;
  readonly groupId: string | null;
  readonly entities: number;
}

/** The interpreter, as seen by module instances. */
export interface ModuleHost {
  doc: CadDocument;
  scope: ModuleScope;
  functions: ReadonlyMap<string, FnDef>;
  readonly modules: ModuleTable;
  readonly instances: ModuleInstance[];
  readonly aliases: Pick<Map<string, unknown>, 'keys' | 'delete'>;
  /** Ids of module instances' entities already moved to an inner instance's layer. */
  readonly layered: Set<string>;
  lastAffected: string[];
  block(statements: readonly Statement[], env: Readonly<Record<string, number>>): void;
  exec(name: string, params: unknown, line: number): CadDocument;
  evaluate(text: string, env: Readonly<Record<string, number>>, line: number): number;
  interpolate(text: string, env: Readonly<Record<string, number>>, line: number): string;
}

/** @failure `name` is a module namespace (an instance or a prefix of namespaced aliases), or with `alias` also a plain alias -> DESIGN_MODULE_NAMESPACE */
export function assertFreeName(host: Pick<ModuleHost, 'aliases' | 'instances'>, name: string, line: number, alias = true): void {
  const taken =
    [...host.aliases.keys()].some((k) => (alias && k === name) || k.startsWith(`${name}.`)) || host.instances.some((i) => i.ns === name);
  if (taken)
    throw new DesignError(
      'DESIGN_MODULE_NAMESPACE',
      line,
      `"${name}" is already used as an alias or module namespace`,
      'Give it another name.',
    );
}

const ROOT_ENV: Readonly<Record<string, number>> = {};

export function runModule(host: ModuleHost, use: UseStatement, env: Readonly<Record<string, number>>): void {
  const { line } = use;
  const def = host.modules.get(use.path);
  if (def === undefined)
    throw new DesignError('DESIGN_MODULE_NOT_FOUND', line, `module "${use.path}" is not loaded`, 'Pass its text in `modules`.');
  const ns = `${host.scope.prefix}${host.interpolate(use.ns, env, line)}`;
  assertFreeName(host, ns, line);
  if (host.instances.length >= MAX_MODULE_INSTANCES)
    throw new DesignError('DESIGN_MODULE_LIMIT', line, `more than ${MAX_MODULE_INSTANCES} module instances`, 'Use fewer instances.');
  const overlay = moduleArguments(def, use.pairs, line, (text, type, bound) =>
    host.evaluate(type === 'length' ? convertUnits(text, host.doc, null, line) : text, { ...env, ...bound }, line),
  );
  const outer = { scope: host.scope, functions: host.functions };
  const before = new Set(Object.keys(host.doc.entities));
  host.scope = { prefix: `${ns}.`, overlay, file: def.path };
  try {
    host.functions = buildFunctions(def.body, host.doc);
    host.block(def.body, ROOT_ENV);
  } catch (error) {
    if (error instanceof DesignError) throw new DesignError(error.code, error.line, `[${def.path}] ${error.detail}`, error.fix);
    throw error;
  } finally {
    host.scope = outer.scope;
    host.functions = outer.functions;
  }
  hideUnexported(host, `${ns}.`, def.exports);
  const created = Object.keys(host.doc.entities).filter((id) => !before.has(id));
  host.instances.push(placeOnOwnLayer(host, ns, def.path, created, line));
}

/** Drop every alias under `prefix` the module does not export (`export x` keeps `x` and `x.…`). @failure unknown export -> DESIGN_UNKNOWN_ALIAS */
function hideUnexported(host: ModuleHost, prefix: string, exports: ModuleDef['exports']): void {
  const keys = [...host.aliases.keys()].filter((k) => k.startsWith(prefix));
  for (const { name, line } of exports)
    if (!keys.some((k) => k === prefix + name || k.startsWith(`${prefix}${name}.`)))
      throw new DesignError(
        'DESIGN_UNKNOWN_ALIAS',
        line,
        `export "${name}" names no alias of the module`,
        'Export an alias bound by a line of the module.',
      );
  for (const key of keys) {
    const local = key.slice(prefix.length);
    if (!exports.some((e) => local === e.name || local.startsWith(`${e.name}.`))) host.aliases.delete(key);
  }
}

type ModuleDef = NonNullable<ReturnType<ModuleTable['get']>>;

/** Layer `ns` for the entities this instance made (not those of an inner instance) and group `ns` for all of them (2 or more). */
function placeOnOwnLayer(host: ModuleHost, ns: string, path: string, created: readonly string[], line: number): ModuleInstance {
  if (created.length === 0) return { ns, path, layerId: null, groupId: null, entities: 0 };
  host.doc = host.exec('add_layer', { name: ns }, line);
  const layerId = host.lastAffected[0] ?? null;
  for (const id of created.filter((e) => !host.layered.has(e))) {
    host.doc = host.exec('set_entity_layer', { entityId: id, layerId }, line);
    host.layered.add(id);
  }
  let groupId: string | null = null;
  if (created.length >= 2) {
    host.doc = host.exec('group_entities', { ids: [...created], name: ns }, line);
    groupId = host.lastAffected[0] ?? null;
  }
  return { ns, path, layerId, groupId, entities: created.length };
}
