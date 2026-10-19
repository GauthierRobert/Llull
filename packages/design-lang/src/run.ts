/**
 * The interpreter: runs design statements in order through `execute` (inside the `design_source` step, so every nested command joins it
 * and ids are step-scoped and stable across regenerations). Values resolve per run against the document parameters, loop variables,
 * aliases bound so far and the real geometry (anchors).
 * @invariant never writes the parameter table (only metaHistory commands may, L8): `param` lines must already have a value
 * @failure any line -> DesignError (the caller returns the input document)
 */

import { execute, getCommand, listCommands } from '@core/commands/registry';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { evaluateExpression, extractReferences, isBuiltinConstant } from '@lib/expression';
import { similarNames } from '@lib/similarNames';
import { isRecord } from '@lib/isRecord';
import { DesignError } from './errors';
import type { Statement } from './parse';
import { AnchorRef, bindCommand, EXPRESSION_HELP, ExprRef, NameRef, type BoundCommand, type Template } from './schemaValue';
import { exactFacePoint, frameOf, placementDelta, sidePoint, type Frame } from './anchors';
import { runCheck, type CheckResult, type CheckScope } from './checks';
import { convertUnits } from './units';

type CommandStatement = Extract<Statement, { kind: 'command' }>;
type CheckStatement = Extract<Statement, { kind: 'check' }>;
type Env = Readonly<Record<string, number>>;

/** Commands a design may not call (they run designs themselves). */
export const DESIGN_COMMANDS: readonly string[] = [
  'apply_design',
  'design_source',
  'check_design',
  'export_design',
  'describe_design_syntax',
];

const MAX_COMMANDS = 5000;
const MAX_ITERATIONS = 1000;
const MAX_CHECKS = 1000;

export interface DesignRun {
  readonly document: CadDocument;
  readonly affected: string[];
  /** Alias -> the ids it names: the records a line made (walls, pipes, stacks…) if any, else its entities. */
  readonly aliases: Record<string, string[]>;
  /** Alias -> its geometry entities (what anchors and geometric metrics measure). */
  readonly geometry: Record<string, string[]>;
  readonly checks: CheckResult[];
  /** Commands executed (loop iterations included). */
  readonly commands: number;
}

interface AliasRecord {
  /** What the alias names (record ids, else entity ids). */
  readonly ids: readonly string[];
  /** Its entities (anchors, bbox / volume checks). */
  readonly geometry: readonly string[];
  readonly line: number;
  /** World box captured when its entities are consumed (live entities are measured when anchored on). */
  frame: Frame | null;
}

/** Why a metaHistory / session command is not a design line, and where it goes instead. */
function metaHint(name: string): string {
  if (name === 'set_parameter' || name === 'delete_parameter')
    return 'Declare parameters with `param <name> = <default>` (apply_design set= overrides).';
  if (['create_configuration', 'activate_configuration', 'save_recipe'].includes(name))
    return `Configurations and recipes are document inputs: run \`llull ${name} …\` after apply_design.`;
  if (name === 'set_camera' || name === 'fit_view') return 'The view is not part of the model: run it after apply_design.';
  return 'Run it outside the design (it is not part of the recipe).';
}

/** Run `statements` on `doc` (every query and command through `ctx`, default: the current context). */
export function runDesign(doc: CadDocument, statements: readonly Statement[], ctx?: ExecutionContext): DesignRun {
  const run = new DesignRunner(doc, ctx);
  run.block(statements, {});
  const checks = run.pendingChecks.map(({ statement, env }) => runCheck(statement, run.checkScope(env)));
  return { document: run.doc, affected: [...run.affected], ...run.aliasTables(), checks, commands: run.commands };
}

/** Evaluate the `check` lines of `statements` on `doc`, with aliases bound by an earlier run (commands are not executed). */
export function evaluateChecks(
  doc: CadDocument,
  statements: readonly Statement[],
  aliases: Readonly<Record<string, readonly string[]>>,
  geometry: Readonly<Record<string, readonly string[]>>,
): CheckResult[] {
  const run = new DesignRunner(doc, undefined);
  for (const [name, ids] of Object.entries(aliases)) run.bind(name, ids, geometry[name] ?? ids);
  run.collectChecks(statements, {});
  return run.pendingChecks.map(({ statement, env }) => runCheck(statement, run.checkScope(env)));
}

class DesignRunner {
  doc: CadDocument;
  commands = 0;
  readonly affected = new Set<string>();
  readonly pendingChecks: { statement: CheckStatement; env: Env }[] = [];
  private readonly aliases = new Map<string, AliasRecord>();
  /** Entity id -> the line (and alias) that consumed it. */
  private readonly consumed = new Map<string, { line: number; by: string | null }>();
  private readonly bound = new Map<Statement, BoundCommand>();
  /** Entity id -> the alias that last bound it. */
  private readonly aliasOf = new Map<string, string>();

  constructor(
    doc: CadDocument,
    private readonly ctx: ExecutionContext | undefined,
  ) {
    this.doc = doc;
  }

  block(statements: readonly Statement[], env: Env): void {
    for (const statement of statements) {
      if (statement.kind === 'command') this.command(statement, env);
      else if (statement.kind === 'check') this.queueCheck(statement, env);
      else if (statement.kind === 'for') this.loop(statement, env);
      else if (statement.kind === 'param' && this.doc.parameters[statement.name] === undefined)
        throw new DesignError(
          'DESIGN_UNKNOWN_PARAMETER',
          statement.line,
          `parameter "${statement.name}" has no value`,
          'Apply the design with apply_design: it sets every param default before running.',
        );
    }
  }

  bind(name: string, ids: readonly string[], geometry: readonly string[]): void {
    this.aliases.set(name, { ids, geometry, line: 0, frame: null });
  }

  /** Queue the checks of `statements` (loops expanded) without executing commands. */
  collectChecks(statements: readonly Statement[], env: Env): void {
    for (const statement of statements) {
      if (statement.kind === 'check') this.queueCheck(statement, env);
      if (statement.kind !== 'for') continue;
      const { from, to } = this.bounds(statement, env);
      for (let value = from; value <= to; value++) this.collectChecks(statement.body, { ...env, [statement.variable]: value });
    }
  }

  private queueCheck(statement: CheckStatement, env: Env): void {
    if (this.pendingChecks.length >= MAX_CHECKS)
      throw new DesignError(
        'DESIGN_LOOP_LIMIT',
        statement.line,
        `more than ${MAX_CHECKS} checks`,
        'Check fewer instances (outside the loop).',
      );
    this.pendingChecks.push({ statement, env });
  }

  aliasTables(): Pick<DesignRun, 'aliases' | 'geometry'> {
    const entries = [...this.aliases];
    return {
      aliases: Object.fromEntries(entries.map(([name, record]) => [name, [...record.ids]])),
      geometry: Object.fromEntries(entries.map(([name, record]) => [name, [...record.geometry]])),
    };
  }

  checkScope(env: Env): CheckScope {
    return {
      doc: this.doc,
      ctx: this.ctx,
      pathKey: (text) => (this.aliases.has(text) ? (this.aliases.get(text)?.ids[0] ?? text) : text),
      aliasIds: (name, line) => this.geometryIds(this.interpolate(name, env, line), line),
      resolve: (template, line) => this.resolve(template as Template, env, line),
      evaluate: (text, line) => this.evaluate(convertUnits(text, this.doc, null, line), env, line),
    };
  }

  private loop(statement: Extract<Statement, { kind: 'for' }>, env: Env): void {
    const { from, to } = this.bounds(statement, env);
    for (let value = from; value <= to; value++) this.block(statement.body, { ...env, [statement.variable]: value });
  }

  private bounds(statement: Extract<Statement, { kind: 'for' }>, env: Env): { from: number; to: number } {
    const { line } = statement;
    const from = this.evaluate(convertUnits(statement.from, this.doc, null, line), env, line);
    const to = this.evaluate(convertUnits(statement.to, this.doc, null, line), env, line);
    if (!Number.isInteger(from) || !Number.isInteger(to))
      throw new DesignError('DESIGN_BAD_VALUE', line, `loop bounds ${from}..${to} are not integers`, 'Use integer bounds, e.g. 0..n-1.');
    if (to - from + 1 > MAX_ITERATIONS)
      throw new DesignError(
        'DESIGN_LOOP_LIMIT',
        line,
        `loop runs ${to - from + 1} times`,
        `Keep a loop under ${MAX_ITERATIONS} iterations.`,
      );
    return { from, to };
  }

  private command(statement: CommandStatement, env: Env): void {
    const { line } = statement;
    const def = getCommand(statement.command);
    if (def === undefined || DESIGN_COMMANDS.includes(statement.command)) {
      const names = listCommands()
        .map((c) => c.name)
        .filter((n) => !DESIGN_COMMANDS.includes(n));
      const near = similarNames(statement.command, names);
      throw new DesignError(
        'DESIGN_UNKNOWN_COMMAND',
        line,
        def === undefined ? `unknown command "${statement.command}"` : `${statement.command} cannot run inside a design`,
        near.length > 0 ? `Did you mean ${near.join(', ')}?` : 'Find commands with `llull search <words>`.',
      );
    }
    if (def.annotations?.readOnly === true)
      throw new DesignError(
        'DESIGN_BAD_VALUE',
        line,
        `${def.name} only reads the document: as a line it does nothing`,
        `Make it a check: check ${def.name} <params> path=<data path> expect == <value>`,
      );
    if (def.annotations?.metaHistory === true || def.annotations?.session === true)
      throw new DesignError(
        'DESIGN_BAD_VALUE',
        line,
        `${def.name} edits the document's inputs or history, not its geometry`,
        metaHint(def.name),
      );
    if (++this.commands > MAX_COMMANDS)
      throw new DesignError('DESIGN_LOOP_LIMIT', line, `more than ${MAX_COMMANDS} commands`, 'Split the design or reduce loop counts.');
    let bound = this.bound.get(statement);
    if (bound === undefined) {
      bound = bindCommand(def, statement.pairs, this.doc, line);
      this.bound.set(statement, bound);
    }
    this.approximateAnchors = [];
    const alias = statement.alias === null ? null : this.interpolate(statement.alias, env, line);
    const before = this.doc;
    this.doc = this.exec(def.name, this.resolve(bound.params, env, line), line);
    const gone = Object.keys(before.entities).filter((id) => this.doc.entities[id] === undefined);
    this.captureFrames(before, gone);
    for (const id of gone) this.consumed.set(id, { line, by: alias });
    const created = this.lastAffected.filter((id) => this.doc.entities[id] !== undefined && before.entities[id] === undefined);
    if (bound.placement !== null) this.place(created, bound.placement.on, bound.placement.align, env, line);
    if (alias !== null) this.bindLine(alias, def.name, before, created, line);
  }

  private lastAffected: string[] = [];
  private lastData: unknown = undefined;
  /** Anchors of the current line that fell back to a bounding-box side (no exact face available). */
  private approximateAnchors: string[] = [];

  /** Execute one command; a refusal or a no-op of a mutating command is a DESIGN_STEP_FAILED at `line`. */
  private exec(name: string, params: unknown, line: number): CadDocument {
    const r = execute(this.doc, name, params, this.ctx);
    const annotations = getCommand(name)?.annotations;
    const quietNoop = annotations?.idempotent === true;
    const planFailed = isRecord(r.data) && r.data['ok'] === false;
    if (r.error !== undefined || r.rejected === true || planFailed || (r.document === this.doc && !quietNoop))
      throw new DesignError(
        'DESIGN_STEP_FAILED',
        line,
        r.summary,
        (/FACE/.test(r.error?.code ?? '') ? this.anchorHint() : null) ??
          r.error?.remediation ??
          this.nameHint(params) ??
          `See \`llull describe ${name}\`.`,
      );
    this.lastAffected = r.affected;
    this.lastData = r.data;
    for (const id of r.affected) this.affected.add(id);
    return r.document;
  }

  /** Keep the box of every alias whose entities `gone` removes, measured on `before` (anchors on consumed aliases use it). */
  private captureFrames(before: CadDocument, gone: readonly string[]): void {
    for (const name of new Set(gone.map((id) => this.aliasOf.get(id)))) {
      const record = name === undefined ? undefined : this.aliases.get(name);
      if (record !== undefined && record.frame === null)
        record.frame = frameOf(
          before,
          record.geometry.filter((id) => before.entities[id] !== undefined),
          this.ctx,
        );
    }
  }

  /** Why an anchored line may miss its face: the anchor is a bounding-box side, not an exact face. */
  private anchorHint(): string | null {
    if (this.approximateAnchors.length === 0) return null;
    return (
      `${this.approximateAnchors.join(', ')} is the centre of a side of the bounding box (this kernel has no exact faces), which ` +
      'can miss the face: anchor on the part that owns the face (wall.top rather than body.top), give the point yourself ' +
      '(face.near=[x, y, z]), or use the OCC kernel (LLULL_KERNEL=occt).'
    );
  }

  /** "Did you mean <alias>?" when a step failed and a plain name in its params is close to a bound alias. */
  private nameHint(params: unknown): string | null {
    const names = [...this.aliases.keys()];
    const words: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string') words.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (isRecord(value)) Object.values(value).forEach(collect);
    };
    collect(params);
    for (const word of words) {
      const near = this.doc.entities[word] === undefined ? similarNames(word, names) : [];
      if (near.length > 0) return `"${word}" is not an alias — did you mean ${near.join(', ')}?`;
    }
    return null;
  }

  private place(created: readonly string[], on: AnchorRef, align: string | null, env: Env, line: number): void {
    const frame = frameOf(this.doc, created, this.ctx);
    if (frame === null)
      throw new DesignError(
        'DESIGN_BAD_VALUE',
        line,
        'on= needs a command that creates geometry',
        'Remove on=, or place it with position=.',
      );
    const anchor = this.anchor(on, env, line);
    const delta = placementDelta(frame, anchor.point, anchor.frame, on.side, align);
    if (delta.every((d) => Math.abs(d) < 1e-12)) return;
    this.doc = this.exec('move_entities', { ids: [...created], delta }, line);
  }

  private anchor(ref: AnchorRef, env: Env, line: number): { point: Vec3; frame: Frame } {
    const name = this.interpolate(ref.alias, env, line);
    const record = this.aliases.get(name);
    if (record === undefined) {
      const near = similarNames(name, [...this.aliases.keys()]);
      throw new DesignError(
        'DESIGN_UNKNOWN_ANCHOR',
        line,
        `unknown anchor ${name}.${ref.side}`,
        near.length > 0 ? `Did you mean ${near.join(', ')}?` : 'Anchor on an alias bound on an earlier line.',
      );
    }
    const live = record.geometry.filter((id) => this.doc.entities[id] !== undefined);
    const frame = (live.length > 0 ? frameOf(this.doc, live, this.ctx) : null) ?? record.frame;
    if (frame === null)
      throw new DesignError('DESIGN_UNKNOWN_ANCHOR', line, `${name} has no geometry to anchor on`, 'Anchor on a solid or shape.');
    const exact = live.length === 1 && live[0] !== undefined ? exactFacePoint(this.doc, live[0], ref.side, this.ctx) : null;
    if (exact === null && ref.side !== 'center') this.approximateAnchors.push(`${name}.${ref.side}`);
    return { point: exact ?? sidePoint(frame, ref.side), frame };
  }

  /**
   * Bind `alias` to what the line made: its records (non-entity ids in `affected` and `data.*Id(s)`: walls, pipes, surfaces, fastener
   * stacks…) if any, else the entities it created, else what it changed. Geometry = its created entities (those derived from its records
   * when it has both: `wall-1:body-0` for `wall-1`, not the wall a door cut).
   */
  private bindLine(alias: string, command: string, before: CadDocument, created: readonly string[], line: number): void {
    const isEntity = (id: string): boolean => this.doc.entities[id] !== undefined || before.entities[id] !== undefined;
    const records: string[] = [];
    const add = (id: unknown): void => {
      if (typeof id === 'string' && id !== '' && !isEntity(id) && !records.includes(id)) records.push(id);
    };
    this.lastAffected.forEach(add);
    if (isRecord(this.lastData))
      for (const [key, value] of Object.entries(this.lastData))
        if (/Ids?$/.test(key)) (Array.isArray(value) ? value : [value]).forEach(add);
    const derived = created.filter((id) => records.some((record) => id.startsWith(`${record}:`)));
    const changed = this.lastAffected.filter((id) => this.doc.entities[id] !== undefined);
    const ids = records.length > 0 ? records : created.length > 0 ? [...created] : changed;
    const geometry = derived.length > 0 ? derived : created.length > 0 ? [...created] : changed;
    if (ids.length === 0)
      throw new DesignError(
        'DESIGN_UNKNOWN_ALIAS',
        line,
        `${command} reports no id to bind "${alias}" to`,
        'Drop the alias ("_") and refer to what it made by its name, e.g. materialName="steel".',
      );
    this.aliases.set(alias, { ids, geometry, line, frame: null });
    for (const id of geometry) this.aliasOf.set(id, alias);
  }

  /** Live geometry entities of an alias, else its live ids (a check measures geometry). */
  private geometryIds(name: string, line: number): string[] {
    const live = this.liveIds(name, line);
    const geometry = this.aliases.get(name)?.geometry.filter((id) => this.doc.entities[id] !== undefined) ?? [];
    return geometry.length > 0 ? geometry : live;
  }

  /** Live ids of an alias. */
  private liveIds(name: string, line: number): string[] {
    const record = this.aliases.get(name);
    if (record === undefined) {
      const near = similarNames(name, [...this.aliases.keys()]);
      throw new DesignError(
        'DESIGN_UNKNOWN_ALIAS',
        line,
        `unknown alias "${name}"`,
        near.length > 0 ? `Did you mean ${near.join(', ')}?` : 'Bind it on an earlier line: <command> <alias> …',
      );
    }
    const live = record.ids.filter((id) => !this.consumed.has(id));
    if (live.length === 0 && record.ids.length > 0) {
      const consumer = this.consumed.get(record.ids[0] ?? '');
      const heir = consumer?.by ? this.liveHeir(consumer.by) : null;
      throw new DesignError(
        'DESIGN_ALIAS_CONSUMED',
        line,
        `${name} was consumed at line ${consumer?.line ?? '?'}`,
        heir !== null ? `Use ${heir} instead.` : 'Bind the consuming line to an alias and use it.',
      );
    }
    return live;
  }

  /** `name`, or the alias that consumed it, followed until one is still live (null when the chain ends unnamed). */
  private liveHeir(name: string): string | null {
    let current = name;
    for (let hops = 0; hops < 1000; hops++) {
      const first = this.aliases.get(current)?.ids[0];
      const next = first === undefined ? undefined : this.consumed.get(first);
      if (next === undefined) return current;
      if (next.by === null) return null;
      current = next.by;
    }
    return null;
  }

  private resolve(template: Template, env: Env, line: number): unknown {
    if (template instanceof ExprRef) return this.evaluate(template.text, env, line);
    if (template instanceof NameRef) {
      const ids = this.namedIds(template.text, env, line);
      return ids === null ? this.interpolate(template.text, env, line) : (ids[0] ?? template.text);
    }
    if (template instanceof AnchorRef) {
      const point = this.anchor(template, env, line).point;
      return template.asPoint ? point : { near: point };
    }
    if (Array.isArray(template))
      return template.flatMap((item) => {
        const ids = item instanceof NameRef ? this.namedIds(item.text, env, line) : null;
        return ids ?? [this.resolve(item, env, line)];
      });
    if (template !== null && typeof template === 'object')
      return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, this.resolve(value, env, line)]));
    return template;
  }

  /** Live ids of the alias a word names (`sketch`, `post{i}`, `sketch[1]` = its second id), or null when it names no alias. */
  private namedIds(text: string, env: Env, line: number): string[] | null {
    const indexed = /^(.*)\[(\d+)\]$/.exec(text);
    const name = this.interpolate(indexed?.[1] ?? text, env, line);
    if (!this.aliases.has(name)) return null;
    const ids = this.liveIds(name, line);
    if (indexed?.[2] === undefined) return ids;
    const id = ids[Number(indexed[2])];
    if (id === undefined)
      throw new DesignError(
        'DESIGN_UNKNOWN_ALIAS',
        line,
        `${name} has ${ids.length} id(s), no [${indexed[2]}]`,
        `Index from 0 to ${ids.length - 1}.`,
      );
    return [id];
  }

  private evaluate(text: string, env: Env, line: number): number {
    const values: Record<string, number> = { ...this.parameterValues(), ...env };
    const unknown = [...extractReferences(text)].filter((name) => !isBuiltinConstant(name) && values[name] === undefined);
    if (unknown.length > 0) {
      const near = similarNames(unknown[0] ?? '', Object.keys(values));
      throw new DesignError(
        'DESIGN_UNKNOWN_PARAMETER',
        line,
        `unknown name "${unknown[0] ?? ''}" in "${text}"`,
        near.length > 0 ? `Did you mean ${near.join(', ')}?` : 'Declare it: param <name> = <value>.',
      );
    }
    const result = evaluateExpression(text, values);
    if (!result.ok) throw new DesignError('DESIGN_BAD_VALUE', line, `cannot evaluate "${text}": ${result.error}`, EXPRESSION_HELP);
    return result.value;
  }

  private parameterValues(): Record<string, number> {
    return Object.fromEntries(Object.entries(this.doc.parameters).map(([name, p]) => [name, p.value]));
  }

  /** `post{i+1}` -> `post4`. */
  private interpolate(text: string, env: Env, line: number): string {
    return text.replace(/\{([^{}]*)\}/g, (_, body: string) => {
      const value = this.evaluate(body, env, line);
      return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
    });
  }
}
