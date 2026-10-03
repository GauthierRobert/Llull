/** Plugin contract: domains extend the core through installPlugin, not imports. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute, getCommand, listCommands } from '@core/commands/registry';
import { defineCommand, z } from '@core/commands/schema';
import { installPlugin, installedPlugins, pluginToolNames } from '@core/plugins/host';
import { TOOLSETS, toolsetOf } from '@mcp/toolsets';
import type { CadPlugin } from '@core/plugins/plugin';
import type { CommandDefinition } from '@core/commands/types';

const echoPlugin: CadPlugin = {
  name: 'test-echo',
  toolset: 'test',
  commands: [
    defineCommand({
      name: 'test_echo_plugin',
      description: 'Echo (test plugin).',
      params: z.object({ text: z.string().describe('Text') }),
      annotations: { readOnly: true },
      run: (doc, { text }) => ({ document: doc, summary: text, affected: [], data: { text } }),
    }),
  ] as ReadonlyArray<CommandDefinition<unknown>>,
};

describe('plugins', () => {
  it('the composition root installed building and industrial', () => {
    expect(installedPlugins().map((p) => p.name)).toEqual(
      expect.arrayContaining(['building', 'industrial']),
    );
    expect(getCommand('add_wall')).toBeDefined();
    expect(getCommand('add_portal_frame_building')).toBeDefined();
    expect(TOOLSETS.building).toContain('add_wall');
    expect(TOOLSETS.building).toContain('check_portal_frames');
    expect(toolsetOf('add_wall')).toBe('building');
  });

  it('installing a plugin registers its guarded commands once', () => {
    const before = listCommands().length;
    installPlugin(echoPlugin);
    installPlugin(echoPlugin);
    expect(listCommands().length).toBe(before + 1);
    expect(pluginToolNames('test')).toEqual(['test_echo_plugin']);
    const result = execute(createEmptyDocument(), 'test_echo_plugin', { text: 'hi' });
    expect(result.data).toEqual({ text: 'hi' });
    const invalid = execute(createEmptyDocument(), 'test_echo_plugin', { text: 3 });
    expect(invalid.summary).toMatch(/rejected: invalid params/);
  });

  it('refuses a plugin command that collides with an existing name', () => {
    const clash: CadPlugin = {
      ...echoPlugin,
      name: 'test-clash',
      commands: [{ ...echoPlugin.commands[0]!, name: 'add_box' }],
    };
    const before = listCommands().length;
    expect(() => installPlugin(clash)).toThrow(/add_box/);
    expect(installedPlugins().some((p) => p.name === 'test-clash')).toBe(false);
    expect(listCommands().length).toBe(before);
  });
});
