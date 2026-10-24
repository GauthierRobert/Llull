import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute, getCommand, listCommands } from '@core/commands/registry';
import { defineCommand, z } from '@core/commands/schema';
import { installPlugin, onPluginInstalled, pluginToolNames } from '@core/plugins/host';
import { TOOLSETS, toolsetOf } from '@protocol/toolsets';
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
    expect(getCommand('draw_walls')).toBeDefined();
    expect(getCommand('add_portal_frame_building')).toBeDefined();
    expect(TOOLSETS.building).toContain('draw_walls');
    expect(TOOLSETS.building).toContain('check_portal_frames');
    expect(toolsetOf('draw_walls')).toBe('building');
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
    const clash: CadPlugin = { ...echoPlugin, name: 'test-clash', commands: [{ ...echoPlugin.commands[0]!, name: 'add_box' }] };
    const before = listCommands().length;
    expect(() => installPlugin(clash)).toThrow(/add_box/);
    expect(listCommands().length).toBe(before);
  });
});

describe('CadPlugin.onInstall', () => {
  const bare = (name: string, onInstall: () => void): CadPlugin => ({ name, toolset: 'test', commands: [], onInstall });

  it('runs once on install and not again for a second install of the same name', () => {
    let calls = 0;
    const plugin = bare('test-oninstall-once', () => (calls += 1));
    installPlugin(plugin);
    installPlugin(plugin);
    installPlugin(bare('test-oninstall-once', () => (calls += 10)));
    expect(calls).toBe(1);
  });

  it('does not run when a listener rejects the plugin, and the plugin is not installed', () => {
    onPluginInstalled((plugin) => {
      if (plugin.name === 'test-oninstall-rejected') throw new Error('rejected by a listener');
    });
    let calls = 0;
    const plugin = bare('test-oninstall-rejected', () => (calls += 1));
    expect(() => installPlugin(plugin)).toThrow(/rejected by a listener/);
    expect(calls).toBe(0);
    expect(() => installPlugin(plugin)).toThrow(/rejected/);
    expect(calls).toBe(0);
  });
});
