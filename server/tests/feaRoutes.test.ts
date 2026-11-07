/** FE tools over the transports that need no external tool: @protocol dispatch, `POST /exchange`, `llull describe`, with a fake FeaToolsPort. */

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { applyExchangeToolCall, buildFeaToolDefinitions, type FeaToolResult, type FeaToolsPort } from '@protocol/index';
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
  importField: (id) => Promise.resolve(ok(`imported ${id}`)),
  convergenceStudy: (id, options) => {
    calls.push(`study ${id} ${JSON.stringify(options)}`);
    return Promise.resolve(ok(`studied ${id}`));
  },
  importResults: (id) => Promise.resolve(ok(`results imported ${id}`)),
};
const host = { port: null, allowCodeExecution: false, getDoc: createEmptyDocument, applyCommand: (): FeaToolResult => ok('') };

describe('FE tool dispatch', () => {
  it('defines fea_mesh / fea_solve / fea_export / fea_import_results / fea_import_field with a required analysisId', () => {
    const tools = buildFeaToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual([
      'fea_mesh',
      'fea_solve',
      'fea_export',
      'fea_import_results',
      'fea_import_field',
      'run_convergence_study',
    ]);
    for (const tool of tools.slice(0, 3)) expect(tool.inputSchema.required).toEqual(['analysisId']);
    expect(tools[3]?.inputSchema.required).toEqual(['analysisId', 'format']);
    expect(tools[4]?.inputSchema.required).toEqual(['analysisId', 'coordinatesUnit', 'temperatureUnit']);
    expect(tools[5]?.inputSchema.required).toEqual(['analysisId', 'quantity']);
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

  it('routes run_convergence_study with its parsed options and refuses a malformed quantity or number', async () => {
    const deps = { ...host, fea: fake };
    calls.length = 0;
    const quantity = { kind: 'probe', probeId: 'p-1' };
    await applyExchangeToolCall('run_convergence_study', { analysisId: 'a', quantity, levels: 4, ratio: 1.5, timeoutS: 30 }, deps);
    expect(calls).toEqual([`study a ${JSON.stringify({ quantity, levels: 4, ratio: 1.5, timeoutS: 30 })}`]);
    const noQuantity = await applyExchangeToolCall('run_convergence_study', { analysisId: 'a' }, deps);
    expect(noQuantity?.isError).toBe(true);
    expect(noQuantity?.content[0]?.text).toContain('quantity is required');
    const badNumber = await applyExchangeToolCall('run_convergence_study', { analysisId: 'a', quantity, levels: 'three' }, deps);
    expect(badNumber?.content[0]?.text).toContain('levels must be a finite number');
    expect(calls).toHaveLength(1);
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
