import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const ORIGIN = 'https://cad.example.com';
const SOURCE = readFileSync('serviceWorker/sw.js', 'utf8');

interface FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
}

type Handler = (event: Record<string, unknown>) => void;

interface WorkerScope {
  readonly self: { readonly skipWaiting: ReturnType<typeof vi.fn>; readonly clients: { readonly claim: ReturnType<typeof vi.fn> } };
  readonly stores: Map<string, Map<string, Response>>;
  readonly fetchMock: ReturnType<typeof vi.fn>;
  waitFor(type: string, data?: Record<string, unknown>): Promise<void>;
  request(path: string, mode?: string, method?: string): { handled: boolean; response: Promise<Response> | undefined };
}

function workerScope(network: (url: string) => Promise<Response>): WorkerScope {
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (request: FakeRequest | string): string => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        addAll: async (urls: string[]) => {
          for (const url of urls) store.set(keyOf(url), new Response(url));
        },
        match: async (request: FakeRequest | string) => store.get(keyOf(request))?.clone(),
        put: async (request: FakeRequest, response: Response) => {
          store.set(keyOf(request), response);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const handlers = new Map<string, Handler>();
  const self = {
    LLULL_SW: {
      version: 'v2',
      precache: ['index.html', 'assets/index-a1.js'],
      runtime: { cacheFirst: '^/assets/', exclude: '\\.wasm$' },
      navigation: { fallback: '/index.html', bypass: '^/(live|mcp|command)(/|$)' },
    },
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const fetchMock = vi.fn((request: FakeRequest) => network(request.url));
  new Function('self', 'caches', 'fetch', 'URL', SOURCE)(self, caches, fetchMock, URL);
  const waitFor = async (type: string, data: Record<string, unknown> = {}): Promise<void> => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get(type)?.({ ...data, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  const request = (path: string, mode = 'cors', method = 'GET'): { handled: boolean; response: Promise<Response> | undefined } => {
    let response: Promise<Response> | undefined;
    handlers.get('fetch')?.({
      request: { url: new URL(path, ORIGIN).href, method, mode },
      respondWith: (r: Promise<Response>) => (response = r),
    });
    return { handled: response !== undefined, response };
  };
  return { self, stores, fetchMock, waitFor, request };
}

describe('service worker runtime', () => {
  it('precaches the build on install and drops older llull caches on activate', async () => {
    const scope = workerScope(async () => new Response('net'));
    scope.stores.set('llull-v1', new Map());
    scope.stores.set('other-app', new Map());
    await scope.waitFor('install');
    expect([...(scope.stores.get('llull-v2')?.keys() ?? [])]).toEqual([`${ORIGIN}/index.html`, `${ORIGIN}/assets/index-a1.js`]);
    await scope.waitFor('activate');
    expect([...scope.stores.keys()].sort()).toEqual(['llull-v2', 'other-app']);
    expect(scope.self.clients.claim).toHaveBeenCalled();
  });
  it('serves hashed assets cache-first and caches what it fetches', async () => {
    const scope = workerScope(async (url) => new Response(`net:${url}`));
    await scope.waitFor('install');
    expect(await (await scope.request('/assets/index-a1.js').response)?.text()).toBe('assets/index-a1.js');
    expect(scope.fetchMock).not.toHaveBeenCalled();
    await scope.request('/assets/lazy-b2.js').response;
    await scope.request('/assets/lazy-b2.js').response;
    expect(scope.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('leaves API calls, WASM, non-GET and cross-origin requests to the network', () => {
    const scope = workerScope(async () => new Response('net'));
    expect(scope.request('/command', 'cors', 'POST').handled).toBe(false);
    expect(scope.request('/live').handled).toBe(false);
    expect(scope.request('/assets/manifold-x.wasm').handled).toBe(false);
    expect(scope.request('https://cdn.example.com/assets/a.js').handled).toBe(false);
    expect(scope.request('/mcp', 'navigate').handled).toBe(false);
  });
  it('navigations go to the network first and fall back to the cached shell offline', async () => {
    let online = true;
    const scope = workerScope(async () => {
      if (!online) throw new TypeError('offline');
      return new Response('fresh page');
    });
    await scope.waitFor('install');
    expect(await (await scope.request('/', 'navigate').response)?.text()).toBe('fresh page');
    online = false;
    expect(await (await scope.request('/', 'navigate').response)?.text()).toBe('index.html');
  });
  it('activates a waiting build only when the page asks', async () => {
    const scope = workerScope(async () => new Response('net'));
    await scope.waitFor('message', { data: 'hello' });
    expect(scope.self.skipWaiting).not.toHaveBeenCalled();
    await scope.waitFor('message', { data: 'SKIP_WAITING' });
    expect(scope.self.skipWaiting).toHaveBeenCalledTimes(1);
  });
});
