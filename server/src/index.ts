/**
 * Express entry: middleware + route mounting only (L1, L6).
 *   GET /health            liveness + active kernel
 *   /live /command /undo /redo   `liveRoutes.ts`      /export/*   `exportRoutes.ts`
 *   POST /import/dwg       `importRoutes.ts` (DWG -> DXF converter, then import_dxf)
 *   POST /exchange         `exchangeRoutes.ts` (STEP / DWG / CadQuery exchange tools for the CLI)
 *
 * Env: PORT (3001), HOST (127.0.0.1; loopback only: the backend is local, one per machine, LC1), LLULL_BODY_LIMIT (2mb),
 * LLULL_AUTH_TOKEN (the desktop app's per-launch token) plus the vars in server/README.md.
 */

import './plugins'; // must stay first: installs domain plugins before liveDocument loads
import './loadEnv';
import path from 'path';
import { createHmac } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { exchangeOptionsWithDwg } from './dwgConvert';
import { buildImportRouter } from './importRoutes';
import { buildExchangeRouter } from './exchangeRoutes';
import { getActiveKernelName } from './geometryKernel';
import { buildLiveRouter } from './liveRoutes';
import { buildSigningRouter } from './plm/signingRoutes';
import { buildCrashRouter } from './crashRoutes';
import { buildExportRouter } from './exportRoutes';
import { errorMessage } from '@lib/errorMessage';
import { startServer } from './lifecycle';
import {
  getAllowedOrigins,
  hostAllowlist,
  buildRestRateLimiter,
  jsonErrorHandler,
  securityHeaders,
  setHtmlSecurityHeaders,
} from './security';

const app = express();

app.disable('x-powered-by');
app.use(securityHeaders());
// Disallowed origins get no CORS headers. Before the body parser so its 400/413 errors stay readable by the UI.
app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || getAllowedOrigins().includes(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
// Before the Host allowlist: a liveness probe needs no Host check.
app.get('/health', (req, res) => {
  // With ?challenge=<hex> the answer carries HMAC-SHA256(token, challenge): proof that this process knows the per-launch token (the desktop uses it so a
  // process that grabbed the port first is never taken for the backend).
  const token = process.env['LLULL_AUTH_TOKEN'];
  const challenge = req.query['challenge'];
  const proof =
    typeof challenge === 'string' && challenge !== '' && token !== undefined && token !== ''
      ? createHmac('sha256', token).update(challenge).digest('hex')
      : undefined;
  res.json({ status: 'ok', kernel: getActiveKernelName(), ...(proof !== undefined ? { proof } : {}) });
});
app.use(hostAllowlist());
const jsonBody = express.json({ limit: process.env['LLULL_BODY_LIMIT'] ?? '2mb' });
// /import/dwg parses its own (much larger) body.
app.use((req, res, next) => (req.path === '/import/dwg' ? next() : jsonBody(req, res, next)));

const restLimiter = buildRestRateLimiter();
const exchange = exchangeOptionsWithDwg();

app.use(buildLiveRouter(restLimiter));
app.use(buildSigningRouter(restLimiter));
app.use(buildCrashRouter(restLimiter));
app.use('/export', restLimiter, buildExportRouter(exchange));
app.use('/import', buildImportRouter(restLimiter));
app.use(buildExchangeRouter(restLimiter, exchange));
// Desktop: serve the built renderer (`LLULL_STATIC_DIR`) from the same origin as the API.
const staticDir = process.env['LLULL_STATIC_DIR'];
if (staticDir !== undefined && staticDir !== '') {
  app.use(
    express.static(staticDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) setHtmlSecurityHeaders(res);
      },
    }),
  );
  app.get('/{*path}', (req, res, next) => {
    if (req.accepts('html') !== 'html') return next();
    setHtmlSecurityHeaders(res);
    res.sendFile(path.resolve(staticDir, 'index.html'));
  });
}
app.use((req, res) => void res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
app.use(jsonErrorHandler);

// Tests import `app` (supertest).
if (require.main === module && process.env['TEST'] !== 'true') {
  const port = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3001;
  startServer(app, port, process.env['HOST'] ?? '127.0.0.1').catch((err: unknown) => {
    console.error('[llull-server] failed to start:', errorMessage(err));
    process.exit(1);
  });
}

export { app };
