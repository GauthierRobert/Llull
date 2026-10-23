/** The schema-only native tool definitions live in `@protocol/nativeTools`; their numeric defaults must match the server runners. */
import { describe, expect, it } from 'vitest';
import { buildNativeToolDefinitions } from '@protocol/nativeTools';
import { searchTools, toolsetOf } from '@protocol/index';
import { isNativeTool } from '../src/native/tools';
import { isScanTool } from '../src/scan/scanTools';
import { isMeshHostTool } from '../src/meshAssets/meshTools';
import { DEFAULT_TOPOLOGY_TIMEOUT_S } from '../src/native/topologySolve';
import { DEFAULT_EXPLICIT_TIMEOUT_S } from '../src/native/explicitRun';
import { DEFAULT_AUTO_ROUTE_TIMEOUT_S, NATIVE_EXPANSIONS_CEILING, NATIVE_MAX_EXPANSIONS } from '../src/native/autoRoute';
import { DEFAULT_IMPORT_TIMEOUT_S } from '../src/scan/scanImport';

const tools = buildNativeToolDefinitions();
const named = (name: string): ReturnType<typeof buildNativeToolDefinitions>[number] | undefined => tools.find((tool) => tool.name === name);

describe('native tool definitions (@protocol)', () => {
  it('declares exactly the tools the server runs', () => {
    for (const { name } of tools) expect(isNativeTool(name) || isScanTool(name) || isMeshHostTool(name), name).toBe(true);
    expect(tools).toHaveLength(14);
  });

  it('files each tool in a toolset (analysis for the FE / solver transports)', () => {
    for (const name of ['explicit_run', 'fatigue_field', 'fea_map_field', 'fea_render', 'mtest_run', 'topology_solve']) {
      expect(toolsetOf(name), name).toBe('analysis');
    }
    expect(toolsetOf('cfd_solve')).toBe('flow');
    expect(toolsetOf('auto_route')).toBe('piping');
    expect(toolsetOf('stackup_monte_carlo')).toBe('pmi');
    expect(toolsetOf('vortex_lattice_solve')).toBe('aerodynamics');
    expect(toolsetOf('scan_import')).toBe('scan');
  });

  it('keeps the default timeouts of the runners in the schema text', () => {
    const timeout = (name: string): string => named(name)?.inputSchema.properties['timeoutS']?.description ?? '';
    expect(timeout('topology_solve')).toContain(`default ${DEFAULT_TOPOLOGY_TIMEOUT_S}`);
    expect(timeout('explicit_run')).toContain(`default ${DEFAULT_EXPLICIT_TIMEOUT_S}`);
    expect(timeout('auto_route')).toContain(`default ${DEFAULT_AUTO_ROUTE_TIMEOUT_S}`);
    expect(timeout('scan_import')).toContain(`default ${DEFAULT_IMPORT_TIMEOUT_S}`);
    expect(named('auto_route')?.inputSchema.properties['maxExpansions']?.maximum).toBe(NATIVE_EXPANSIONS_CEILING);
    expect(named('auto_route')?.inputSchema.properties['maxExpansions']?.description).toContain(`default ${NATIVE_MAX_EXPANSIONS}`);
  });

  it('bounds timeoutS and keeps required ids', () => {
    expect(named('topology_solve')?.inputSchema.properties['timeoutS']).toMatchObject({ minimum: 1, maximum: 86400 });
    expect(named('topology_solve')?.inputSchema.required).toEqual(['studyId']);
    expect(named('scan_import')?.inputSchema.required).toEqual(['path']);
    expect(named('mtest_run')?.inputSchema.required).toEqual([]);
  });

  it('is searchable (llull search finds the native tools)', () => {
    expect(searchTools('topology optimization solve', 5).map((hit) => hit.name)).toContain('topology_solve');
    expect(searchTools('import point cloud scan', 5).map((hit) => hit.name)).toContain('scan_import');
  });
});
