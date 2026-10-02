import { describe, it, expect } from 'vitest';
import { listCommands } from '@core/commands/registry';
import {
  TOOLSETS,
  TOOLSET_NAMES,
  buildExchangeToolDefinitions,
  isPromptEnabled,
  isToolEnabled,
  listMcpPrompts,
  parseToolsets,
  toolsetOf,
} from '@core/mcp';

const allToolNames = [
  ...listCommands().map((command) => command.name),
  ...buildExchangeToolDefinitions().map((tool) => tool.name),
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
  it('enables every toolset when unset, empty or "all"', () => {
    for (const raw of [undefined, '', ' , ', 'core,ALL']) {
      expect([...parseToolsets(raw).enabled].sort()).toEqual([...TOOLSET_NAMES].sort());
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
    expect(isToolEnabled('draw_line', coreAnd3d)).toBe(false);
    expect(isToolEnabled('add_wall', coreAnd3d)).toBe(false);
  });

  it('keeps a tool no toolset lists enabled', () => {
    expect(toolsetOf('not_a_tool')).toBeUndefined();
    expect(isToolEnabled('not_a_tool', coreAnd3d)).toBe(true);
  });

  it('places building commands in the building toolset', () => {
    expect(toolsetOf('add_wall')).toBe('building');
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

  it('every prompt is enabled when all toolsets are', () => {
    const all = parseToolsets(undefined).enabled;
    for (const prompt of listMcpPrompts()) expect(isPromptEnabled(prompt.name, all)).toBe(true);
  });
});
