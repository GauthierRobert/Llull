/**
 * Desktop static serving (`LLULL_STATIC_DIR`): built assets and the SPA fallback for HTML
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
  fs.mkdirSync(path.join(dir, 'assets'));
  for (const name of ['physics.worker-AbC_12-x.js', 'other.worker-AbC_12-x.js'])
    fs.writeFileSync(path.join(dir, 'assets', name), 'self.onmessage = null;');
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

  it('sets a CSP on HTML (index and SPA fallback) but not on assets', async () => {
    for (const url of ['/', '/some/route']) {
      const response = await request(app).get(url).set('Accept', 'text/html');
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
    expect((await request(app).get('/app.js')).headers['content-security-policy']).toBeUndefined();
  });

  it('gives the physics worker script its own narrow policy (it may evaluate strings, same-origin only) and no other asset one', async () => {
    const worker = await request(app).get('/assets/physics.worker-AbC_12-x.js');
    expect(worker.status).toBe(200);
    expect(worker.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'",
    );
    expect((await request(app).get('/assets/other.worker-AbC_12-x.js')).headers['content-security-policy']).toBeUndefined();
    // hashed assets never change: cacheable for good; the page and unhashed files are re-fetched
    expect(worker.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(app).get('/app.js')).headers['cache-control']).not.toContain('immutable');
    expect((await request(app).get('/').set('Accept', 'text/html')).headers['cache-control'] ?? '').not.toContain('immutable');
    // the page policy itself never allows it
    const page = await request(app).get('/').set('Accept', 'text/html');
    expect(page.headers['content-security-policy']).not.toContain("'unsafe-eval'");
  });

  it('keeps JSON 404s for API clients', async () => {
    const response = await request(app).get('/nope').set('Accept', 'application/json');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/Not found/);
  });
});
