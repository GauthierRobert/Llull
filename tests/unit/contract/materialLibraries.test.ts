import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute, getCommand, listCommands, toToolSchemas } from '@core/commands/registry';
import { TOOLSETS, toolsetOf } from '@mcp/toolsets';
import { buildAllMcpTools } from '@mcp/discovery';
import { createEmptyDocument } from '@core/model/types';
import { applyLibraryToolCall, buildLibraryToolDefinitions, type MaterialLibraryStorePort } from '@mcp/libraryTools';
import { hashOf, libraryFile } from '../materials/support';

const NEW_COMMANDS = [
  'define_material_record',
  'set_material_property',
  'get_material',
  'get_material_allowable',
  'convert_quantity',
  'import_material_library',
  'remove_material_library',
  'diff_material_libraries',
  'resolve_material_libraries',
  'set_export_marking',
  'check_materials',
];

describe('08 MAT M2 / M3 contract', () => {
  it('every new command is registered, schema-derived and in exactly one toolset (materials)', () => {
    const schemas = new Map(toToolSchemas().map((schema) => [schema.name, schema]));
    expect(toToolSchemas()).toHaveLength(listCommands().length);
    for (const name of NEW_COMMANDS) {
      expect(getCommand(name), name).toBeDefined();
      expect(schemas.get(name)?.description.length, name).toBeGreaterThan(40);
      expect(toolsetOf(name), name).toBe('materials');
      expect(
        Object.values(TOOLSETS).filter((tools) => tools.includes(name)),
        name,
      ).toHaveLength(1);
    }
  });

  it('create_material and assign_material moved from 3d to materials', () => {
    for (const name of ['create_material', 'assign_material']) {
      expect(TOOLSETS['3d']).not.toContain(name);
      expect(toolsetOf(name)).toBe('materials');
    }
  });

  it('queries are read-only, resolve_material_libraries is a session command, remove is destructive', () => {
    for (const name of ['get_material', 'get_material_allowable', 'convert_quantity', 'diff_material_libraries', 'check_materials'])
      expect(getCommand(name)?.annotations?.readOnly, name).toBe(true);
    expect(getCommand('resolve_material_libraries')?.annotations).toMatchObject({ session: true });
    expect(getCommand('remove_material_library')?.annotations?.destructive).toBe(true);
  });

  it('ctx.libraries is absent from the default context: no library provider is installed unless a host adds one', () => {
    expect(defaultContext().libraries ?? null).toBeNull();
  });

  it('a session command appends no feature step and a mutating one does', () => {
    const doc = createEmptyDocument();
    const file = libraryFile();
    const imported = execute(doc, 'import_material_library', { library: file });
    expect(imported.document.featureHistory).toHaveLength(1);
    const resolved = execute(imported.document, 'resolve_material_libraries', {});
    expect(resolved.document.featureHistory).toHaveLength(1);
    expect(resolved.document.nextStepNumber).toBe(imported.document.nextStepNumber);
  });

  it('register_material_library is an MCP tool of the materials toolset', () => {
    expect(buildLibraryToolDefinitions().map((tool) => tool.name)).toEqual(['register_material_library']);
    expect(buildAllMcpTools().map((tool) => tool.name)).toContain('register_material_library');
    expect(toolsetOf('register_material_library')).toBe('materials');
  });
});

describe('register_material_library transport', () => {
  const stored: string[] = [];
  const store: MaterialLibraryStorePort = {
    register: (library, sha256) => {
      stored.push(`${library.id}@${library.version}`);
      return {
        libraryId: library.id,
        version: library.version,
        sha256,
        storage: library.storage,
        licence: library.licence,
        exportMarking: library.exportMarking,
      };
    },
  };
  const text = (file: Record<string, unknown>): string => JSON.stringify(file);
  const run = (args: unknown, libraries: MaterialLibraryStorePort | null = store): ReturnType<typeof applyLibraryToolCall> =>
    applyLibraryToolCall('register_material_library', args, { libraries });

  it('stores a valid library and answers its id, version, hash, licence and marking', () => {
    const file = libraryFile({ id: 'mmpds', storage: 'private', licence: 'licensed-no-redistribution', marking: { regime: 'EAR99' } });
    const result = run({ libraryJson: text(file), storage: 'private' });
    expect(result?.isError).toBe(false);
    expect(result?.structuredContent).toMatchObject({
      libraryId: 'mmpds',
      version: '1',
      sha256: hashOf(file),
      storage: 'private',
      licence: 'licensed-no-redistribution',
      exportMarking: { regime: 'EAR99' },
    });
    expect(stored).toEqual(['mmpds@1']);
  });

  it('refuses bad input with a code and stores nothing', () => {
    const before = stored.length;
    const failures = [
      run({}),
      run({ libraryJson: 'not json' }),
      run({ libraryJson: text({ format: 'x' }) }),
      run({ libraryJson: text(libraryFile()), storage: 'private' }),
      run({ libraryJson: text(libraryFile({ licence: 'licensed-no-redistribution' })) }),
      run({ libraryJson: text(libraryFile()) }, null),
    ];
    expect(failures.map((result) => result?.isError)).toEqual(failures.map(() => true));
    const messages = failures.map((result) => result?.content[0]?.text ?? '');
    expect(messages[1]).toContain('MAT_LIBRARY_INVALID');
    expect(messages[2]).toContain('MAT_LIBRARY_INVALID');
    expect(messages[3]).toContain('differs');
    expect(messages[4]).toContain('MAT_LICENCE_EMBED_FORBIDDEN');
    expect(messages[5]).toContain('MAT_LIBRARY_UNRESOLVED');
    expect(stored.length).toBe(before);
  });

  it('ignores other tool names, and reports a store that throws', () => {
    expect(applyLibraryToolCall('import_step', {}, { libraries: store })).toBeNull();
    const throwing: MaterialLibraryStorePort = {
      register: () => {
        throw new Error('disk full');
      },
    };
    expect(run({ libraryJson: text(libraryFile()) }, throwing)?.content[0]?.text).toContain('disk full');
  });
});
