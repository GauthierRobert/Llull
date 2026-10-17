import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { listCommands, getCommand, execute } from '@core/commands/registry';
import {
  buildMcpTools,
  listMcpResources,
  readMcpResource,
  CAD_RESOURCE_URIS,
  applyDiscoveryToolCall,
  buildDiscoveryToolDefinitions,
  closestToolNames,
  parseToolsets,
  searchTools,
  toolsetOf,
  TOOLSET_NAMES,
  buildAllMcpTools,
  getMcpPrompt,
  listMcpPrompts,
  SERVER_INSTRUCTIONS,
  TOOLSETS,
  buildExchangeToolDefinitions,
  buildFeaToolDefinitions,
  isPromptEnabled,
  isToolEnabled,
  type ToolSearchResult,
  type ToolsetName,
} from '@mcp/index';
import { applyToolCall } from '../helpers/applyToolCall';
import { expectDocumentEnvelope } from '../helpers/documentEnvelope';
import { expectPure } from '../helpers/expectNoOp';
import { MAX_RESOURCE_ITEMS } from '@mcp/resources';
import { boxRowPlan } from '../helpers/boxRowPlan';
import { CONVENTIONS_GUIDE } from '@mcp/conventions';

describe('buildMcpTools()', () => {
  it('one MCP-shaped tool per command, in registry order', () => {
    const tools = buildMcpTools();
    expect(tools.map((t) => t.name)).toEqual(listCommands().map((c) => c.name));
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect('input_schema' in tool).toBe(false);
    }
  });
});

describe('applyToolCall()', () => {
  it('runs a known command: new document, affected ids, summary + affected content blocks', () => {
    const doc = createEmptyDocument();
    const r = applyToolCall(doc, 'add_box', { size: [2, 2, 2] });
    expect(r.isError).toBe(false);
    expect(r.document).not.toBe(doc);
    expect(r.document.order).toEqual(r.affected);
    expect(r.document.entities[r.affected[0]!]!.kind).toBe('box');
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/box/i) });
    expect(r.content[1]!.text).toMatch(/Affected entity ids:/);
    expectPure(doc, () => applyToolCall(doc, 'add_box', { size: [3, 3, 3] }));
  });

  it('reports an unknown tool as an error, unchanged and purely', () => {
    const doc = createEmptyDocument();
    const r = applyToolCall(doc, 'nonexistent_tool', {});
    expect([r.isError, r.document, r.affected]).toEqual([true, doc, []]);
    expect(r.content[0]!.text).toMatch(/unknown command/i);
    expectPure(doc, () => applyToolCall(doc, 'unknown_xyz', {}));
  });
});

describe('MCP resources', () => {
  const json = (doc: CadDocument, uri: string): Record<string, unknown> =>
    JSON.parse(readMcpResource(doc, uri)!.text) as Record<string, unknown>;

  it('lists document, scene, selection (JSON) and conventions (markdown)', () => {
    expect(CAD_RESOURCE_URIS).toMatchObject({
      document: 'cad://document',
      scene: 'cad://scene',
      selection: 'cad://selection',
      conventions: 'cad://conventions',
    });
    const resources = listMcpResources();
    expect(Object.fromEntries(resources.map((r) => [r.uri, r.mimeType]))).toEqual({
      'cad://document': 'application/json',
      'cad://scene': 'application/json',
      'cad://selection': 'application/json',
      'cad://conventions': 'text/markdown',
    });
    for (const r of resources) expect(r.name.length * r.description.length).toBeGreaterThan(0);
  });

  it.each(['cad://document', 'cad://scene', 'cad://selection'])('%s reads purely, echoing its uri', (uri) => {
    const doc = createEmptyDocument();
    expect(readMcpResource(doc, uri)!.uri).toBe(uri);
    expectPure(doc, () => readMcpResource(doc, uri));
  });

  it('serves the envelope, scene counts and selection; unknown URIs are null', () => {
    const doc = createEmptyDocument();
    expectDocumentEnvelope(json(doc, 'cad://document'));
    const scene = json(doc, 'cad://scene');
    expect([scene['entityCount'], Array.isArray(scene['entities']), Array.isArray(scene['layers'])]).toEqual([0, true, true]);
    expect(json(applyToolCall(doc, 'add_box', { size: [1, 1, 1] }).document, 'cad://scene')['entityCount']).toBe(1);
    expect(json(doc, 'cad://selection')).toMatchObject({ count: 0, entities: [] });
    for (const uri of ['cad://unknown', 'http://example.com', '']) expect(readMcpResource(doc, uri)).toBeNull();
  });
});

const coreOnly = (): Set<ToolsetName> => new Set(parseToolsets('').enabled);

function searchData(args: unknown): ToolSearchResult[] {
  const outcome = applyDiscoveryToolCall('search_tools', args, coreOnly());
  return (outcome?.result.structuredContent as { results: ToolSearchResult[] }).results;
}

describe('discovery tool definitions', () => {
  it('are core tools and not registry commands', () => {
    for (const { name } of buildDiscoveryToolDefinitions()) {
      expect(toolsetOf(name)).toBe('core');
      expect(getCommand(name)).toBeUndefined();
    }
  });
});

describe('search_tools summary hint', () => {
  it('points at enable_toolset only when some result is in a disabled toolset', () => {
    const everything = new Set<ToolsetName>(parseToolsets('all').enabled);
    const open = applyDiscoveryToolCall('search_tools', { query: 'wall' }, everything);
    expect(open?.result.content[0]?.text).not.toContain('Call enable_toolset');
    const limited = applyDiscoveryToolCall('search_tools', { query: 'wall' }, coreOnly());
    expect(limited?.result.content[0]?.text).toContain('Call enable_toolset for: building');
  });
});

describe('search_tools on natural phrasing', () => {
  const top = (query: string, count = 3): string[] => searchTools(query, count, new Set(parseToolsets('all').enabled)).map((r) => r.name);
  it.each([
    ['cut a hole', 'boolean'],
    ['make a hole in a plate', 'boolean'],
    ['round the edges', 'fillet_edge'],
    ['bevel the edges', 'chamfer_edge'],
    ['how heavy is it', 'mass_properties'],
    ['take a picture', 'render_view'],
    ['copy an entity many times in a row', 'duplicate_entities'],
    ['export to STEP', 'export_step'],
    ['measure distance between two points', 'measure_distance'],
  ])('"%s" finds %s in the top results', (query, expected) => {
    expect(top(query, 4)).toContain(expected);
  });
  it('ignores stopwords and one-letter words, so filler cannot match tools', () => {
    expect(top('a the of to')).toEqual([]);
    expect(top('a')).toEqual([]);
  });
  it('is plural-insensitive', () => {
    expect(top('fillets')).toEqual(top('fillet'));
    expect(top('edges')[0]).toBe(top('edge')[0]);
  });
});

describe('search_tools', () => {
  it('ranks name matches first and reports toolset + enabled', () => {
    const results = searchTools('wall', 5, coreOnly());
    expect(results[0]?.name).toMatch(/wall/);
    const wall = results.find((r) => r.name === 'draw_walls');
    expect(wall).toMatchObject({ toolset: 'building', enabled: false });
    expect(wall?.description.length).toBeGreaterThan(0);
  });
  it('covers exchange tools and marks enabled state from the session set', () => {
    const exchange = searchTools('export step', 5, coreOnly()).find((r) => r.name === 'export_step');
    expect(exchange).toMatchObject({ toolset: 'exchange', enabled: false });
    const all = new Set(TOOLSET_NAMES);
    expect(searchTools('export step', 5, all).find((r) => r.name === 'export_step')?.enabled).toBe(true);
  });
  it('finds the discovery tools themselves as enabled core tools', () => {
    expect(searchTools('enable toolset', 3, coreOnly())[0]).toMatchObject({ name: 'enable_toolset', toolset: 'core', enabled: true });
  });
  it('honours limit (default 10, clamped) and returns nothing for unmatched queries', () => {
    expect(searchTools('add', 3, coreOnly())).toHaveLength(3);
    expect(searchData({ query: 'add' })).toHaveLength(10);
    expect(searchData({ query: 'add', limit: 0 })).toHaveLength(1);
    expect(searchData({ query: 'add', limit: 9999 }).length).toBeLessThanOrEqual(50);
    expect(searchTools('zzzqqq', 5, coreOnly())).toEqual([]);
    expect(searchTools('!!!', 5, coreOnly())).toEqual([]);
  });
  it('summary lists names and points disabled tools at enable_toolset', () => {
    const outcome = applyDiscoveryToolCall('search_tools', { query: 'wall' }, coreOnly());
    const summary = outcome?.result.content[0]?.text ?? '';
    expect(summary).toContain('draw_walls');
    expect(summary).toContain('enable_toolset');
    expect(outcome?.toolsListChanged).toBe(false);
  });
  it('reports no matches and rejects an empty query', () => {
    const none = applyDiscoveryToolCall('search_tools', { query: 'zzzqqq' }, coreOnly());
    expect(none?.result.isError).toBe(false);
    expect(none?.result.content[0]?.text).toContain('no tools match');
    for (const args of [{}, { query: '  ' }, { query: 5 }, null]) {
      expect(applyDiscoveryToolCall('search_tools', args, coreOnly())?.result.isError).toBe(true);
    }
  });
});

describe('closestToolNames', () => {
  it('finds the intended tool for a typo, closest first', () => {
    expect(closestToolNames('add_boxx', 3)[0]).toBe('add_box');
    expect(closestToolNames('Boolen', 3)).toContain('boolean');
    expect(closestToolNames('add_box', 3)[0]).toBe('add_box');
  });
  it('returns nothing when no tool name is close', () => {
    expect(closestToolNames('make_me_a_sandwich_please', 5)).toEqual([]);
  });
  it('respects the limit', () => {
    expect(closestToolNames('add_boxx', 1)).toHaveLength(1);
  });
});

describe('enable_toolset', () => {
  it('adds the toolset to the session set and flags a tools list change', () => {
    const enabled = coreOnly();
    const outcome = applyDiscoveryToolCall('enable_toolset', { toolset: ' Building ' }, enabled);
    expect(outcome?.result.isError).toBe(false);
    expect(outcome?.toolsListChanged).toBe(true);
    expect(enabled.has('building')).toBe(true);
  });
  it('is idempotent: re-enabling reports no change', () => {
    const enabled = coreOnly();
    applyDiscoveryToolCall('enable_toolset', { toolset: '3d' }, enabled);
    const again = applyDiscoveryToolCall('enable_toolset', { toolset: '3d' }, enabled);
    expect(again?.toolsListChanged).toBe(false);
    expect(again?.result.content[0]?.text).toContain('already enabled');
  });
  it('unknown toolset is an error listing the valid names and changes nothing', () => {
    const enabled = coreOnly();
    for (const args of [{ toolset: 'bogus' }, {}]) {
      const outcome = applyDiscoveryToolCall('enable_toolset', args, enabled);
      expect(outcome?.result.isError).toBe(true);
      expect(outcome?.toolsListChanged).toBe(false);
      for (const name of TOOLSET_NAMES) expect(outcome?.result.content[0]?.text).toContain(name);
    }
    expect([...enabled]).toEqual(['core']);
  });
  it('"all" enables every toolset once, then reports no change', () => {
    const enabled = coreOnly();
    const first = applyDiscoveryToolCall('enable_toolset', { toolset: 'ALL' }, enabled);
    expect(first?.result.isError).toBe(false);
    expect(first?.toolsListChanged).toBe(true);
    expect([...enabled].sort()).toEqual([...TOOLSET_NAMES].sort());
    const again = applyDiscoveryToolCall('enable_toolset', { toolset: 'all' }, enabled);
    expect(again?.toolsListChanged).toBe(false);
    expect(again?.result.content[0]?.text).toContain('already enabled');
  });
  it('a missing toolset argument says so instead of quoting an empty name', () => {
    const outcome = applyDiscoveryToolCall('enable_toolset', {}, coreOnly());
    expect(outcome?.result.content[0]?.text).toContain('a "toolset" string argument');
  });
  it('returns null for any other tool name', () => {
    expect(applyDiscoveryToolCall('add_box', {}, coreOnly())).toBeNull();
  });
});

function documentWithBoxes(count: number): CadDocument {
  return execute(createEmptyDocument(), 'build_project', boxRowPlan(count)).document;
}

const read = (doc: CadDocument, uri: string): Record<string, unknown> =>
  JSON.parse(readMcpResource(doc, uri)?.text ?? '{}') as Record<string, unknown>;

describe('cad://scene and cad://selection size limits', () => {
  it('returns small models complete, without a truncation note', () => {
    const scene = read(documentWithBoxes(5), 'cad://scene');
    expect(scene['entityCount']).toBe(5);
    expect(scene['entities']).toHaveLength(5);
    expect(scene).not.toHaveProperty('truncated');
  });
  it('cuts the entity list of a large model and says how much was cut', () => {
    const total = MAX_RESOURCE_ITEMS + 120;
    const scene = read(documentWithBoxes(total), 'cad://scene');
    expect(scene['entityCount']).toBe(total);
    expect(scene['entities']).toHaveLength(MAX_RESOURCE_ITEMS);
    expect(scene['truncated']).toMatchObject({ entityCount: total, entitiesShown: MAX_RESOURCE_ITEMS });
    expect(JSON.stringify(scene['truncated'])).toContain('cad://document');
    expect(scene['bounds']).not.toBeNull(); // whole-model facts stay exact
  });
  it('lists at most the cap of selected entities but reports the true count', () => {
    const total = MAX_RESOURCE_ITEMS + 50;
    const doc = documentWithBoxes(total);
    const selected = { ...doc, selection: doc.order };
    const selection = read(selected, 'cad://selection');
    expect(selection['count']).toBe(total);
    expect(selection['entities']).toHaveLength(MAX_RESOURCE_ITEMS);
  });
  it('serves the conventions guide as markdown and rejects unknown URIs', () => {
    const guide = readMcpResource(createEmptyDocument(), 'cad://conventions');
    expect(guide?.mimeType).toBe('text/markdown');
    expect(guide?.text).toContain('Agent Modeling Conventions');
    expect(readMcpResource(createEmptyDocument(), 'cad://nope')).toBeNull();
  });
  it('cad://document stays complete for reloading the whole model', () => {
    const doc = documentWithBoxes(MAX_RESOURCE_ITEMS + 20);
    const envelope = read(doc, 'cad://document') as { document: { order: string[] } };
    expect(envelope.document.order).toHaveLength(MAX_RESOURCE_ITEMS + 20);
  });
});

const tools = buildAllMcpTools();
const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

function propertyNames(toolName: string): Set<string> {
  const schema = toolByName.get(toolName)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return new Set(Object.keys(schema?.properties ?? {}));
}

/** Prompt text with every argument filled by a plausible sample value. */
function promptTexts(): Array<{ prompt: string; text: string }> {
  return listMcpPrompts().map((descriptor) => {
    const args: Record<string, string> = {};
    for (const argument of descriptor.arguments ?? []) {
      args[argument.name] = argument.name === 'view' ? 'top' : argument.name === 'brief' ? 'a hall' : '10';
    }
    const result = getMcpPrompt(descriptor.name, args);
    return { prompt: descriptor.name, text: (result?.messages ?? []).map((message) => message.content.text).join('\n') };
  });
}

interface PlanStep {
  command?: string;
  params?: Record<string, unknown>;
  step?: PlanStep;
}

function jsonBlocks(text: string): unknown[] {
  // Plans may carry `// comment` lines; a comment marker follows whitespace, a URL's does not.
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse((match[1] ?? 'null').replace(/(^|\s)\/\/.*$/gm, '')));
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
        const mentioned = [...before.matchAll(/`([a-z_]+)`/g)].map((found) => found[1] ?? '').filter((name) => toolByName.has(name));
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
    const stale = backtickedIdentifiers(CONVENTIONS_GUIDE).filter((word) => !known.has(word) && !documentWords.has(word));
    expect([...new Set(stale)]).toEqual([]);
  });
  it('the server instructions mention only real tools, parameters and resources', () => {
    const known = vocabulary();
    const stale = backtickedIdentifiers(SERVER_INSTRUCTIONS).filter((word) => !known.has(word) && !['structuredContent'].includes(word));
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

const allToolNames = [
  ...listCommands().map((command) => command.name),
  ...buildExchangeToolDefinitions().map((tool) => tool.name),
  ...buildFeaToolDefinitions().map((tool) => tool.name),
  ...buildDiscoveryToolDefinitions().map((tool) => tool.name),
];

describe('TOOLSETS', () => {
  it('assigns every MCP tool to exactly one toolset', () => {
    for (const name of allToolNames) {
      const owners = TOOLSET_NAMES.filter((toolset) => TOOLSETS[toolset].includes(name));
      expect(owners, name).toHaveLength(1);
    }
  });
  it('lists only real tool names', () => {
    const known = new Set(allToolNames);
    for (const toolset of TOOLSET_NAMES) {
      for (const name of TOOLSETS[toolset]) expect(known.has(name), name).toBe(true);
    }
  });
});

describe('parseToolsets()', () => {
  it('enables every toolset for "all"', () => {
    for (const raw of ['all', 'core,ALL']) {
      expect([...parseToolsets(raw).enabled].sort()).toEqual([...TOOLSET_NAMES].sort());
    }
  });
  it('enables only core when unset or empty', () => {
    for (const raw of [undefined, '', ' , ']) {
      expect([...parseToolsets(raw).enabled]).toEqual(['core']);
    }
  });
  it('always enables core and normalizes case and spaces', () => {
    const { enabled, unknown } = parseToolsets(' 3D , Measure ');
    expect([...enabled].sort()).toEqual(['3d', 'core', 'measure']);
    expect(unknown).toEqual([]);
  });
  it('reports unknown names and ignores them', () => {
    const { enabled, unknown } = parseToolsets('2d,cam,bim');
    expect([...enabled].sort()).toEqual(['2d', 'core']);
    expect(unknown).toEqual(['cam', 'bim']);
  });
  it('reports unknown names next to "all"', () => {
    const { enabled, unknown } = parseToolsets('all,bogus');
    expect(enabled.size).toBe(TOOLSET_NAMES.length);
    expect(unknown).toEqual(['bogus']);
  });
});

describe('isToolEnabled() / toolsetOf()', () => {
  const coreAnd3d = parseToolsets('3d').enabled;
  it('exposes tools of enabled toolsets only', () => {
    expect(isToolEnabled('add_box', coreAnd3d)).toBe(true);
    expect(isToolEnabled('describe_scene', coreAnd3d)).toBe(true);
    expect(isToolEnabled('draw_polyline', coreAnd3d)).toBe(false);
    expect(isToolEnabled('draw_walls', coreAnd3d)).toBe(false);
  });
  it('keeps a tool no toolset lists enabled', () => {
    expect(toolsetOf('not_a_tool')).toBeUndefined();
    expect(isToolEnabled('not_a_tool', coreAnd3d)).toBe(true);
  });
  it('places building commands in the building toolset', () => {
    expect(toolsetOf('draw_walls')).toBe('building');
    expect(toolsetOf('import_step')).toBe('exchange');
  });
});

describe('isPromptEnabled()', () => {
  it('hides the building workflows without the building toolset', () => {
    const coreOnly = parseToolsets('core').enabled;
    expect(isPromptEnabled('design_building', coreOnly)).toBe(false);
    expect(isPromptEnabled('design_factory', coreOnly)).toBe(false);
    expect(isPromptEnabled('model_bracket', coreOnly)).toBe(true);
    expect(isPromptEnabled('design_building', parseToolsets('building').enabled)).toBe(true);
  });
  it('hides the site workflow without the civil toolset', () => {
    expect(isPromptEnabled('design_site', parseToolsets('building').enabled)).toBe(false);
    expect(isPromptEnabled('design_site', parseToolsets('civil').enabled)).toBe(true);
  });
  it('every prompt is enabled when all toolsets are', () => {
    const all = parseToolsets('all').enabled;
    for (const prompt of listMcpPrompts()) expect(isPromptEnabled(prompt.name, all)).toBe(true);
  });
});

describe('MCP prompts', () => {
  const messages = (name: string, args: Record<string, string> = {}): [string, string] => {
    const r = getMcpPrompt(name, args)!;
    expect(r.description.length).toBeGreaterThan(0);
    expect(r.messages.length).toBeGreaterThanOrEqual(2);
    expect(r.messages.map((m) => m.role).slice(0, 2)).toEqual(['user', 'assistant']);
    return [r.messages[0]!.content.text, r.messages[1]!.content.text];
  };

  it('lists 6 described templates, incl. model_bracket, orthographic_setup, parametric_part; unknown names are null', () => {
    const prompts = listMcpPrompts();
    expect(prompts).toHaveLength(6);
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['model_bracket', 'orthographic_setup', 'parametric_part']));
    for (const p of prompts) {
      expect(p.name.length * p.description.length).toBeGreaterThan(0);
      for (const arg of p.arguments ?? []) expect(arg.name.length * arg.description.length).toBeGreaterThan(0);
    }
    expect(getMcpPrompt('nonexistent_prompt')).toBeNull();
    expect(getMcpPrompt('')).toBeNull();
  });

  it.each(['model_bracket', 'orthographic_setup', 'parametric_part'])('%s messages are non-empty user/assistant text', (name) => {
    for (const msg of getMcpPrompt(name, {})!.messages) {
      expect(msg.content.type).toBe('text');
      expect(msg.content.text.length).toBeGreaterThan(0);
      expect(['user', 'assistant']).toContain(msg.role);
    }
  });

  it.each<[string, Record<string, string>, RegExp[], RegExp[]]>([
    [
      'model_bracket',
      { width: '120', height: '60', thickness: '8' },
      [/120/],
      [/build_project/, /draw_rectangle/, /extrude_profile/, /"op": "subtract"/, /set_entity_name/, /describe_scene/],
    ],
    ['model_bracket', {}, [], []],
    ['orthographic_setup', { view: 'front' }, [], [/describe_scene/, /find_entities/, /FRONT/i]],
    ['orthographic_setup', { view: 'top' }, [], [/\+Z/]],
    ['orthographic_setup', { view: 'isometric' }, [], [/\+Z/]],
    ['parametric_part', { part_name: 'my_custom_part' }, [/my_custom_part/], [/build_project/]],
    ['parametric_part', {}, [/my_part/], [/extrude_profile/, /"op": "subtract"/, /set_entity_name/, /\$alias|\$base_profile|\$body/]],
  ])('%s %j renders the expected user / assistant text', (name, args, user, assistant) => {
    const [u, a] = messages(name, args);
    for (const re of user) expect(u).toMatch(re);
    for (const re of assistant) expect(a).toMatch(re);
  });

  it.each<[string, Record<string, string>]>([
    ['model_bracket', { width: '80', height: '40', thickness: '6', hole_count: '2' }],
    ['model_bracket', { width: '60', height: '30', thickness: '5', hole_count: '1' }],
    ['model_bracket', { width: '120', height: '50', thickness: '8', hole_count: '4' }],
    ['parametric_part', {}],
    ['parametric_part', { part_name: 'flange_plate' }],
  ])('%s %j emits a plan that passes build_project validate:true', (name, args) => {
    const block = /```json\s*([\s\S]*?)```/.exec(messages(name, args)[1]);
    expect(block?.[1]).toBeDefined();
    const payload = JSON.parse(block![1]!.replace(/\/\/[^\n]*/g, '')) as Record<string, unknown>;
    const data = execute(createEmptyDocument(), 'build_project', { ...payload, validate: true }).data as { ok: boolean; issues?: string[] };
    expect(data, JSON.stringify(data?.issues)).toMatchObject({ ok: true });
  });

  it.each<[string, string, string[], number]>([
    ['design_building', 'a small office', [], 15],
    ['design_factory', 'a 30 m hall', ['add_portal_frame_building', 'check_clashes'], 0],
    ['design_site', 'a depot yard', ['balance_platform', 'export_landxml'], 0],
  ])('%s walks a workflow naming only registered commands', (name, brief, mustName, atLeast) => {
    const [u, a] = messages(name, { brief });
    expect(u).toContain(brief);
    const named = [...a.matchAll(/`([a-z_]+)`/g)].map((match) => match[1] as string);
    expect(named.length).toBeGreaterThan(atLeast);
    expect(named).toEqual(expect.arrayContaining(mustName));
    for (const n of named) expect(getCommand(n), n).toBeDefined();
  });
});
