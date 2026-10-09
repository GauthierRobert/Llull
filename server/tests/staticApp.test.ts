/**
 * @layer server/tests
 * On-prem static serving (`LLULL_STATIC_DIR`): built assets and the SPA fallback for HTML
 * navigations; API 404s stay JSON.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let dir = '';
let app: Express;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>llull</title>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.warn("ok");');
  process.env['LLULL_STATIC_DIR'] = dir;
  vi.resetModules();
  app = (await import('../src/index')).app;
}, 60000);

afterAll(() => {
  delete process.env['LLULL_STATIC_DIR'];
  fs.rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe('LLULL_STATIC_DIR', () => {
  it('serves built assets', async () => {
    const response = await request(app).get('/app.js');
    expect(response.status).toBe(200);
    expect(response.text).toContain('console.warn');
  });

  it('falls back to index.html for HTML navigations', async () => {
    const response = await request(app).get('/some/route').set('Accept', 'text/html');
    expect(response.status).toBe(200);
    expect(response.text).toContain('<title>llull</title>');
  });

  it('keeps JSON 404s for API clients', async () => {
    const response = await request(app).get('/nope').set('Accept', 'application/json');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/Not found/);
  });
});
