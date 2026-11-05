import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { guardCommand } from '@core/commands/guard';
import { execute, listCommands } from '@core/commands/registry';
import { defineCommand, tolerant, z } from '@core/commands/schema';
import type { CadDocument } from '@core/model/types';
import type { CommandResult, ParamItemSpec } from '@core/commands/types';
import { noop } from '@core/commands/noop';

/** Minimal valid-looking value of a JSON-Schema-like spec (required keys only); the schema parse decides whether it is accepted. */
function sampleValue(spec: ParamItemSpec): unknown {
  if (spec.enum !== undefined) return spec.enum[0];
  if (spec.anyOf !== undefined) return spec.anyOf[0] === undefined ? undefined : sampleValue(spec.anyOf[0]);
  switch (spec.type) {
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return spec.items?.type === 'number' ? [1, 1, 1] : spec.items === undefined ? [] : [sampleValue(spec.items)];
    case 'object': {
      if (spec.additionalProperties !== undefined) return {};
      const out: Record<string, unknown> = {};
      for (const key of spec.required ?? []) {
        const child = spec.properties?.[key];
        if (child !== undefined) out[key] = sampleValue(child);
      }
      return out;
    }
    default:
      return ' x ';
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Paths of keys present in `raw` that the schema does not declare AND that are missing from `kept` (zod stripped them: a run reading them sees undefined). */
function strippedUndeclared(raw: unknown, kept: unknown, spec: ParamItemSpec | undefined, path = ''): string[] {
  if (!isPlainObject(raw)) return [];
  const keptObject = isPlainObject(kept) ? kept : {};
  const out: string[] = [];
  for (const key of Object.keys(raw)) {
    const child = spec?.properties?.[key];
    if (!(key in keptObject) && child === undefined && spec?.additionalProperties === undefined) out.push(`${path}${key}`);
    else out.push(...strippedUndeclared(raw[key], keptObject[key], child ?? spec?.additionalProperties, `${path}${key}.`));
  }
  return out;
}

/** One level deep: every optional object parameter that lists its properties gets a sample of each of them. */
function withOptionalObjects(
  input: Record<string, unknown>,
  properties: Record<string, ParamItemSpec>,
  required: readonly string[],
): Record<string, unknown> {
  const out = { ...input };
  for (const [key, spec] of Object.entries(properties)) {
    if (required.includes(key) || spec.type !== 'object' || spec.properties === undefined || spec.additionalProperties !== undefined)
      continue;
    out[key] = Object.fromEntries(Object.entries(spec.properties).map(([name, child]) => [name, sampleValue(child)]));
  }
  return out;
}

describe('parsed params reach run (FR-INT-01)', () => {
  it('VC-INT-01: run receives defaults and trims applied', () => {
    let seen: unknown;
    const probe = defineCommand({
      name: 'parsed_params_probe',
      description: 'Test-only probe that records the params its run receives.',
      params: z.object({
        a: z.string().trim().describe('A string that is trimmed.'),
        b: z.number().default(7).describe('A number that defaults to 7.'),
      }),
      run: (doc: CadDocument, params): CommandResult => {
        seen = params;
        return noop(doc, 'probe');
      },
    });
    guardCommand(probe as never).run(createEmptyDocument(), { a: '  x ' });
    expect(seen).toEqual({ a: 'x', b: 7 });
  });

  it('a tolerant param reaches run with its raw invalid value, not undefined', () => {
    let seen: unknown;
    const probe = defineCommand({
      name: 'tolerant_params_probe',
      description: 'Test-only probe that records a tolerant param.',
      params: z.object({ family: tolerant(z.enum(['HEA']).optional().describe('A family.')) }),
      run: (doc: CadDocument, params): CommandResult => {
        seen = params.family;
        return noop(doc, 'probe');
      },
    });
    const guarded = guardCommand(probe as never);
    guarded.run(createEmptyDocument(), { family: 'hea' });
    expect(seen).toBe('hea');
    guarded.run(createEmptyDocument(), { family: 3 });
    expect(seen).toBe(3);
  });

  it('a nested own __proto__ key is refused before validation drops it', () => {
    const result = execute(createEmptyDocument(), 'list_steel_profiles', JSON.parse('{"family":"HEA","extra":{"__proto__":"x"}}'));
    expect(result.error?.code).toBe('CMD_RESERVED_ID');
    expect(result.error?.paths).toEqual(['extra']);
  });

  const nest = (levels: number, leaf: string): string => '{"k":'.repeat(levels) + leaf + '}'.repeat(levels);

  it('a __proto__ key deeper than 8 levels is still refused', () => {
    const result = execute(
      createEmptyDocument(),
      'list_steel_profiles',
      JSON.parse('{"family":"HEA","extra":' + nest(12, '{"__proto__":1}') + '}'),
    );
    expect(result.error?.code).toBe('CMD_RESERVED_ID');
    expect(result.error?.paths).toEqual(['extra' + '.k'.repeat(12)]);
  });

  it('a __proto__ key inside an array element is refused with the element index in the path', () => {
    const result = execute(createEmptyDocument(), 'list_steel_profiles', JSON.parse('{"family":"HEA","extra":[1,2,{"__proto__":1}]}'));
    expect(result.error?.code).toBe('CMD_RESERVED_ID');
    expect(result.error?.paths).toEqual(['extra.2']);
  });

  it('params nested beyond the walk cap are refused (CMD_INVALID_PARAMS, nested too deeply), never walked past silently', () => {
    const result = execute(createEmptyDocument(), 'list_steel_profiles', JSON.parse('{"family":"HEA","extra":' + nest(80, '1') + '}'));
    expect(result.error?.code).toBe('CMD_INVALID_PARAMS');
    expect(result.summary).toContain('params nested too deeply');
    expect(result.document.entities).toEqual({});
  });

  it('params nested 40 levels (below the cap) are not refused for depth', () => {
    const result = execute(createEmptyDocument(), 'list_steel_profiles', JSON.parse('{"family":"HEA","extra":' + nest(40, '1') + '}'));
    expect(result.summary).not.toContain('nested too deeply');
  });

  it('VC-INT-02: for every registered command whose sample input validates, run sees exactly the parsed value and no raw key is silently stripped', () => {
    const doc = createEmptyDocument();
    let checked = 0;
    let differing = 0;
    let nestedSamples = 0;
    const stripped: string[] = [];
    for (const command of listCommands()) {
      if (command.paramsValidator === undefined) continue;
      const minimal: Record<string, unknown> = {};
      for (const key of command.paramsSchema.required) {
        const spec = command.paramsSchema.properties[key];
        if (spec !== undefined) minimal[key] = sampleValue(spec);
      }
      const rich = withOptionalObjects(minimal, command.paramsSchema.properties, command.paramsSchema.required);
      const pad = (input: Record<string, unknown>): Record<string, unknown> =>
        Array.isArray(input['position']) && input['position'].length === 2 ? { ...input, position: [...input['position'], 0] } : input;
      const richParsed = command.paramsValidator.safeParse(pad(rich));
      const input = richParsed.success ? rich : minimal;
      const padded = pad(input);
      const parsed = richParsed.success ? richParsed : command.paramsValidator.safeParse(padded);
      if (!parsed.success) continue;
      if (input === rich && Object.keys(rich).length > Object.keys(minimal).length) nestedSamples += 1;
      let seen: unknown;
      const spy = guardCommand({
        ...command,
        run: (document, params): CommandResult => {
          seen = params;
          return noop(document, 'spy');
        },
      });
      spy.run(doc, input);
      expect(seen, command.name).toEqual(parsed.data);
      stripped.push(...strippedUndeclared(padded, parsed.data, command.paramsSchema).map((path) => command.name + ':' + path));
      checked += 1;
      if (JSON.stringify(parsed.data) !== JSON.stringify(padded)) differing += 1;
    }
    expect(stripped).toEqual([]);
    expect(checked).toBeGreaterThan(150);
    expect(nestedSamples).toBeGreaterThan(0);
    expect(differing).toBeGreaterThan(0);
  });

  it('VC-INT-02 mutation proof: a nested z.object key the schema does not declare is stripped by the parse and the sweep reports it', () => {
    const probe = defineCommand({
      name: 'nested_undeclared_probe',
      description: 'Test-only probe whose run reads an undeclared nested key.',
      params: z.object({
        box: z
          .object({ width: z.number().describe('Width.') })
          .optional()
          .describe('A nested box.'),
      }),
      run: (doc: CadDocument): CommandResult => noop(doc, 'probe'),
    });
    const raw = { box: { width: 2, depth: 3 } };
    const parsed = probe.paramsValidator?.safeParse(raw);
    expect(parsed?.success).toBe(true);
    expect(strippedUndeclared(raw, parsed?.success ? parsed.data : undefined, probe.paramsSchema)).toEqual(['box.depth']);
    expect(strippedUndeclared({ box: { width: 2 } }, { box: { width: 2 } }, probe.paramsSchema)).toEqual([]);
  });
});
