/**
 * `.lld` modules, pure: the host reads the files and passes their text; nothing here touches a file system.
 * Loading parses each reachable module once, refuses cycles by name and bounds count, depth and size. The step embeds the texts with
 * their SHA-256 (the embedded copy is the source of truth: replay never reads a file).
 * @invariant imports form a DAG; every module path is relative to the root design and inside its folder
 * @failure missing text -> DESIGN_MODULE_NOT_FOUND; cycle -> DESIGN_MODULE_CYCLE (naming the path); limit -> DESIGN_MODULE_LIMIT;
 *   altered embedded text -> DESIGN_MODULE_HASH_CHANGED; bad argument -> DESIGN_MODULE_PARAM
 */

import { sha256Hex } from '@lib/sha256';
import { similarNames } from '@lib/similarNames';
import { DesignError } from './errors';
import { parseDesign, type ModuleParamType, type Pair, type Statement } from './parse';

type ModuleStatement = Extract<Statement, { kind: 'module' }>;
type UseStatement = Extract<Statement, { kind: 'use' }>;

export interface EmbeddedModule {
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
}

export interface ModuleDef {
  readonly path: string;
  readonly name: string;
  readonly params: ModuleStatement['params'];
  readonly body: readonly Statement[];
  /** Exported alias names with the line of their `export`. */
  readonly exports: readonly { readonly name: string; readonly line: number }[];
}

/** Module path -> parsed module (reachable from the root design only). */
export type ModuleTable = ReadonlyMap<string, ModuleDef>;

export const MAX_MODULE_FILES = 64;
export const MAX_MODULE_DEPTH = 8;
export const MAX_MODULE_BYTES = 262_144;
export const MAX_MODULE_INSTANCES = 256;

const limit = (line: number, detail: string, fix: string): DesignError => new DesignError('DESIGN_MODULE_LIMIT', line, detail, fix);

/** Every `use` statement of `statements`, loops and module bodies included. */
function usesOf(statements: readonly Statement[]): UseStatement[] {
  return statements.flatMap((s) => (s.kind === 'use' ? [s] : s.kind === 'for' || s.kind === 'module' ? usesOf(s.body) : []));
}

/** The single module of a module file's statements (the file holds nothing else). */
function moduleOf(path: string, text: string): ModuleDef {
  if (text.length > MAX_MODULE_BYTES)
    throw limit(0, `module ${path} is ${text.length} characters (limit ${MAX_MODULE_BYTES})`, 'Split it into smaller modules.');
  let statements: Statement[];
  try {
    statements = parseDesign(text);
  } catch (error) {
    if (error instanceof DesignError) throw new DesignError(error.code, error.line, `[${path}] ${error.detail}`, error.fix);
    throw error;
  }
  const [only, ...rest] = statements;
  if (only?.kind !== 'module' || rest.length > 0)
    throw new DesignError(
      'DESIGN_SYNTAX',
      only?.line ?? 0,
      `[${path}] a module file holds exactly one module block`,
      'Write: module name(p: length = 1) { … export a, b }',
    );
  const exports = only.body.flatMap((s) => (s.kind === 'export' ? s.names.map((name) => ({ name, line: s.line })) : []));
  return { path, name: only.name, params: only.params, body: only.body, exports };
}

/**
 * Parse the modules `root` reaches from `files` (path -> text).
 * @failure DESIGN_MODULE_* as in the file header; a `module` block in the root design -> DESIGN_SYNTAX
 */
export function loadModules(root: readonly Statement[], files: Readonly<Record<string, string>>): ModuleTable {
  const stray = root.find((s) => s.kind === 'module');
  if (stray !== undefined)
    throw new DesignError(
      'DESIGN_SYNTAX',
      stray.line,
      'a module belongs in its own file',
      'Move it to a .lld file and `use "file.lld" as name`.',
    );
  const table = new Map<string, ModuleDef>();
  const done = new Set<string>();
  const visit = (use: UseStatement, stack: readonly string[]): void => {
    const { path, line } = use;
    if (stack.includes(path))
      throw new DesignError(
        'DESIGN_MODULE_CYCLE',
        line,
        `module import cycle: ${[...stack.slice(stack.indexOf(path)), path].join(' -> ')}`,
        'Imports must form a DAG: move the shared part into a third module.',
      );
    if (done.has(path)) return;
    if (stack.length >= MAX_MODULE_DEPTH)
      throw limit(
        line,
        `modules imported more than ${MAX_MODULE_DEPTH} deep (${[...stack, path].join(' -> ')})`,
        'Flatten the import chain.',
      );
    const text = files[path];
    if (text === undefined) {
      const near = similarNames(path, Object.keys(files));
      throw new DesignError(
        'DESIGN_MODULE_NOT_FOUND',
        line,
        `module "${path}" was not supplied`,
        near.length > 0
          ? `Did you mean ${near.join(', ')}?`
          : 'Pass its text in `modules` { "path": text } (the CLI reads `use` files next to the @text: source).',
      );
    }
    if (table.size >= MAX_MODULE_FILES) throw limit(line, `more than ${MAX_MODULE_FILES} module files`, 'Merge small modules.');
    const def = moduleOf(path, text);
    for (const next of usesOf(def.body)) visit(next, [...stack, path]);
    table.set(path, def);
    done.add(path);
  };
  for (const use of usesOf(root)) visit(use, []);
  return table;
}

/** The embedded form of the reachable modules (sorted by path, hashed): what the design step stores. */
export function embedModules(table: ModuleTable, files: Readonly<Record<string, string>>): EmbeddedModule[] {
  return [...table.keys()].sort().map((path) => ({ path, sha256: sha256Hex(files[path] ?? ''), text: files[path] ?? '' }));
}

/** path -> text of embedded modules after checking each hash. @failure altered text -> DESIGN_MODULE_HASH_CHANGED */
export function filesOfEmbedded(modules: readonly EmbeddedModule[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const m of modules) {
    if (sha256Hex(m.text) !== m.sha256)
      throw new DesignError(
        'DESIGN_MODULE_HASH_CHANGED',
        0,
        `embedded module ${m.path} does not match its SHA-256`,
        'The recipe was edited by hand: re-apply the design with apply_design.',
      );
    files[m.path] = m.text;
  }
  return files;
}

/** Modules whose supplied text differs from the embedded copy (the files changed since the last apply). */
export function changedModules(
  previous: readonly EmbeddedModule[],
  next: readonly EmbeddedModule[],
): { path: string; previous: string; current: string }[] {
  return next.flatMap((m) => {
    const before = previous.find((p) => p.path === m.path);
    return before !== undefined && before.sha256 !== m.sha256 ? [{ path: m.path, previous: before.sha256, current: m.sha256 }] : [];
  });
}

/**
 * The numeric arguments of one `use`: caller pairs, else the module defaults (a default may read earlier params).
 * `evaluate(text, type, scope)` evaluates in the caller's scope (`scope` = the arguments bound so far, for defaults).
 * @failure unknown / duplicate / missing / non-integer argument -> DESIGN_MODULE_PARAM
 */
export function moduleArguments(
  def: ModuleDef,
  pairs: readonly Pair[],
  line: number,
  evaluate: (text: string, type: ModuleParamType, bound: Readonly<Record<string, number>>) => number,
): Record<string, number> {
  const bad = (detail: string, fix: string): DesignError => new DesignError('DESIGN_MODULE_PARAM', line, `${def.path}: ${detail}`, fix);
  const known = def.params.map((p) => p.name);
  const given = new Map<string, string>();
  for (const pair of pairs) {
    const key = pair.key.join('.');
    const near = similarNames(key, known);
    if (!known.includes(key))
      throw bad(
        `unknown argument "${key}"`,
        near.length > 0 ? `Did you mean ${near.join(', ')}?` : `Arguments: ${known.join(', ') || '(none)'}.`,
      );
    if (given.has(key)) throw bad(`argument ${key} is given twice`, 'Pass each argument once.');
    if (pair.value.kind !== 'word') throw bad(`argument ${key} must be a number or expression`, 'Write key=12 or key=(w/2 + 1).');
    given.set(key, pair.value.text);
  }
  const bound: Record<string, number> = {};
  for (const param of def.params) {
    const text = given.get(param.name);
    const source = text ?? param.fallback;
    if (source === null) throw bad(`argument ${param.name} (${param.type}) is required`, `Pass ${param.name}=<value>.`);
    const value = evaluate(source, param.type, text === undefined ? bound : {});
    if (param.type === 'int' && !Number.isInteger(value))
      throw bad(`${param.name} must be an integer, got ${value}`, 'Pass a whole number.');
    bound[param.name] = value;
  }
  return bound;
}
