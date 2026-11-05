import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { guardCommand } from '@core/commands/guard';
import { listCommands } from '@core/commands/registry';
import { defineCommand, z } from '@core/commands/schema';
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

  it('VC-INT-02: for every registered command whose minimal input validates, run sees exactly the parsed value', () => {
    const doc = createEmptyDocument();
    let checked = 0;
    let differing = 0;
    for (const command of listCommands()) {
      if (command.paramsValidator === undefined) continue;
      const input: Record<string, unknown> = {};
      for (const key of command.paramsSchema.required) {
        const spec = command.paramsSchema.properties[key];
        if (spec !== undefined) input[key] = sampleValue(spec);
      }
      const padded =
        Array.isArray(input['position']) && input['position'].length === 2 ? { ...input, position: [...input['position'], 0] } : input;
      const parsed = command.paramsValidator.safeParse(padded);
      if (!parsed.success) continue;
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
      checked += 1;
      if (JSON.stringify(parsed.data) !== JSON.stringify(padded)) differing += 1;
    }
    expect(checked).toBeGreaterThan(150);
    expect(differing).toBeGreaterThan(0);
  });
});
