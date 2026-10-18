import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  applyDiscoveryToolCall,
  buildDiscoveryToolDefinitions,
  getMcpPrompt,
  isPromptEnabled,
  isToolEnabled,
  listMcpResourceTemplates,
  parseToolsets,
  readMcpResource,
  searchTools,
  toolsetOf,
  TOOLSETS,
  TOOLSET_NAMES,
} from '@mcp/index';

const everything = new Set<string>(TOOLSET_NAMES);
const ranked = (query: string, count = 3): string[] => searchTools(query, count, everything).map((hit) => hit.name);

describe('search_tools ranking regression table', () => {
  it.each<[string, string, string[]]>([
    ['pressure drop', 'pipe_hydraulics', []],
    ['pipe pressure drop', 'pipe_hydraulics', []],
    ['cut and fill', 'platform_earthworks', []],
    ['cut fill volume', 'platform_earthworks', []],
    ['stress plot', 'render_fea_results', []],
    ['natural frequency', 'create_analysis', []],
    ['export step', 'export_step', []],
    ['fillet', 'fillet_edge', ['fillet_2d']],
    ['wall', 'draw_walls', []],
    ['make a hole in a plate', 'add_hole', []],
    ['how heavy is it', 'mass_properties', []],
    ['take a picture', 'render_view', []],
    ['measure distance between two points', 'measure_distance', []],
    ['simulate a pendulum', 'simulate_motion', []],
    ['hydraulic', 'pipe_hydraulics', []],
  ])('"%s" ranks %s first (and keeps %j in the top 3)', (query, first, alsoTop) => {
    const top = ranked(query);
    expect(top[0]).toBe(first);
    for (const name of alsoTop) expect(top).toContain(name);
  });

  it('does not let "fill" match "fillet" tools', () => {
    expect(ranked('cut fill volume', 10)).not.toContain('fillet_edge');
    expect(ranked('cut and fill', 10)).not.toContain('fillet_2d');
  });

  it('keeps pressure-drop hits out of unrelated pressure tools first', () => {
    expect(ranked('pressure drop', 2)[0]).toBe('pipe_hydraulics');
  });

  it('does not rank natural-frequency queries onto animation or surface tools above the analysis tools', () => {
    expect(ranked('natural frequency', 2)).toEqual(['create_analysis', 'render_fea_results']);
  });
});

describe('search_tools output', () => {
  const core = (): Set<string> => new Set(parseToolsets('').enabled);
  it('returns compact entries (first sentence <= 200 chars) and an enable hint naming exactly the found tools', () => {
    const outcome = applyDiscoveryToolCall('search_tools', { query: 'pressure drop', limit: 3 }, core());
    const results = (outcome?.result.structuredContent as { results: { name: string; summary: string; enabled: boolean }[] }).results;
    expect(results).toHaveLength(3);
    for (const hit of results) {
      expect(Object.keys(hit).sort()).toEqual(['enabled', 'name', 'summary', 'toolset']);
      expect(hit.summary.length).toBeLessThanOrEqual(200);
    }
    const text = outcome?.result.content[0]?.text ?? '';
    expect(text).toContain('"tools":["pipe_hydraulics"');
    expect(JSON.stringify(outcome?.result).length).toBeLessThan(6000);
  });
});

describe('enable_toolset { tools }', () => {
  const core = (): Set<string> => new Set(parseToolsets('').enabled);
  it('enables only the named tools, flags a list change, and is idempotent', () => {
    const enabled = core();
    const first = applyDiscoveryToolCall('enable_toolset', { tools: ['pipe_hydraulics', 'add_pipe_run'] }, enabled);
    expect(first?.result.isError).toBe(false);
    expect(first?.toolsListChanged).toBe(true);
    expect(isToolEnabled('pipe_hydraulics', enabled)).toBe(true);
    expect(isToolEnabled('add_pipe_run', enabled)).toBe(true);
    expect(isToolEnabled('add_pipe_support', enabled)).toBe(false);
    expect(isToolEnabled('draw_walls', enabled)).toBe(false);
    const again = applyDiscoveryToolCall('enable_toolset', { tools: ['pipe_hydraulics'] }, enabled);
    expect(again?.toolsListChanged).toBe(false);
    expect(again?.result.content[0]?.text).toContain('already enabled');
  });
  it('rejects unknown tool names with suggestions and changes nothing', () => {
    const enabled = core();
    const outcome = applyDiscoveryToolCall('enable_toolset', { tools: ['add_boxx', 'pipe_hydraulics'] }, enabled);
    expect(outcome?.result.isError).toBe(true);
    expect(outcome?.result.content[0]?.text).toContain('add_box');
    expect([...enabled]).toEqual(['core']);
  });
  it('rejects a non-array tools argument', () => {
    expect(applyDiscoveryToolCall('enable_toolset', { tools: 'add_box' }, core())?.result.isError).toBe(true);
  });
  it('no longer requires "toolset" in the schema', () => {
    const definition = buildDiscoveryToolDefinitions().find((tool) => tool.name === 'enable_toolset');
    expect(definition?.inputSchema).toMatchObject({ properties: { tools: { type: 'array' }, toolset: { type: 'string' } } });
  });
});

describe('toolset placement', () => {
  it('puts industrial piping in its own toolset (add_hole stays with the FTR manufacturing set)', () => {
    expect(toolsetOf('add_hole')).toBe('manufacturing');
    for (const name of ['pipe_hydraulics', 'add_pipe_run', 'add_pipe_support', 'check_pipe_supports', 'add_cable_tray']) {
      expect(toolsetOf(name)).toBe('piping');
    }
    expect(TOOLSETS.building).not.toContain('pipe_hydraulics');
  });
});

describe('resource templates', () => {
  it('lists cad://entity/{id} and reads one entity compactly', () => {
    expect(listMcpResourceTemplates().map((t) => t.uriTemplate)).toEqual(['cad://entity/{id}']);
    const doc = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] }).document;
    const id = doc.order[0]!;
    const content = readMcpResource(doc, `cad://entity/${id}`);
    expect(content?.mimeType).toBe('application/json');
    expect(JSON.parse(content?.text ?? '{}')).toMatchObject({ id, kind: 'box' });
    expect(readMcpResource(doc, 'cad://entity/nope')).toBeNull();
  });
  it('summarises mesh payloads as counts', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] }).document;
    const withMesh = {
      ...doc,
      entities: { ...doc.entities, m: { id: 'm', kind: 'mesh', mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] } } },
    } as unknown as typeof doc;
    const entity = JSON.parse(readMcpResource(withMesh, 'cad://entity/m')?.text ?? '{}') as { mesh: unknown };
    expect(entity.mesh).toEqual({ vertexCount: 3, triangleCount: 1 });
  });
  it('the scene resource reports the document units', () => {
    expect(JSON.parse(readMcpResource(createEmptyDocument(), 'cad://scene')?.text ?? '{}')).toMatchObject({ units: 'mm' });
  });
});

describe('workflow prompts', () => {
  it('are gated by their toolset and order the tools of the workflow', () => {
    expect(isPromptEnabled('fea_static_check', parseToolsets('').enabled)).toBe(false);
    expect(isPromptEnabled('fea_static_check', parseToolsets('analysis').enabled)).toBe(true);
    expect(isPromptEnabled('dynamics_simulation', parseToolsets('assembly').enabled)).toBe(true);
    expect(isPromptEnabled('piping_hydraulics', parseToolsets('piping').enabled)).toBe(true);
    const text = (name: string): string => getMcpPrompt(name, {})?.messages[1]?.content.text ?? '';
    const inOrder = (body: string, tools: string[]): boolean => {
      const at = tools.map((tool) => body.indexOf(`\`${tool}\``));
      return at.every((i) => i >= 0) && [...at].sort((a, b) => a - b).join() === at.join();
    };
    expect(
      inOrder(text('fea_static_check'), [
        'create_analysis',
        'add_fea_constraint',
        'add_fea_load',
        'fea_mesh',
        'fea_solve',
        'render_fea_results',
      ]),
    ).toBe(true);
    expect(
      inOrder(text('dynamics_simulation'), ['add_rigid_body', 'add_body_joint', 'add_motor', 'simulate_motion', 'plot_simulation']),
    ).toBe(true);
    expect(inOrder(text('piping_hydraulics'), ['add_pipe_run', 'add_pipe_support', 'pipe_hydraulics'])).toBe(true);
  });
  it('model_bracket coordinates carry no float noise', () => {
    const text =
      getMcpPrompt('model_bracket', { width: '100', height: '40', thickness: '6', hole_count: '3' })?.messages[1]?.content.text ?? '';
    expect(text).not.toMatch(/\d\.\d{7,}/);
  });
});
