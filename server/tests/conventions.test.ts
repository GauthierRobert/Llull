/** The conventions guide (`llull guide`), and the invariant that the command tools are exactly the registry commands. */

import { describe, it, expect } from 'vitest';
import { listCommands } from '@core/commands/registry';
import { buildCommandTools, CONVENTIONS_GUIDE } from '@protocol/index';

describe('conventions guide', () => {
  it.each([
    ['document units', [/units/i]],
    ['the +Z-up right-handed frame', [/\+Z/i, /right.handed/i]],
    ['primitive placement anchors', [/add_box/, /add_cylinder/, /add_sphere/, /center/i, /base.center/i]],
    ['rotation as radians (not degrees)', [/rotation/i, /radian/i, /degree/i]],
    ['the agent loop', [/describe_scene/, /render_view/]],
  ])('covers %s', (_topic, patterns) => {
    for (const pattern of patterns) expect(CONVENTIONS_GUIDE).toMatch(pattern);
  });

  it('points at no MCP resource', () => {
    expect(CONVENTIONS_GUIDE).not.toMatch(/cad:\/\//);
  });
});

describe('tool-count invariant', () => {
  it('buildCommandTools() names are exactly listCommands() names (no resource or retired bridge tools)', () => {
    const toolNames = buildCommandTools().map((t) => t.name);
    expect(toolNames).toEqual(listCommands().map((c) => c.name));
    for (const name of toolNames) expect(name).not.toContain('conventions');
    expect(toolNames).not.toContain('snapshot_in_from_ui');
    expect(toolNames).not.toContain('snapshot_out_to_ui');
  });
});
