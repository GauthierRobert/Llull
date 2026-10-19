/**
 * `describe_design_syntax`: the language guide, or the `.lld` line of one command generated from its param schema (so it is never out of
 * date with the registry).
 */

import { defineCommand, z } from '@core/commands/schema';
import { getCommand, listCommands } from '@core/commands/registry';
import { codedRejection, report } from '@core/commands/noop';
import type { CommandResult, ParamItemSpec } from '@core/commands/types';
import { similarNames } from '@lib/similarNames';
import { METRICS } from './checks';
import { ANGLE_PARAMS } from './units';
import { EXPRESSION_HELP, SIDES } from './schemaValue';

const GUIDE = [
  'design <name> [units=mm|cm|m|in|ft]        optional first line; sets the document unit',
  'param <name> = <expr>                      default; an existing parameter (set_parameter, apply_design set=) wins',
  '<command> <alias> key=value …              any mutating registered command; alias optional ("_" = none)',
  '  values: 12  6mm  w/2+5mm  (t + 1)  [a, b, c]  "text"  true  base.top  {"json": "object"}',
  '    a key=value pair has no spaces outside ( ) [ ] { } "…"; bare numbers are in the document unit',
  `    expressions: ${EXPRESSION_HELP}`,
  '    a param named in SI (…M = metres, …Mm = millimetres) converts length literals to that unit; other SI params take plain numbers',
  '  words are read by the param schema: enum member | alias of an earlier line | parameter / expression',
  '  dotted keys fill objects: hole.kind=simple hole.diameter=8mm; a free-form object or a union is written as JSON {…}',
  '  an alias names what its line made: its records (wall-1, pipe-1, a fastener stack) if any, else its entities;',
  '    alias[1] picks one id; a consumed alias still anchors but no longer names an entity',
  `  anchors <alias>.<side>, sides ${SIDES.join(' ')}: a point on that face (exact face with the OCC kernel),`,
  '    as { near } for face pickers or [x, y, z] for point params',
  '  on=<alias>.<side> [align=front|back|left|right|top|bottom]: place what the line creates against that face',
  'for i in a..b {  …  }                      inclusive loop, bounds are expressions; aliases may use {expr}: post{i}',
  `check <metric> of=<alias> [path=0] expect <op> <value> [± tol[%|unit]]   metrics: ${Object.keys(METRICS).join(' ')}`,
  'check <read-only command> <params…> path=<key.key.0> expect == <value>    path is inside data; an alias name in it = its id',
  '  ops == ~= <= >= < >; values: number, [list], true/false, "text"; mass may carry kg|g|lb; ~= defaults to ± 1% (~= 0 needs ± tol)',
  '  a failing check is reported by apply_design; check_design fails (exit 1) on it',
  '# comment (at line start or after a space)',
  `angle units deg/rad only on: ${Object.keys(ANGLE_PARAMS).join(' ')}`,
  'not commands (CLI exchange tools, unusable in a design): import_step import_dwg import_code export_step',
].join('\n');

function placeholder(spec: ParamItemSpec): string {
  if (spec.enum !== undefined && spec.enum.length > 0) return spec.enum.join('|');
  if (spec.anyOf !== undefined) return spec.anyOf.map(placeholder).join(' | ');
  switch (spec.type) {
    case 'number':
      return 'n';
    case 'integer':
      return 'int';
    case 'boolean':
      return 'true|false';
    case 'string':
      return 'name|"text"';
    case 'array':
      return `[${placeholder(spec.items ?? {})}, …]`;
    case 'object':
      return spec.properties?.['near'] !== undefined ? '<alias>.<side>' : '{json}';
    default:
      return 'value';
  }
}

/** `key=placeholder` entries of one param; object params expand to dotted keys. */
function entries(key: string, spec: ParamItemSpec, required: boolean): string[] {
  const wrap = (text: string): string => (required ? text : `[${text}]`);
  if (spec.type === 'object' && Object.keys(spec.properties ?? {}).length > 0 && spec.properties?.['near'] === undefined) {
    const requiredChildren = new Set(spec.required ?? []);
    return Object.entries(spec.properties ?? {}).flatMap(([child, childSpec]) =>
      entries(`${key}.${child}`, childSpec, required && requiredChildren.has(child)),
    );
  }
  return [wrap(`${key}=${placeholder(spec)}`)];
}

/** The `.lld` line of `name`, or null when no such command. */
export function commandSyntax(name: string): string | null {
  const def = getCommand(name);
  if (def === undefined) return null;
  const { properties, required } = def.paramsSchema;
  const params = Object.entries(properties).flatMap(([key, spec]) => entries(key, spec, required.includes(key)));
  if (def.annotations?.readOnly === true) return ['check', name, ...params, 'path=<data path> expect == <value>'].join(' ');
  return [`${name} <alias>`, ...params].join(' ');
}

/** @affects nothing — read-only; @failure unknown command -> DESIGN_UNKNOWN_COMMAND with close names */
export const describeDesignSyntax = defineCommand({
  name: 'describe_design_syntax',
  description:
    'The .lld design language: with no command, the one-page guide (statements, values, anchors, loops, checks, metrics); with command, ' +
    'its .lld line generated from its params (required keys bare, optional in [ ], object params as dotted keys), in the summary. data: { lines } or { command }.',
  params: z.object({
    command: z.string().optional().describe('Registered command to show as a .lld line, e.g. "add_hole". Omit for the language guide.'),
  }),
  annotations: { readOnly: true },
  run: (doc, { command }): CommandResult => {
    if (command === undefined) return report(doc, GUIDE, { lines: GUIDE.split('\n').length });
    const syntax = commandSyntax(command);
    if (syntax === null) {
      const near = similarNames(
        command,
        listCommands().map((c) => c.name),
      );
      return codedRejection(
        doc,
        'describe_design_syntax',
        'DESIGN_UNKNOWN_COMMAND',
        `unknown command "${command}"`,
        near.length > 0 ? `Did you mean ${near.join(', ')}?` : 'Find commands with `llull search <words>`.',
      );
    }
    return report(doc, syntax, { command });
  },
});
