import { describe, it, expect } from 'vitest';
import { toToolSchemas } from '@core/commands/registry';

describe('tool descriptions lead with what the tool does', () => {
  const schemas = toToolSchemas();

  it('no description opens with an all-caps notice sentence (the first sentence is the one-line summary of list / search)', () => {
    const notices = schemas.filter((tool) => /^[A-Z][A-Z -]{3,}\./.test(tool.description)).map((tool) => tool.name);
    expect(notices).toEqual([]);
  });

  it('descriptions never point at the mesh kernel as the default or at a browser', () => {
    const stale = schemas.filter((tool) => /default Manifold|gracefully no-ops|browser/i.test(tool.description)).map((tool) => tool.name);
    expect(stale).toEqual([]);
  });

  it('cross-references the exact-kernel commands rely on resolve to registered tools or the CLI exchange tools', () => {
    const names = new Set(schemas.map((tool) => tool.name));
    const cliOnly = new Set(['export_step', 'import_step']);
    const wanted = ['find_entities', 'insert_instance', 'inspect_nurbs', 'import_mesh', 'export_step_ap242'];
    expect(wanted.filter((name) => !names.has(name))).toEqual([]);
    const text = schemas.map((tool) => tool.description).join('\n');
    for (const stale of ['list_entities', 'place_instance', 'inspect_surface']) expect(text).not.toContain(stale);
    expect([...cliOnly].every((name) => !names.has(name))).toBe(true);
  });
});
