import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadConfig(): Promise<typeof import('@ui/serverConfig')> {
  vi.resetModules();
  return import('@ui/serverConfig');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('serverConfig', () => {
  it('uses the dev backend on localhost:3001 with no auth header', async () => {
    const config = await loadConfig();
    expect(config.SERVER_BASE).toBe('http://localhost:3001');
    expect(config.serverAuthHeaders()).toEqual({});
    expect(config.hasApiToken()).toBe(false);
    expect(config.liveStreamUrl()).toBe('http://localhost:3001/live');
  });
  it('uses the page origin in a production build (the backend serves the page)', async () => {
    vi.stubEnv('PROD', true);
    const config = await loadConfig();
    expect(config.SERVER_BASE).toBe(window.location.origin);
  });
  it('sends the token stored in localStorage as a bearer header', async () => {
    window.localStorage.setItem('llull.apiToken', 'user-tok');
    const config = await loadConfig();
    expect(config.hasApiToken()).toBe(true);
    expect(config.serverAuthHeaders()).toEqual({ Authorization: 'Bearer user-tok' });
  });
  it('captures #token=<token> into localStorage and strips the fragment', async () => {
    window.history.replaceState(null, '', '/#token=abc%20123');
    const config = await loadConfig();
    expect(config.serverAuthHeaders()).toEqual({ Authorization: 'Bearer abc 123' });
    expect(window.location.hash).toBe('');
    expect(window.localStorage.getItem('llull.apiToken')).toBe('abc 123');
  });
  it('never puts the token in the /live URL: mints a ticket over header auth', async () => {
    window.localStorage.setItem('llull.apiToken', 'a b&c');
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: 't/1', expiresInMs: 30000 }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const config = await loadConfig();
    const url = await config.liveTicketStreamUrl();
    expect(url).toBe('http://localhost:3001/live?ticket=t%2F1');
    expect(url).not.toContain('access_token');
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3001/live/ticket', {
      method: 'POST',
      headers: { Authorization: 'Bearer a b&c' },
    });
  });
  it('rejects when the ticket request fails', async () => {
    window.localStorage.setItem('llull.apiToken', 'x');
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    const config = await loadConfig();
    await expect(config.liveTicketStreamUrl()).rejects.toThrow('401');
  });
});
