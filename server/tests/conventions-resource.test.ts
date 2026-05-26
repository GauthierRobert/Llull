/**
 * @layer server/tests
 *
 * Tests for the `cad://conventions` MCP resource and the tool-count invariant.
 *
 * Covers:
 *   (A) conventions resource is listed in resources/list
 *   (B) conventions resource is readable and returns Markdown content
 *   (C) tool-count invariant: buildMcpTools().length === listCommands().length
 *       (the transport adds bridge tools separately — this invariant is about the
 *        CORE registry only; conventions is a resource, not a tool)
 */

import { describe, it, expect } from 'vitest';
import { listCommands } from '@core/commands/registry';
import { buildMcpTools, listMcpResources, readMcpResource, CAD_RESOURCE_URIS } from '@core/mcp';
import { CONVENTIONS_GUIDE, CONVENTIONS_URI } from '@core/mcp';
import { buildBridgeToolDefinitions } from '@core/mcp';
import { createEmptyDocument } from '@core/model/types';

// ---------------------------------------------------------------------------
// (A) conventions resource is listed
// ---------------------------------------------------------------------------

describe('cad://conventions resource listing', () => {
  it('is included in listMcpResources()', () => {
    const resources = listMcpResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain(CONVENTIONS_URI);
    expect(uris).toContain('cad://conventions');
  });

  it('has mimeType text/markdown', () => {
    const resources = listMcpResources();
    const conv = resources.find((r) => r.uri === CONVENTIONS_URI);
    expect(conv).toBeDefined();
    expect(conv!.mimeType).toBe('text/markdown');
  });

  it('has a non-empty name and description', () => {
    const resources = listMcpResources();
    const conv = resources.find((r) => r.uri === CONVENTIONS_URI);
    expect(conv).toBeDefined();
    expect(conv!.name.length).toBeGreaterThan(0);
    expect(conv!.description.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (B) conventions resource is readable
// ---------------------------------------------------------------------------

describe('cad://conventions resource read', () => {
  it('readMcpResource returns text/markdown content for cad://conventions', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://conventions');
    expect(content).not.toBeNull();
    expect(content!.uri).toBe('cad://conventions');
    expect(content!.mimeType).toBe('text/markdown');
    expect(typeof content!.text).toBe('string');
    expect(content!.text.length).toBeGreaterThan(0);
  });

  it('content covers document units', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://conventions');
    expect(content!.text).toMatch(/units/i);
  });

  it('content covers the +Z-up right-handed world frame', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://conventions');
    expect(content!.text).toMatch(/\+Z/i);
    expect(content!.text).toMatch(/right.handed/i);
  });

  it('content covers placement anchors for standard primitives', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://conventions');
    const text = content!.text;
    // Must mention at least the key primitives and their anchors
    expect(text).toMatch(/add_box/);
    expect(text).toMatch(/add_cylinder/);
    expect(text).toMatch(/add_sphere/);
    expect(text).toMatch(/center/i);
    expect(text).toMatch(/base.center/i);
  });

  it('content covers rotation as Euler XYZ radians', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://conventions');
    const text = content!.text;
    expect(text).toMatch(/rotation/i);
    expect(text).toMatch(/radian/i);
    // Must explicitly say NOT degrees somewhere or warn about degrees pitfall
    expect(text).toMatch(/degree/i);
  });

  it('content mentions the recommended agent loop', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://conventions');
    const text = content!.text;
    expect(text).toMatch(/describe_scene/);
    expect(text).toMatch(/render_view/);
  });

  it('CONVENTIONS_GUIDE export matches the resource text', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://conventions');
    expect(content!.text).toBe(CONVENTIONS_GUIDE);
  });

  it('readMcpResource returns null for an unknown URI', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://unknown-resource');
    expect(content).toBeNull();
  });

  it('CAD_RESOURCE_URIS.conventions equals the CONVENTIONS_URI constant', () => {
    expect(CAD_RESOURCE_URIS.conventions).toBe(CONVENTIONS_URI);
    expect(CAD_RESOURCE_URIS.conventions).toBe('cad://conventions');
  });
});

// ---------------------------------------------------------------------------
// (C) Tool-count invariant: conventions is a RESOURCE, not a tool
// ---------------------------------------------------------------------------

describe('tool-count invariant', () => {
  it('buildMcpTools().length === listCommands().length (core registry only)', () => {
    // The cardinal rule: tools come from the registry, never hand-written.
    // cad://conventions is a RESOURCE; it must NOT inflate this count.
    const toolCount = buildMcpTools().length;
    const commandCount = listCommands().length;
    expect(toolCount).toBe(commandCount);
  });

  it('buildMcpTools() names match listCommands() names exactly', () => {
    const toolNames = buildMcpTools().map((t) => t.name);
    const commandNames = listCommands().map((c) => c.name);
    expect(toolNames).toEqual(commandNames);
  });

  it('cad://conventions URI does NOT appear in any tool name', () => {
    const toolNames = buildMcpTools().map((t) => t.name);
    for (const name of toolNames) {
      expect(name).not.toContain('conventions');
    }
  });

  it('bridge tools are separate from core registry tools', () => {
    const bridgeNames = buildBridgeToolDefinitions().map((t) => t.name);
    const commandNames = listCommands().map((c) => c.name);
    // Bridge tools are NOT in the core registry
    for (const bridgeName of bridgeNames) {
      expect(commandNames).not.toContain(bridgeName);
    }
  });
});
