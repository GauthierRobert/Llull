/**
 * Schema-directed values: the param schema of the target command decides how an unquoted word reads — an enum member, an alias or plain
 * text, a number or an expression, a face anchor. The result is a template resolved per run (run.ts), since expressions read the
 * document parameters and loop variables, and names read the aliases bound so far.
 * @failure unknown param, wrong value shape, non-member enum word, bad expression -> DesignError with the line
 */

import type { CadDocument } from '@core/model/types';
import type { CommandDefinition, ParamItemSpec } from '@core/commands/types';
import { evaluateExpression, expressionSyntaxError, extractReferences, isBuiltinConstant } from '@lib/expression';
import { isRecord } from '@lib/isRecord';
import { similarNames } from '@lib/similarNames';
import { DesignError } from './errors';
import type { Pair, ValueNode } from './parse';
import { convertUnits } from './units';

/** An arithmetic expression over parameters / loop variables (units already converted). */
export class ExprRef {
  constructor(readonly text: string) {}
}

/** A word that is an alias id when such an alias is bound at run time, else the literal text (`{expr}` placeholders filled). */
export class NameRef {
  constructor(readonly text: string) {}
}

/** `alias.side`: a world point on that side of the alias — `{ near: point }` for face pickers, the bare point for `[x, y, z]` params. */
export class AnchorRef {
  constructor(
    readonly alias: string,
    readonly side: string,
    readonly asPoint = false,
  ) {}
}

export type Template = number | string | boolean | null | ExprRef | NameRef | AnchorRef | Template[] | { [key: string]: Template };

/** `on=a.top align=back`: place the created entity against an anchor (any command that creates entities). */
interface Placement {
  readonly on: AnchorRef;
  readonly align: string | null;
}

export interface BoundCommand {
  readonly params: { [key: string]: Template };
  readonly placement: Placement | null;
}

export const SIDES: readonly string[] = ['top', 'bottom', 'front', 'back', 'left', 'right', 'center'];
const ANCHOR = /^([A-Za-z_][\w{}+\-*/]*)\.(top|bottom|front|back|left|right|center)$/;
const PLAIN_NAME = /^[A-Za-z_][\w{}+\-*/]*$/;
const ALIGNS = ['front', 'back', 'left', 'right', 'top', 'bottom'];

/** Sugar keys of the language; a command that has a param of the same name keeps its param (contract-tested). */
export const SUGAR_KEYS: readonly string[] = ['on', 'align'];

interface BindContext {
  readonly doc: Pick<CadDocument, 'units'>;
  readonly command: string;
  readonly line: number;
}

const bad = (ctx: BindContext, detail: string, fix: string): DesignError => new DesignError('DESIGN_BAD_VALUE', ctx.line, detail, fix);

/** What an expression may use (lib/expression). */
export const EXPRESSION_HELP =
  'Operators + - * / ( ); functions pow(a, b) mod(a, b) sqrt abs min max floor ceil round trunc sign exp ln log10 hypot sin cos tan ' +
  'asin acos atan atan2; constant pi; parameters and loop variables.';

/** The fix for a bad expression, pointing `^` / `%` at pow / mod. */
function expressionFix(text: string): string {
  if (text.includes('^')) return `Write powers as pow(a, b). ${EXPRESSION_HELP}`;
  if (text.includes('%')) return `Write a remainder as mod(a, b). ${EXPRESSION_HELP}`;
  return EXPRESSION_HELP;
}

/** The params template of one command line. */
export function bindCommand(
  def: CommandDefinition<unknown>,
  pairs: readonly Pair[],
  doc: Pick<CadDocument, 'units'>,
  line: number,
): BoundCommand {
  const ctx: BindContext = { doc, command: def.name, line };
  const properties = def.paramsSchema.properties;
  const params: { [key: string]: Template } = {};
  let on: AnchorRef | null = null;
  let align: string | null = null;
  const seen = new Set<string>();
  for (const pair of pairs) {
    const [head = '', ...rest] = pair.key;
    const keyText = pair.key.join('.');
    if (seen.has(keyText)) throw bad(ctx, `${keyText} is set twice`, 'Keep one value per key.');
    seen.add(keyText);
    if (SUGAR_KEYS.includes(head) && properties[head] === undefined && rest.length === 0) {
      if (head === 'on') on = anchorOf(pair.value, ctx);
      else align = alignOf(pair.value, ctx);
      continue;
    }
    let spec: ParamItemSpec | undefined = properties[head];
    if (spec === undefined) throw unknownParam(ctx, head, Object.keys(properties));
    let target = params;
    let walked = head;
    for (const segment of rest) {
      const child = (target[walked] ??= {});
      if (!isRecord(child) || child instanceof ExprRef || child instanceof NameRef || child instanceof AnchorRef)
        throw bad(ctx, `${pair.key.join('.')} sets inside a value that is not an object`, 'Set the object with dotted keys only.');
      target = child as { [key: string]: Template };
      const freeObject: boolean = spec.type === 'object' && Object.keys(spec.properties ?? {}).length === 0;
      const next: ParamItemSpec | undefined = spec.properties?.[segment] ?? spec.additionalProperties ?? (freeObject ? {} : undefined);
      if (next === undefined && spec.anyOf !== undefined)
        throw bad(ctx, `${walked} has several shapes`, `Write it whole as JSON: ${walked}={"field": value, …}.`);
      if (next === undefined)
        throw unknownParam(
          ctx,
          pair.key.join('.'),
          Object.keys(spec.properties ?? {}).map((k) => `${walked}.${k}`),
        );
      spec = next;
      walked = segment;
    }
    target[walked] = bindValue(pair.value, spec, `${def.name}.${pair.key.join('.')}`, ctx);
  }
  if (align !== null && on === null) throw bad(ctx, 'align= needs on=', 'Add on=<alias>.<side>.');
  return { params, placement: on === null ? null : { on, align } };
}

function unknownParam(ctx: BindContext, key: string, known: readonly string[]): DesignError {
  return new DesignError(
    'DESIGN_UNKNOWN_PARAM',
    ctx.line,
    `${ctx.command} has no param "${key}"`,
    `Params: ${known.join(', ') || '(none)'}.`,
  );
}

function anchorOf(node: ValueNode, ctx: BindContext): AnchorRef {
  const m = node.kind === 'word' ? ANCHOR.exec(node.text) : null;
  if (m?.[1] && m[2]) return new AnchorRef(m[1], m[2]);
  const side = node.kind === 'word' ? /\.(\w+)$/.exec(node.text)?.[1] : undefined;
  const near = side === undefined ? [] : similarNames(side, SIDES);
  throw bad(
    ctx,
    `on= takes <alias>.<side>${side === undefined ? '' : `, "${side}" is not a side`}`,
    near.length > 0 ? `Did you mean ${near.join(', ')}?` : `Sides: ${SIDES.join(', ')}.`,
  );
}

function alignOf(node: ValueNode, ctx: BindContext): string {
  if (node.kind !== 'word' || !ALIGNS.includes(node.text)) throw bad(ctx, 'align= takes a side', `One of ${ALIGNS.join(', ')}.`);
  return node.text;
}

/** One value against its schema. `key` = `<command>.<param path>` (angle-unit lookup). */
function bindValue(node: ValueNode, spec: ParamItemSpec, key: string, ctx: BindContext): Template {
  if (node.kind === 'json') return node.value as Template;
  const branch = spec.anyOf !== undefined ? chooseBranch(node, spec.anyOf) : spec;
  if (branch.enum !== undefined) return enumValue(node, branch.enum, ctx);
  switch (branch.type) {
    case 'number':
    case 'integer':
      return numberValue(node, key, ctx);
    case 'boolean':
      if (node.kind === 'word' && (node.text === 'true' || node.text === 'false')) return node.text === 'true';
      throw bad(ctx, `${key} takes true or false`, 'Write true or false.');
    case 'string':
      if (node.kind === 'string') return node.value;
      if (node.kind === 'word') return new NameRef(node.text);
      throw bad(ctx, `${key} takes a single name or "text"`, 'Quote text with "…".');
    case 'array': {
      const anchor = node.kind === 'word' ? ANCHOR.exec(node.text) : null;
      if (anchor?.[1] && anchor[2] && branch.items?.type === 'number') return new AnchorRef(anchor[1], anchor[2], true);
      if (node.kind !== 'list')
        throw bad(ctx, `${key} takes a list [a, b, …]`, 'Write the value as [a, b, …] (a point may be an anchor: base.top).');
      const items = branch.items ?? {};
      return node.items.map((item) => bindValue(item, items, key, ctx));
    }
    case 'object': {
      const anchor = node.kind === 'word' ? ANCHOR.exec(node.text) : null;
      if (anchor?.[1] && anchor[2] && branch.properties?.['near'] !== undefined) return new AnchorRef(anchor[1], anchor[2]);
      throw bad(
        ctx,
        `${key} is an object`,
        `Set its fields with dotted keys (${key.split('.').slice(1).join('.')}.<field>=…) or write it as JSON {"field": value}.`,
      );
    }
    default:
      return untypedValue(node, key, ctx);
  }
}

function chooseBranch(node: ValueNode, branches: readonly ParamItemSpec[]): ParamItemSpec {
  const byType = (type: string): ParamItemSpec | undefined => branches.find((b) => b.type === type && b.enum === undefined);
  const first = branches[0] ?? {};
  if (node.kind === 'list') return byType('array') ?? first;
  if (node.kind === 'string') return byType('string') ?? branches.find((b) => b.enum !== undefined) ?? first;
  if (node.kind !== 'word') return byType('object') ?? first;
  const member = branches.find((b) => b.enum?.some((v) => String(v) === node.text));
  if (member !== undefined) return member;
  if ((node.text === 'true' || node.text === 'false') && byType('boolean')) return byType('boolean') ?? first;
  const nearObject = branches.find((b) => b.type === 'object' && b.properties?.['near'] !== undefined);
  if (ANCHOR.test(node.text) && nearObject !== undefined) return nearObject;
  if (PLAIN_NAME.test(node.text) && byType('string') !== undefined) return byType('string') ?? first;
  return byType('number') ?? byType('integer') ?? byType('string') ?? first;
}

function enumValue(node: ValueNode, members: readonly (string | number)[], ctx: BindContext): Template {
  const text = node.kind === 'word' ? node.text : node.kind === 'string' ? node.value : null;
  const member = members.find((m) => String(m) === text);
  if (member === undefined)
    throw new DesignError('DESIGN_BAD_ENUM', ctx.line, `"${text ?? '…'}" is not allowed here`, `One of: ${members.join(', ')}.`);
  return member;
}

function numberValue(node: ValueNode, key: string, ctx: BindContext): Template {
  if (node.kind !== 'word') throw bad(ctx, `${key} takes a number or an expression`, 'Write a number, e.g. 12 or w/2 + 5mm.');
  const angleKey = key.replace(/\.\d+(?=\.|$)/g, '');
  const text = convertUnits(node.text, { units: siLengthUnit(angleKey) ?? ctx.doc.units }, angleKey, ctx.line);
  const syntaxError = expressionSyntaxError(text.replace(/\{[^{}]*\}/g, '0'));
  if (syntaxError !== null) throw bad(ctx, `bad expression "${node.text}": ${syntaxError}`, expressionFix(node.text));
  const free = [...extractReferences(text)].filter((name) => !isBuiltinConstant(name));
  if (free.length > 0) return new ExprRef(text);
  const result = evaluateExpression(text, {});
  if (!result.ok) throw bad(ctx, `bad expression "${node.text}": ${result.error}`, expressionFix(node.text));
  return result.value;
}

/** A param named in SI units (`throatDiameterM`, `spanM`: metres; `…Mm`: millimetres) takes length literals in that unit. */
function siLengthUnit(key: string): 'm' | 'mm' | null {
  const last = key.split('.').pop() ?? '';
  if (/[a-z]Mm$/.test(last)) return 'mm';
  return /[a-z]M$/.test(last) ? 'm' : null;
}

function untypedValue(node: ValueNode, key: string, ctx: BindContext): Template {
  if (node.kind === 'string') return node.value;
  if (node.kind === 'list') return node.items.map((item) => untypedValue(item, key, ctx));
  if (node.kind !== 'word') return null;
  if (node.text === 'true' || node.text === 'false') return node.text === 'true';
  if (PLAIN_NAME.test(node.text) && !/[+\-*/]/.test(node.text)) return new NameRef(node.text);
  return numberValue(node, key, ctx);
}
