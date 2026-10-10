/**
 * Unit tests for core/mcp prompts — `listMcpPrompts()` + `getMcpPrompt()`.
 *
 * All tests are pure: no network, no DOM, no SDK.
 * Pattern mirrors `tests/unit/mcp-tools.test.ts`.
 *
 * Regression suite: for each prompt that emits a build_project plan, the JSON
 * payload is extracted and run through `execute(..., 'build_project', { ...payload,
 * validate: true })`. This binds templates to the live registry so param renames
 * cannot silently rot them.
 */

import { describe, it, expect } from 'vitest';
import { listMcpPrompts, getMcpPrompt } from '@mcp/index';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

// ---------------------------------------------------------------------------
// listMcpPrompts
// ---------------------------------------------------------------------------

describe('listMcpPrompts()', () => {
  it('returns at least one prompt template', () => {
    expect(listMcpPrompts().length).toBeGreaterThanOrEqual(1);
  });

  it('returns exactly 6 registered templates', () => {
    expect(listMcpPrompts()).toHaveLength(6);
  });

  it('includes model_bracket', () => {
    const names = listMcpPrompts().map((p) => p.name);
    expect(names).toContain('model_bracket');
  });

  it('includes orthographic_setup', () => {
    const names = listMcpPrompts().map((p) => p.name);
    expect(names).toContain('orthographic_setup');
  });

  it('includes parametric_part', () => {
    const names = listMcpPrompts().map((p) => p.name);
    expect(names).toContain('parametric_part');
  });

  it('every template has a non-empty name and description', () => {
    for (const p of listMcpPrompts()) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('templates with arguments have non-empty argument names and descriptions', () => {
    for (const p of listMcpPrompts()) {
      if (p.arguments) {
        for (const arg of p.arguments) {
          expect(arg.name.length).toBeGreaterThan(0);
          expect(arg.description.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getMcpPrompt — unknown name
// ---------------------------------------------------------------------------

describe('getMcpPrompt() — unknown name', () => {
  it('returns null for an unregistered prompt name', () => {
    expect(getMcpPrompt('nonexistent_prompt')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(getMcpPrompt('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getMcpPrompt — model_bracket
// ---------------------------------------------------------------------------

describe('getMcpPrompt("model_bracket")', () => {
  it('returns a non-null result', () => {
    expect(
      getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' }),
    ).not.toBeNull();
  });

  it('result has a non-empty description', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    expect(result!.description.length).toBeGreaterThan(0);
  });

  it('result has at least two messages (user + assistant)', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    expect(result!.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('first message has role "user"', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    expect(result!.messages[0]!.role).toBe('user');
  });

  it('second message has role "assistant"', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    expect(result!.messages[1]!.role).toBe('assistant');
  });

  it('assistant message mentions build_project', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/build_project/);
  });

  it('assistant message mentions draw_rectangle', () => {
    const result = getMcpPrompt('model_bracket', { width: '100', height: '50', thickness: '8' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/draw_rectangle/);
  });

  it('assistant message mentions extrude_sketch', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/extrude_sketch/);
  });

  it('assistant message mentions boolean_subtract', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/boolean_subtract/);
  });

  it('assistant message mentions set_entity_name', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/set_entity_name/);
  });

  it('assistant message mentions describe_scene', () => {
    const result = getMcpPrompt('model_bracket', { width: '80', height: '40', thickness: '6' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/describe_scene/);
  });

  it('user message substitutes the provided width arg', () => {
    const result = getMcpPrompt('model_bracket', { width: '120', height: '60', thickness: '8' });
    const text = result!.messages[0]!.content.text;
    expect(text).toMatch(/120/);
  });

  it('uses default values when args are omitted', () => {
    const result = getMcpPrompt('model_bracket', {});
    expect(result).not.toBeNull();
    expect(result!.messages.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// getMcpPrompt — orthographic_setup
// ---------------------------------------------------------------------------

describe('getMcpPrompt("orthographic_setup")', () => {
  it('returns a non-null result for default view', () => {
    expect(getMcpPrompt('orthographic_setup', {})).not.toBeNull();
  });

  it('result has at least two messages', () => {
    const result = getMcpPrompt('orthographic_setup', { view: 'top' });
    expect(result!.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('assistant message mentions describe_scene', () => {
    const result = getMcpPrompt('orthographic_setup', { view: 'front' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/describe_scene/);
  });

  it('assistant message mentions find_entities', () => {
    const result = getMcpPrompt('orthographic_setup', { view: 'right' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/find_entities/);
  });

  it('assistant message reflects the requested view direction', () => {
    const result = getMcpPrompt('orthographic_setup', { view: 'front' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/FRONT/i);
  });

  it('assistant message for top view mentions +Z axis', () => {
    const result = getMcpPrompt('orthographic_setup', { view: 'top' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/\+Z/);
  });

  it('falls back gracefully for unknown view value', () => {
    const result = getMcpPrompt('orthographic_setup', { view: 'isometric' });
    expect(result).not.toBeNull();
    // Should fall back to top-view content
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/\+Z/);
  });
});

// ---------------------------------------------------------------------------
// getMcpPrompt — parametric_part
// ---------------------------------------------------------------------------

describe('getMcpPrompt("parametric_part")', () => {
  it('returns a non-null result', () => {
    expect(getMcpPrompt('parametric_part', { part_name: 'flange' })).not.toBeNull();
  });

  it('result has at least two messages', () => {
    const result = getMcpPrompt('parametric_part', { part_name: 'flange' });
    expect(result!.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('assistant message mentions build_project', () => {
    const result = getMcpPrompt('parametric_part', { part_name: 'bracket' });
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/build_project/);
  });

  it('assistant message mentions extrude_sketch', () => {
    const result = getMcpPrompt('parametric_part', {});
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/extrude_sketch/);
  });

  it('assistant message mentions boolean_subtract', () => {
    const result = getMcpPrompt('parametric_part', {});
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/boolean_subtract/);
  });

  it('assistant message mentions set_entity_name', () => {
    const result = getMcpPrompt('parametric_part', {});
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/set_entity_name/);
  });

  it('assistant message mentions $alias reference syntax', () => {
    const result = getMcpPrompt('parametric_part', {});
    const text = result!.messages[1]!.content.text;
    expect(text).toMatch(/\$alias|\$base_profile|\$body/);
  });

  it('user message substitutes the part_name arg', () => {
    const result = getMcpPrompt('parametric_part', { part_name: 'my_custom_part' });
    const text = result!.messages[0]!.content.text;
    expect(text).toMatch(/my_custom_part/);
  });

  it('uses default part_name when arg is omitted', () => {
    const result = getMcpPrompt('parametric_part', {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toMatch(/my_part/);
  });
});

// ---------------------------------------------------------------------------
// Content type invariants
// ---------------------------------------------------------------------------

describe('getMcpPrompt() — content type invariants', () => {
  const templateNames = ['model_bracket', 'orthographic_setup', 'parametric_part'];

  for (const name of templateNames) {
    it(`${name}: every message content has type "text"`, () => {
      const result = getMcpPrompt(name, {});
      for (const msg of result!.messages) {
        expect(msg.content.type).toBe('text');
        expect(typeof msg.content.text).toBe('string');
        expect(msg.content.text.length).toBeGreaterThan(0);
      }
    });

    it(`${name}: every message has role "user" or "assistant"`, () => {
      const result = getMcpPrompt(name, {});
      for (const msg of result!.messages) {
        expect(['user', 'assistant']).toContain(msg.role);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// build_project validate regression — binds prompt templates to live registry
// ---------------------------------------------------------------------------
//
// For each prompt that emits a ```json fenced build_project plan, we:
//   1. Extract the JSON block from the assistant message text.
//   2. Parse it.
//   3. Run it through execute(..., 'build_project', { ...payload, validate: true }).
//   4. Assert data.ok === true (no unknown commands, missing required params, or
//      broken $alias refs).
//
// validate:true never mutates the document; it only checks names/params/aliases.
// A param rename in any command will immediately fail this suite.
// ---------------------------------------------------------------------------

/** Extract the first ```json ... ``` block from a string and parse it. */
function extractJsonBlock(text: string): unknown {
  const match = /```json\s*([\s\S]*?)```/.exec(text);
  if (!match || match[1] === undefined)
    throw new Error('No ```json block found in assistant message');
  // Strip JS-style line comments (// ...) before parsing — templates may include them.
  const stripped = match[1].replace(/\/\/[^\n]*/g, '');
  return JSON.parse(stripped) as unknown;
}

function expectPromptPlanValidates(promptName: string, args: Record<string, string>): void {
  const result = getMcpPrompt(promptName, args);
  expect(result).not.toBeNull();

  const assistantText = result!.messages.find((m) => m.role === 'assistant')!.content.text;
  const payload = extractJsonBlock(assistantText) as Record<string, unknown>;

  const cmdResult = execute(createEmptyDocument(), 'build_project', { ...payload, validate: true });

  // data.ok is the authoritative field (see BuildProjectData in project.ts)
  const data = cmdResult.data as { ok: boolean; issues?: string[] } | undefined;
  expect(data).toBeDefined();
  if (data && !data.ok) {
    throw new Error(`${promptName} plan validation failed: ${JSON.stringify(data.issues)}`);
  }
  expect(data!.ok).toBe(true);
}

describe('build_project validate regression — model_bracket', () => {
  it.each([2, 1, 4])('emitted plan passes build_project validate:true for hole_count=%i', (n) => {
    const dims = { 1: ['60', '30', '5'], 2: ['80', '40', '6'], 4: ['120', '50', '8'] }[n]!;
    expectPromptPlanValidates('model_bracket', {
      width: dims[0]!,
      height: dims[1]!,
      thickness: dims[2]!,
      hole_count: String(n),
    });
  });
});

describe('build_project validate regression — parametric_part', () => {
  it.each([
    ['default part_name', {}],
    ['a custom part_name', { part_name: 'flange_plate' }],
  ])('emitted plan passes build_project validate:true (%s)', (_label, args) => {
    expectPromptPlanValidates('parametric_part', args);
  });
});

describe('design_building prompt', () => {
  it('walks through the construction workflow and names only registered commands', async () => {
    const { getCommand } = await import('@core/commands/registry');
    const result = getMcpPrompt('design_building', { brief: 'a small office' });
    expect(result!.messages[0]!.content.text).toContain('a small office');
    const text = result!.messages[1]!.content.text;
    const named = [...text.matchAll(/`([a-z_]+)`/g)].map((match) => match[1] as string);
    expect(named.length).toBeGreaterThan(15);
    for (const name of named) expect(getCommand(name), name).toBeDefined();
  });
});

describe('design_factory prompt', () => {
  it('walks through the industrial workflow and names only registered commands', async () => {
    const { getCommand } = await import('@core/commands/registry');
    const result = getMcpPrompt('design_factory', { brief: 'a 30 m hall' });
    expect(result!.messages[0]!.content.text).toContain('a 30 m hall');
    const text = result!.messages[1]!.content.text;
    const named = [...text.matchAll(/`([a-z_]+)`/g)].map((match) => match[1] as string);
    expect(named).toContain('add_portal_frame_building');
    expect(named).toContain('check_clashes');
    for (const name of named) expect(getCommand(name), name).toBeDefined();
  });
});

describe('design_site prompt', () => {
  it('walks through the civil workflow and names only registered commands', async () => {
    const { getCommand } = await import('@core/commands/registry');
    const result = getMcpPrompt('design_site', { brief: 'a depot yard' });
    expect(result!.messages[0]!.content.text).toContain('a depot yard');
    const text = result!.messages[1]!.content.text;
    const named = [...text.matchAll(/`([a-z_]+)`/g)].map((match) => match[1] as string);
    expect(named).toContain('balance_platform');
    expect(named).toContain('export_landxml');
    for (const name of named) expect(getCommand(name), name).toBeDefined();
  });
});
