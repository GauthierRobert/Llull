/**
 * Line-number template (02 RTE §5.9): `{placeholder}` fields, literal text and optional `[...]` groups that vanish when a field inside is empty.
 * Placeholders: dn, service, sequence, spec, insulationCode, insulationThickness. The document keeps one template (`plant.piping.settings`,
 * `set_piping_settings`); results name it and say when it is the default. Parsing a number back into fields is best effort and only reported.
 * @invariant render and parse use the same template; a template is valid when `templateProblem` returns null
 */

import type { PipeLine, PipingModel } from '@aec/plant/types';

export const DEFAULT_LINE_NUMBER_TEMPLATE = '{dn}-{service}-{sequence}-{spec}[-{insulationCode}{insulationThickness}]';

export const PLACEHOLDERS = ['dn', 'service', 'sequence', 'spec', 'insulationCode', 'insulationThickness'] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];

export type LineNumberFields = Pick<PipeLine, 'dn' | 'service' | 'sequence' | 'spec'> & {
  readonly insulation?: Pick<NonNullable<PipeLine['insulation']>, 'code' | 'thicknessMm'> | undefined;
};

type Token =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'field'; readonly name: Placeholder }
  | { readonly kind: 'group'; readonly tokens: Token[] };

const isPlaceholder = (name: string): name is Placeholder => (PLACEHOLDERS as readonly string[]).includes(name);

/** Why `template` cannot be used, or null. */
export function templateProblem(template: string): string | null {
  if (template.length === 0 || template.length > 120) return 'the template must be 1 to 120 characters';
  let depth = 0;
  for (const ch of template) {
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (depth > 1) return 'optional groups [...] cannot be nested';
    if (depth < 0) return 'unbalanced ]';
  }
  if (depth !== 0) return 'unbalanced [';
  const names = [...template.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] as string);
  const unknown = names.find((name) => !isPlaceholder(name));
  if (unknown !== undefined) return `unknown placeholder {${unknown}} (use ${PLACEHOLDERS.map((name) => `{${name}}`).join(', ')})`;
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) return `{${repeated}} appears twice`;
  if (!names.includes('sequence')) return 'the template needs {sequence}: it is what makes line numbers unique';
  if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ''))) return 'a stray brace: write placeholders as {name}';
  return null;
}

function tokenize(template: string): Token[] {
  const root: Token[] = [];
  let group: Token[] | null = null;
  for (const part of template.split(/(\[|\]|\{[^{}]*\})/).filter((text) => text !== '')) {
    const target: Token[] = group ?? root;
    if (part === '[') group = [];
    else if (part === ']' && group !== null) {
      root.push({ kind: 'group', tokens: group });
      group = null;
    } else if (part.startsWith('{')) target.push({ kind: 'field', name: part.slice(1, -1) as Placeholder });
    else target.push({ kind: 'text', text: part });
  }
  return root;
}

const valueOf = (fields: LineNumberFields, name: Placeholder): string => {
  switch (name) {
    case 'dn':
      return String(fields.dn);
    case 'service':
      return fields.service;
    case 'sequence':
      return fields.sequence;
    case 'spec':
      return fields.spec;
    case 'insulationCode':
      return fields.insulation?.code ?? '';
    case 'insulationThickness':
      return fields.insulation === undefined ? '' : String(fields.insulation.thicknessMm);
  }
};

function renderTokens(tokens: readonly Token[], fields: LineNumberFields): string {
  return tokens
    .map((token) => {
      if (token.kind === 'text') return token.text;
      if (token.kind === 'field') return valueOf(fields, token.name);
      const empty = token.tokens.some((inner) => inner.kind === 'field' && valueOf(fields, inner.name) === '');
      return empty ? '' : renderTokens(token.tokens, fields);
    })
    .join('');
}

/** The line number `template` gives for `fields`. */
export const renderLineNumber = (template: string, fields: LineNumberFields): string => renderTokens(tokenize(template), fields);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FIELD_PATTERN: Readonly<Record<Placeholder, string>> = {
  dn: '\\d+',
  service: '.+?',
  sequence: '.+?',
  spec: '.+?',
  insulationCode: '[A-Za-z]+',
  insulationThickness: '\\d+(?:\\.\\d+)?',
};

function patternOf(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.kind === 'text') return escape(token.text);
      if (token.kind === 'field') return `(?<${token.name}>${FIELD_PATTERN[token.name]})`;
      return `(?:${patternOf(token.tokens)})?`;
    })
    .join('');
}

export interface ParsedLineNumber {
  readonly matched: boolean;
  /** Placeholder values read from the number (empty when it does not match). */
  readonly fields: Readonly<Record<string, string>>;
  /** Fields whose parsed value differs from the line's own (never corrected, only reported). */
  readonly differences: ReadonlyArray<{ readonly field: string; readonly parsed: string; readonly line: string }>;
}

/**
 * Best-effort reading of `lineNumber` with `template`, compared with the line's fields.
 * @failure a template `templateProblem` refuses (too long, nested or unbalanced groups, repeated placeholders) is never compiled -> not matched
 */
export function parseLineNumber(template: string, lineNumber: string, fields: LineNumberFields): ParsedLineNumber {
  if (templateProblem(template) !== null) return { matched: false, fields: {}, differences: [] };
  const match = new RegExp(`^${patternOf(tokenize(template))}$`).exec(lineNumber);
  if (match === null) return { matched: false, fields: {}, differences: [] };
  const parsed = Object.fromEntries(
    Object.entries(match.groups ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const differences = Object.entries(parsed).flatMap(([field, value]) => {
    const line = valueOf(fields, field as Placeholder);
    return line === value ? [] : [{ field, parsed: value, line }];
  });
  return { matched: true, fields: parsed, differences };
}

/** The template of the document and whether it is the default. */
export function lineNumberTemplate(piping: Pick<PipingModel, 'settings'>): { readonly value: string; readonly defaulted: boolean } {
  const custom = piping.settings?.lineNumberTemplate;
  return custom === undefined ? { value: DEFAULT_LINE_NUMBER_TEMPLATE, defaulted: true } : { value: custom, defaulted: false };
}
