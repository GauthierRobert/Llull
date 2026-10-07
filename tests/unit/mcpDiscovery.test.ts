import { describe, it, expect } from 'vitest';
import {
  applyDiscoveryToolCall,
  buildDiscoveryToolDefinitions,
  closestToolNames,
  parseToolsets,
  searchTools,
  toolsetOf,
  TOOLSET_NAMES,
  type ToolSearchResult,
  type ToolsetName,
} from '@mcp/index';
import { getCommand } from '@core/commands/registry';

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

describe('search_tools', () => {
  it('ranks name matches first and reports toolset + enabled', () => {
    const results = searchTools('wall', 5, coreOnly());
    expect(results[0]?.name).toMatch(/wall/);
    const wall = results.find((r) => r.name === 'add_wall');
    expect(wall).toMatchObject({ toolset: 'building', enabled: false });
    expect(wall?.description.length).toBeGreaterThan(0);
  });

  it('covers exchange tools and marks enabled state from the session set', () => {
    const exchange = searchTools('export step', 5, coreOnly()).find(
      (r) => r.name === 'export_step',
    );
    expect(exchange).toMatchObject({ toolset: 'exchange', enabled: false });
    const all = new Set(TOOLSET_NAMES);
    expect(searchTools('export step', 5, all).find((r) => r.name === 'export_step')?.enabled).toBe(
      true,
    );
  });

  it('finds the discovery tools themselves as enabled core tools', () => {
    expect(searchTools('enable toolset', 3, coreOnly())[0]).toMatchObject({
      name: 'enable_toolset',
      toolset: 'core',
      enabled: true,
    });
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
    expect(summary).toContain('add_wall');
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
    expect(closestToolNames('Boolean_Subtrct', 3)).toContain('boolean_subtract');
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
