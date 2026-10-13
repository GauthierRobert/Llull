import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadConfig(): Promise<typeof import('@ui/serverConfig')> {
  vi.resetModules();
  return import('@ui/serverConfig');
}

afterEach(() => {
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('serverConfig', () => {
  it('defaults to localhost:3001 with no auth header', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', '');
    vi.stubEnv('VITE_LLULL_API_TOKEN', '');
    const config = await loadConfig();
    expect(config.SERVER_BASE).toBe('http://localhost:3001');
    expect(config.serverAuthHeaders()).toEqual({});
  });
  it('reads the server URL from VITE_LLULL_SERVER_URL and strips trailing slashes', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', 'https://cad.example.com/api/');
    const config = await loadConfig();
    expect(config.SERVER_BASE).toBe('https://cad.example.com/api');
  });
  it('uses the page origin for VITE_LLULL_SERVER_URL=same-origin', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', 'same-origin');
    const config = await loadConfig();
    expect(config.SERVER_BASE).toBe(window.location.origin);
  });
  it('sends a bearer token when VITE_LLULL_API_TOKEN is set', async () => {
    vi.stubEnv('VITE_LLULL_API_TOKEN', 's3cret');
    const config = await loadConfig();
    expect(config.serverAuthHeaders()).toEqual({ Authorization: 'Bearer s3cret' });
  });
  it('builds the /live URL without a token by default', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', '');
    vi.stubEnv('VITE_LLULL_API_TOKEN', '');
    const config = await loadConfig();
    expect(config.liveStreamUrl()).toBe('http://localhost:3001/live');
  });
  it('never puts the token in the /live URL: mints a ticket over header auth', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', 'https://cad.example.com');
    vi.stubEnv('VITE_LLULL_API_TOKEN', 'a b&c');
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: 't/1', expiresInMs: 30000 }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const config = await loadConfig();
    expect(config.hasApiToken()).toBe(true);
    expect(config.liveStreamUrl()).toBe('https://cad.example.com/live');
    const url = await config.liveTicketStreamUrl();
    expect(url).toBe('https://cad.example.com/live?ticket=t%2F1');
    expect(url).not.toContain('access_token');
    expect(fetchSpy).toHaveBeenCalledWith('https://cad.example.com/live/ticket', {
      method: 'POST',
      headers: { Authorization: 'Bearer a b&c' },
    });
    vi.unstubAllGlobals();
  });
  it('rejects when the ticket request fails', async () => {
    vi.stubEnv('VITE_LLULL_API_TOKEN', 'x');
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    const config = await loadConfig();
    await expect(config.liveTicketStreamUrl()).rejects.toThrow('401');
    vi.unstubAllGlobals();
  });
  it('prefers a per-user token stored in localStorage over the build token', async () => {
    vi.stubEnv('VITE_LLULL_API_TOKEN', 'shared');
    window.localStorage.setItem('llull.apiToken', 'user-tok');
    const config = await loadConfig();
    expect(config.serverAuthHeaders()).toEqual({ Authorization: 'Bearer user-tok' });
  });
  it('captures #token=<token> into localStorage and strips the fragment', async () => {
    vi.stubEnv('VITE_LLULL_API_TOKEN', '');
    window.history.replaceState(null, '', '/#token=abc%20123');
    const config = await loadConfig();
    expect(config.serverAuthHeaders()).toEqual({ Authorization: 'Bearer abc 123' });
    expect(window.location.hash).toBe('');
    expect(window.localStorage.getItem('llull.apiToken')).toBe('abc 123');
  });
});
