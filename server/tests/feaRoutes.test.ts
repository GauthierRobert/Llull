/** FE tools over the transports that need no external tool: MCP-layer dispatch, `POST /exchange`, `llull describe`, with a fake FeaToolsPort. */

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { applyExchangeToolCall, buildFeaToolDefinitions, type FeaToolResult, type FeaToolsPort } from '@mcp/index';
import { createEmptyDocument } from '@core/model/types';
import { buildExchangeRouter } from '../src/exchangeRoutes';
import { EXIT_OK, runCli } from '../src/cli/main';

const ok = (summary: string, data?: unknown): FeaToolResult => ({
  summary,
  affected: [],
  isError: false,
  ...(data !== undefined ? { data } : {}),
});
const calls: string[] = [];
const fake: FeaToolsPort = {
  mesh: (id) => Promise.resolve(ok(`meshed ${id}`)),
  solve: (id, options) => {
    calls.push(`solve ${id} ${String(options.timeoutS)}`);
    return Promise.resolve(ok(`solved ${id}`));
  },
  exportDeck: (id) => Promise.reject(new Error(`no deck for ${id}`)),
};
const host = { port: null, allowCodeExecution: false, getDoc: createEmptyDocument, applyCommand: (): FeaToolResult => ok('') };

describe('FE tool dispatch', () => {
  it('defines fea_mesh / fea_solve / fea_export with a required analysisId', () => {
    const tools = buildFeaToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual(['fea_mesh', 'fea_solve', 'fea_export']);
    for (const tool of tools) expect(tool.inputSchema.required).toEqual(['analysisId']);
  });

  it('routes calls to the port, passes timeoutS and turns throws into error results', async () => {
    const deps = { ...host, fea: fake };
    expect((await applyExchangeToolCall('fea_mesh', { analysisId: 'a' }, deps))?.content[0]?.text).toBe('meshed a');
    await applyExchangeToolCall('fea_solve', { analysisId: 'a', timeoutS: 30 }, deps);
    expect(calls).toEqual(['solve a 30']);
    const failed = await applyExchangeToolCall('fea_export', { analysisId: 'a' }, deps);
    expect(failed).toMatchObject({ isError: true });
    expect(failed?.content[0]?.text).toContain('no deck for a');
  });

  it('refuses a missing analysisId or port and ignores other tools', async () => {
    expect((await applyExchangeToolCall('fea_mesh', {}, { ...host, fea: fake }))?.isError).toBe(true);
    const noPort = await applyExchangeToolCall('fea_mesh', { analysisId: 'a' }, host);
    expect(noPort?.content[0]?.text).toContain('FEA_TOOL_MISSING');
    expect(await applyExchangeToolCall('add_box', {}, { ...host, fea: fake })).toBeNull();
  });
});

describe('FE tools through POST /exchange and the CLI', () => {
  const app = express()
    .use(express.json())
    .use(buildExchangeRouter((_req, _res, next) => next(), { port: null, allowCodeExecution: false, fea: fake }));

  it('answers the command-bus shape', async () => {
    const reply = await request(app)
      .post('/exchange')
      .send({ name: 'fea_mesh', params: { analysisId: 'an-1' } });
    expect(reply.body).toMatchObject({ summary: 'meshed an-1', isError: false, changed: false });
  });

  it('lists and describes the FE tools in the analysis toolset', async () => {
    const out: string[] = [];
    const io = {
      stdout: (text: string) => out.push(text),
      stderr: () => undefined,
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    };
    expect(await runCli(['list', 'analysis'], io)).toBe(EXIT_OK);
    expect(out.join('\n')).toMatch(/^fea_solve \[analysis\]/m);
    out.length = 0;
    expect(await runCli(['describe', 'fea_export'], io)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('analysisId');
  });
});
