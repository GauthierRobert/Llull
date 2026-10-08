/**
 * Drift guard: every tool, parameter and plan step that MCP prompts and resources mention must
 * exist in the current registry, so renaming a command or param fails here instead of silently
 * misleading agents.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAllMcpTools,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  readMcpResource,
  SERVER_INSTRUCTIONS,
} from '@mcp/index';
import { CONVENTIONS_GUIDE } from '@mcp/conventions';
import { createEmptyDocument } from '@core/model/types';

const tools = buildAllMcpTools();
const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

function propertyNames(toolName: string): Set<string> {
  const schema = toolByName.get(toolName)?.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  return new Set(Object.keys(schema?.properties ?? {}));
}

/** Prompt text with every argument filled by a plausible sample value. */
function promptTexts(): Array<{ prompt: string; text: string }> {
  return listMcpPrompts().map((descriptor) => {
    const args: Record<string, string> = {};
    for (const argument of descriptor.arguments ?? []) {
      args[argument.name] =
        argument.name === 'view' ? 'top' : argument.name === 'brief' ? 'a hall' : '10';
    }
    const result = getMcpPrompt(descriptor.name, args);
    return {
      prompt: descriptor.name,
      text: (result?.messages ?? []).map((message) => message.content.text).join('\n'),
    };
  });
}

interface PlanStep {
  command?: string;
  params?: Record<string, unknown>;
  step?: PlanStep;
}

function jsonBlocks(text: string): unknown[] {
  // Plans may carry `// comment` lines; a comment marker follows whitespace, a URL's does not.
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) =>
    JSON.parse((match[1] ?? 'null').replace(/(^|\s)\/\/.*$/gm, '')),
  );
}

function stepsOf(plan: unknown): PlanStep[] {
  const actions = (plan as { actions?: unknown[] } | null)?.actions ?? [];
  return actions.flatMap((action) => {
    const step = action as PlanStep;
    return step.step !== undefined ? [step.step] : [step];
  });
}

describe('prompt plans', () => {
  it('has prompts to check', () => {
    expect(promptTexts().length).toBeGreaterThan(0);
  });

  it('every plan step names a real command and only parameters it declares', () => {
    const problems: string[] = [];
    for (const { prompt, text } of promptTexts()) {
      for (const plan of jsonBlocks(text)) {
        for (const step of stepsOf(plan)) {
          if (step.command === undefined) continue;
          if (!toolByName.has(step.command)) {
            problems.push(`${prompt}: unknown command ${step.command}`);
            continue;
          }
          const known = propertyNames(step.command);
          for (const key of Object.keys(step.params ?? {})) {
            if (!known.has(key)) problems.push(`${prompt}: ${step.command} has no param "${key}"`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('a JSON example shown for a tool call uses only that tool’s parameters', () => {
    const problems: string[] = [];
    for (const { prompt, text } of promptTexts()) {
      for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
        const before = text.slice(0, match.index);
        const mentioned = [...before.matchAll(/`([a-z_]+)`/g)]
          .map((found) => found[1] ?? '')
          .filter((name) => toolByName.has(name));
        const tool = mentioned.at(-1);
        const example = JSON.parse((match[1] ?? '{}').replace(/(^|\s)\/\/.*$/gm, '')) as unknown;
        if (tool === undefined || typeof example !== 'object' || example === null) continue;
        const known = propertyNames(tool);
        for (const key of Object.keys(example)) {
          if (!known.has(key)) problems.push(`${prompt}: example for ${tool} uses "${key}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

/** Words that are legitimately backticked but are neither tools nor parameters. */
const PLAN_VOCABULARY = new Set([
  'actions',
  'onError',
  'validate',
  'as',
  'command',
  'params',
  'step',
  // fields of command results and of the scene snapshot that prompts explain
  'affected',
  'summary',
  'data',
  'SceneSnapshot',
  'bounds',
  'entities',
  'entityCount',
]);

function vocabulary(): Set<string> {
  const words = new Set<string>([...toolByName.keys(), ...PLAN_VOCABULARY]);
  for (const tool of tools) propertyNames(tool.name).forEach((name) => words.add(name));
  for (const descriptor of listMcpPrompts()) {
    for (const argument of descriptor.arguments ?? []) words.add(argument.name);
  }
  return words;
}

function backtickedIdentifiers(text: string): string[] {
  return [...text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((match) => match[1] ?? '');
}

describe('backticked names in prose', () => {
  it('prompt text mentions only real tools and parameters', () => {
    const known = vocabulary();
    const stale = promptTexts().flatMap(({ prompt, text }) =>
      backtickedIdentifiers(text)
        .filter((word) => !known.has(word))
        .map((word) => `${prompt}: ${word}`),
    );
    expect([...new Set(stale)]).toEqual([]);
  });

  it('the conventions guide mentions only real tools and parameters (or document fields)', () => {
    const known = vocabulary();
    // Document-level fields and literals the guide explains, which are not command parameters.
    const documentWords = new Set(['units', 'mm', 'cm', 'm', 'in', 'ft', 'rotation', 'position']);
    const stale = backtickedIdentifiers(CONVENTIONS_GUIDE).filter(
      (word) => !known.has(word) && !documentWords.has(word),
    );
    expect([...new Set(stale)]).toEqual([]);
  });

  it('the server instructions mention only real tools, parameters and resources', () => {
    const known = vocabulary();
    const stale = backtickedIdentifiers(SERVER_INSTRUCTIONS).filter(
      (word) => !known.has(word) && !['structuredContent'].includes(word),
    );
    expect(stale).toEqual([]);
    const uris = new Set(listMcpResources().map((resource) => resource.uri));
    const mentioned = [...SERVER_INSTRUCTIONS.matchAll(/`(cad:\/\/[a-z]+)`/g)].map((m) => m[1]);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const uri of mentioned) expect(uris.has(uri ?? ''), uri).toBe(true);
  });

  it('the scene resource exposes the snapshot fields prompts tell agents to read', () => {
    const scene = readMcpResource(createEmptyDocument(), 'cad://scene');
    const snapshot = JSON.parse(scene?.text ?? '{}') as Record<string, unknown>;
    for (const field of ['bounds', 'entities', 'entityCount']) {
      expect(Object.keys(snapshot), field).toContain(field);
    }
  });
});
