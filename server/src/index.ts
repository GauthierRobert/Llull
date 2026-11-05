/**
 * Express entry: middleware + route mounting only (L1, L6).
 *   GET /health            liveness + active kernel (`kernel`), { active, requested, fallbackReason } (`kernelStatus`), autosave; Host allowlist; `insecure: true` when token-less
 *   /live /command /undo /redo   `liveRoutes.ts`      /export/*   `exportRoutes.ts`
 *   POST /import/dwg       `importRoutes.ts` (DWG -> DXF converter, then import_dxf)
 *   POST /exchange         `exchangeRoutes.ts` (STEP / DWG / CadQuery exchange tools for the CLI)
 *
 * Env: PORT (3001), HOST (127.0.0.1; loopback only: the backend is local, one per machine, LC1), LLULL_BODY_LIMIT (2mb),
 * LLULL_AUTH_TOKEN (the desktop app's per-launch token; a standalone launch without one generates its own and prints it, or runs with
 * `--insecure-no-token` / LLULL_INSECURE_NO_TOKEN=1: mutating routes refuse with SEC_TOKEN_REQUIRED otherwise) plus the vars in server/README.md.
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
import { getActiveKernelName, getKernelStatus } from './geometryKernel';
import { getAutosaveStatus } from './liveDocument';
import { buildLiveRouter } from './liveRoutes';
import { buildRecoveryRouter } from './recoveryRoutes';
import { buildPreviewRouter } from './previewRoutes';
import { buildSigningRouter } from './plm/signingRoutes';
import { buildCrashRouter } from './crashRoutes';
import { buildExportRouter } from './exportRoutes';
import { errorMessage } from '@lib/errorMessage';
import { startServer } from './lifecycle';
import { applyLaunchAuth, launchAuthNotice } from './launchAuth';
import {
  getAllowedOrigins,
  hostAllowlist,
  isInsecureNoToken,
  isLoopbackHost,
  buildRestRateLimiter,
  jsonErrorHandler,
  securityHeaders,
  setHtmlSecurityHeaders,
} from './security';

const isChallengeProbe = (challenge: unknown): boolean => typeof challenge === 'string' && challenge !== '';

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
// Behind the Host allowlist like every route; only a challenge probe (proof of the per-launch token, nothing else) skips the Host check.
const hostGuard = hostAllowlist();
app.get(
  '/health',
  (req, res, next) => (isChallengeProbe(req.query['challenge']) ? next() : hostGuard(req, res, next)),
  (req, res) => {
    // With ?challenge=<hex> the answer carries HMAC-SHA256(token, challenge): proof that this process knows the per-launch token (the desktop uses it so a
    // process that grabbed the port first is never taken for the backend).
    const token = process.env['LLULL_AUTH_TOKEN'];
    const challenge = req.query['challenge'];
    const proof =
      typeof challenge === 'string' && challenge !== '' && token !== undefined && token !== ''
        ? createHmac('sha256', token).update(challenge).digest('hex')
        : undefined;
    const insecure = isInsecureNoToken() && (token === undefined || token === '');
    // A challenge probe from a foreign Host learns nothing but liveness and the proof.
    if (!isLoopbackHost(req.headers['host'])) {
      res.json({ status: 'ok', ...(proof !== undefined ? { proof } : {}) });
      return;
    }
    res.json({
      status: 'ok',
      kernel: getActiveKernelName(),
      kernelStatus: getKernelStatus(),
      autosave: getAutosaveStatus(),
      ...(insecure ? { insecure: true } : {}),
      ...(proof !== undefined ? { proof } : {}),
    });
  },
);
app.use(hostGuard);
const jsonBody = express.json({ limit: process.env['LLULL_BODY_LIMIT'] ?? '2mb' });
// /import/dwg parses its own (much larger) body.
app.use((req, res, next) => (req.path === '/import/dwg' ? next() : jsonBody(req, res, next)));

const restLimiter = buildRestRateLimiter();
const exchange = exchangeOptionsWithDwg();

app.use(buildLiveRouter(restLimiter));
app.use(buildRecoveryRouter(restLimiter));
app.use(buildPreviewRouter(restLimiter));
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
  const host = process.env['HOST'] ?? '127.0.0.1';
  const notice = launchAuthNotice(applyLaunchAuth(process.env, process.argv.slice(2)), `http://${host}:${port}`);
  if (notice !== null) console.warn(notice);
  startServer(app, port, host).catch((err: unknown) => {
    console.error('[llull-server] failed to start:', errorMessage(err));
    process.exit(1);
  });
}

export { app };
