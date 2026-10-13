/**
 * Express entry: middleware + route mounting only (L1, L6).
 *   GET /health            liveness + active kernel
 *   /license /admin/*      `adminRoutes.ts` (license status; admin: users, audit, license)
 *   /live /command /undo /redo   `liveRoutes.ts`      /export/*   `exportRoutes.ts`
 *   POST /import/dwg       `importRoutes.ts` (DWG -> DXF converter, then import_dxf)
 *   POST /exchange         `exchangeRoutes.ts` (STEP / DWG / CadQuery exchange tools for the CLI)
 *   ALL /mcp               `mcp.ts` (Streamable HTTP; bearer auth + rate limit)
 *
 * Env: PORT (3001), HOST (127.0.0.1: llull is a local tool and /command is unauthenticated for the
 * browser UI, so network exposure is opt-in, ideally with MCP_AUTH_TOKEN), LLULL_BODY_LIMIT (2mb),
 * plus the security/MCP vars in server/README.md.
 */

import './plugins'; // must stay first: installs domain plugins before liveDocument loads
import './loadEnv';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { buildMcpRouter } from './mcp';
import { exchangeOptionsWithDwg } from './dwgConvert';
import { buildImportRouter } from './importRoutes';
import { buildExchangeRouter } from './exchangeRoutes';
import { getActiveKernelName } from './geometryKernel';
import { buildLiveRouter } from './liveRoutes';
import { buildExportRouter } from './exportRoutes';
import { buildAdminRouter } from './adminRoutes';
import { errorMessage } from '@lib/errorMessage';
import { startServer } from './lifecycle';
import {
  getAllowedOrigins,
  hostAllowlist,
  buildRestRateLimiter,
  jsonErrorHandler,
  securityHeaders,
  setHtmlSecurityHeaders,
  trustProxySetting,
} from './security';

const app = express();

app.disable('x-powered-by');
const trustProxy = trustProxySetting(process.env['LLULL_TRUST_PROXY']);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
app.use(securityHeaders());
// Disallowed origins get no CORS headers. Before the body parser so its 400/413 errors stay readable by the UI.
app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || getAllowedOrigins().includes(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
// Before the Host allowlist: LB / k8s probes arrive with the pod IP as Host.
app.get('/health', (_req, res) => void res.json({ status: 'ok', kernel: getActiveKernelName() }));
app.use(hostAllowlist());
const jsonBody = express.json({ limit: process.env['LLULL_BODY_LIMIT'] ?? '2mb' });
// /import/dwg parses its own (much larger) body.
app.use((req, res, next) => (req.path === '/import/dwg' ? next() : jsonBody(req, res, next)));

const restLimiter = buildRestRateLimiter();
const exchange = exchangeOptionsWithDwg();

app.use(buildLiveRouter(restLimiter));
app.use(buildAdminRouter(restLimiter));
app.use('/export', restLimiter, buildExportRouter(exchange));
app.use('/import', buildImportRouter(restLimiter));
app.use(buildExchangeRouter(restLimiter, exchange));
app.use('/mcp', buildMcpRouter(exchange));
// On-prem: serve the built web app (`LLULL_STATIC_DIR`, e.g. /app/dist) from the same origin.
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
