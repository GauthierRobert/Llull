import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { ExecutionContext } from '@core/commands/types';
import type { FeArtifactPort, HumanSignaturePort } from '@core/model/analysis';
import { installPlugin } from '@core/plugins/host';
import { createEmptyDocument } from '@core/model/types';
import { TOOLSETS } from '@mcp/toolsets';
import { listCommands } from '@core/commands/registry';

const seen: Array<{ artifact: unknown; signer: unknown }> = [];

const probePorts = defineCommand({
  name: 'test_probe_ports',
  description: 'Test only: records the artifact port and the signature port visible to the command.',
  annotations: { readOnly: true },
  params: z.object({ hash: z.string().describe('Artifact hash to look up.') }),
  run: (doc, { hash }, ctx) => {
    seen.push({ artifact: ctx?.feaArtifacts?.get(hash) ?? null, signer: ctx?.humanSignature?.verify({}, hash)?.signer ?? null });
    return changed(doc, 'probed', [hash]);
  },
});

installPlugin({ name: 'test-ports', toolset: 'core', commands: [probePorts as never] });

const mesh = { kind: 'fe_mesh' as const };
const artifacts: FeArtifactPort = { get: (hash) => (hash === 'h1' ? ({ ...mesh } as never) : null) };
const signatures: HumanSignaturePort = { verify: (_signature, payload) => ({ signer: `signer:${payload}`, signatureId: 's1' }) };
const context = (): ExecutionContext => ({ ...defaultContext(), feaArtifacts: artifacts, humanSignature: signatures });

describe('FEA ports on the execution context', () => {
  it('are absent by default', () => {
    const base = defaultContext();
    expect(base.feaArtifacts).toBeUndefined();
    expect(base.humanSignature).toBeUndefined();
  });

  it('reach a command run directly through execute', () => {
    seen.length = 0;
    execute(createEmptyDocument(), 'test_probe_ports', { hash: 'h1' }, context());
    expect(seen).toEqual([{ artifact: mesh, signer: 'signer:h1' }]);
  });

  it('reach commands nested in build_project, including loops', () => {
    seen.length = 0;
    execute(
      createEmptyDocument(),
      'build_project',
      {
        actions: [
          { command: 'test_probe_ports', params: { hash: 'h1' } },
          { command: 'test_probe_ports', params: { hash: 'zz' } },
        ],
      },
      context(),
    );
    expect(seen).toEqual([
      { artifact: mesh, signer: 'signer:h1' },
      { artifact: null, signer: 'signer:zz' },
    ]);
  });

  it('are absent for a nested command when the caller gave none', () => {
    seen.length = 0;
    execute(createEmptyDocument(), 'build_project', { actions: [{ command: 'test_probe_ports', params: { hash: 'h1' } }] });
    expect(seen).toEqual([{ artifact: null, signer: null }]);
  });
});

describe('analysis toolset', () => {
  it('lists the core analytic checks and every cae command exactly once', () => {
    const tools = TOOLSETS.analysis;
    expect(tools).toContain('check_assembly');
    for (const name of [
      'create_analysis',
      'delete_analysis',
      'describe_analysis',
      'set_part_idealization',
      'add_fea_constraint',
      'update_fea_load',
      'set_mesh_controls',
      'add_result_probe',
    ]) {
      expect(tools.filter((tool) => tool === name)).toHaveLength(1);
      expect(listCommands().some((command) => command.name === name)).toBe(true);
    }
  });
});
