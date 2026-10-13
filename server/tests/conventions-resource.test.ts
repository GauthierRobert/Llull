/** The `cad://conventions` MCP resource, and the invariant that MCP tools are exactly the registry commands. */

import { describe, it, expect } from 'vitest';
import { listCommands } from '@core/commands/registry';
import { buildMcpTools, listMcpResources, readMcpResource, CAD_RESOURCE_URIS, CONVENTIONS_GUIDE, CONVENTIONS_URI } from '@mcp/index';
import { createEmptyDocument } from '@core/model/types';

describe('cad://conventions resource', () => {
  it('is listed as non-empty text/markdown', () => {
    const conv = listMcpResources().find((r) => r.uri === CONVENTIONS_URI);
    expect(CONVENTIONS_URI).toBe('cad://conventions');
    expect(CAD_RESOURCE_URIS.conventions).toBe(CONVENTIONS_URI);
    expect(conv!.mimeType).toBe('text/markdown');
    expect(conv!.name.length).toBeGreaterThan(0);
    expect(conv!.description.length).toBeGreaterThan(0);
  });

  it('reads as the CONVENTIONS_GUIDE markdown', () => {
    const content = readMcpResource(createEmptyDocument(), 'cad://conventions');
    expect(content!.uri).toBe('cad://conventions');
    expect(content!.mimeType).toBe('text/markdown');
    expect(content!.text).toBe(CONVENTIONS_GUIDE);
    expect(CONVENTIONS_GUIDE.length).toBeGreaterThan(0);
  });

  it.each([
    ['document units', [/units/i]],
    ['the +Z-up right-handed frame', [/\+Z/i, /right.handed/i]],
    ['primitive placement anchors', [/add_box/, /add_cylinder/, /add_sphere/, /center/i, /base.center/i]],
    ['rotation as radians (not degrees)', [/rotation/i, /radian/i, /degree/i]],
    ['the agent loop', [/describe_scene/, /render_view/]],
  ])('covers %s', (_topic, patterns) => {
    for (const pattern of patterns) expect(CONVENTIONS_GUIDE).toMatch(pattern);
  });

  it('an unknown URI reads as null', () => {
    expect(readMcpResource(createEmptyDocument(), 'cad://unknown-resource')).toBeNull();
  });
});

describe('tool-count invariant', () => {
  it('buildMcpTools() names are exactly listCommands() names (no resource or retired bridge tools)', () => {
    const toolNames = buildMcpTools().map((t) => t.name);
    expect(toolNames).toEqual(listCommands().map((c) => c.name));
    for (const name of toolNames) expect(name).not.toContain('conventions');
    expect(toolNames).not.toContain('snapshot_in_from_ui');
    expect(toolNames).not.toContain('snapshot_out_to_ui');
  });
});
