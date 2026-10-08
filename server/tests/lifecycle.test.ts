/**
 * @layer server/tests
 * `startServer` fails with a clear, stack-free message when the port is taken, and does not leave
 * signal handlers behind.
 */

import net from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';
import express from 'express';
import { startServer } from '../src/lifecycle';

let blocker: net.Server | null = null;
afterEach(() => {
  blocker?.close();
  blocker = null;
});

function occupyPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    blocker = server;
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

describe('startServer', () => {
  it('rejects with an actionable message when the port is already in use', async () => {
    const port = await occupyPort();
    const sigterm = process.listenerCount('SIGTERM');
    await expect(startServer(express(), port, '127.0.0.1')).rejects.toThrow(
      new RegExp(`port ${port} on 127.0.0.1 is already in use.*set PORT`, 'is'),
    );
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  }, 60_000);

  it('refuses an unsafe bind before opening a socket', async () => {
    const previous = process.env['MCP_AUTH_TOKEN'];
    delete process.env['MCP_AUTH_TOKEN'];
    delete process.env['LLULL_ALLOW_UNAUTHENTICATED'];
    try {
      await expect(startServer(express(), 0, '0.0.0.0')).rejects.toThrow(/MCP_AUTH_TOKEN/);
    } finally {
      if (previous !== undefined) process.env['MCP_AUTH_TOKEN'] = previous;
    }
  });
});
