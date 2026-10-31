/** Line-number templates (plant 04 PID §3 `lineNumberFormat`): tokens dn, fluid, seq, class, area, unit. */

import type { PidLine } from '../model';

const TOKENS = new Set(['dn', 'fluid', 'seq', 'class', 'area', 'unit']);

/** Tokens of a template that are not in the list (empty = valid). */
export const unknownTokens = (format: string): string[] =>
  [...format.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '').filter((token) => !TOKENS.has(token));

const textOf = (line: PidLine, name: string): string | undefined => {
  const value = line.attributes[name];
  return value?.kind === 'text' || value?.kind === 'enum' ? value.value : undefined;
};

/** The line number for `line` and sequence `seq`, or the names of the line fields the template needs and the line lacks. */
export function formatLineNumber(format: string, line: PidLine, seq: number): { text: string } | { missing: string[] } {
  const values: Record<string, string | undefined> = {
    dn: line.dn === undefined ? undefined : String(line.dn),
    fluid: line.fluidCode,
    seq: String(seq),
    class: line.pipingClass,
    area: textOf(line, 'area'),
    unit: textOf(line, 'unit'),
  };
  const missing: string[] = [];
  const text = format.replace(/\{([^{}]*)\}/g, (_match, token: string) => {
    const value = values[token];
    if (value === undefined) missing.push(token);
    return value ?? '';
  });
  return missing.length > 0 ? { missing } : { text };
}
