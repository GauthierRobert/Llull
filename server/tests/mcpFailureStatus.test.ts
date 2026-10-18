/** Over /mcp: a command refusing with a plain no-op is an isError result; replies carry ids and compact text. */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { buildMcpRouter, toolsetsFromEnv } from '../src/mcp';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { callMcpTool, openMcpSession } from './mcpTestSupport';

const app = express();
app.use(express.json());
app.use('/mcp', buildMcpRouter({ port: null, allowCodeExecution: false }, toolsetsFromEnv('all')));
const coreApp = express();
coreApp.use(express.json());
coreApp.use('/mcp', buildMcpRouter({ port: null, allowCodeExecution: false }, toolsetsFromEnv('')));

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

describe('MCP failure status', () => {
  it.each([
    ['pipe_hydraulics', { pipeId: 'nope' }],
    ['mass_properties', { entityId: 'nope' }],
    ['add_box', { size: [0, 1, 1] }],
    ['add_rigid_body', { entityIds: ['nope'] }],
    ['add_body_joint', { child: 'nope' }],
    ['move_entities', { ids: ['nope'] }],
  ])('%s refusing is isError', async (name, args) => {
    const session = await openMcpSession(app, false);
    const result = await callMcpTool(app, session, name, args);
    expect(result.isError).toBe(true);
  });

  it('a successful mutation returns its ids in structuredContent', async () => {
    const session = await openMcpSession(app, false);
    const result = await callMcpTool(app, session, 'add_box', { size: [1, 1, 1] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.['affected']).toEqual([expect.stringMatching(/^box-/)]);
  });

  it('a disabled tool leads with enable_toolset, then LLULL_TOOLSETS', async () => {
    const session = await openMcpSession(coreApp, false);
    const result = await callMcpTool(coreApp, session, 'add_box', { size: [1, 1, 1] });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBe(true);
    expect(text).toContain('enable_toolset {"name":');
    expect(text.indexOf('enable_toolset')).toBeLessThan(text.indexOf('LLULL_TOOLSETS'));
  });
});
