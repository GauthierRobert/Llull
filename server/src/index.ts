/**
 * @layer server
 * Express entry point: middleware + route mounting only. No business logic — every document
 * change goes through the command registry (architecture L1, L6).
 *
 *   GET /health            liveness + active kernel
 *   /live /command /undo /redo   `liveRoutes.ts`      /export/*   `exportRoutes.ts`
 *   ALL /mcp               `mcp.ts` (Streamable HTTP; bearer auth + rate limit)
 *
 * Env: PORT (3001), HOST (127.0.0.1: llull is a local tool and /command is unauthenticated for the
 * browser UI, so network exposure is opt-in, ideally with MCP_AUTH_TOKEN), LLULL_BODY_LIMIT (2mb),
 * plus the security/MCP vars in server/README.md.
 */

import './plugins'; // must stay first: installs domain plugins before liveDocument loads
import './loadEnv';
import express from 'express';
import cors from 'cors';
import { buildMcpRouter } from './mcp';
import { exchangeOptionsFromEnv } from './pythonExchange';
import { getActiveKernelName } from './geometryKernel';
import { buildLiveRouter } from './liveRoutes';
import { buildExportRouter } from './exportRoutes';
import { errorMessage } from '@lib/errorMessage';
import { startServer } from './lifecycle';
import {
  getAllowedOrigins,
  hostAllowlist,
  buildRestRateLimiter,
  jsonErrorHandler,
} from './security';

const app = express();

app.use(hostAllowlist());
// Disallowed origins simply get no CORS headers (the browser blocks them); no error is raised.
// Before the body parser so its 400/413 JSON errors also carry CORS headers (the browser UI can
// then read them instead of seeing an opaque network failure).
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || getAllowedOrigins().includes(origin));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json({ limit: process.env['LLULL_BODY_LIMIT'] ?? '2mb' }));

const restLimiter = buildRestRateLimiter();
const exchange = exchangeOptionsFromEnv();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', kernel: getActiveKernelName() });
});
app.use(buildLiveRouter(restLimiter));
app.use('/export', restLimiter, buildExportRouter(exchange));
app.use('/mcp', buildMcpRouter(exchange));
app.use(jsonErrorHandler);

/** Only listen when run as the entry point (tests import `app` and use supertest). */
if (require.main === module && process.env['TEST'] !== 'true') {
  const port = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3001;
  startServer(app, port, process.env['HOST'] ?? '127.0.0.1').catch((err: unknown) => {
    console.error('[llull-server] failed to start:', errorMessage(err));
    process.exit(1);
  });
}

export { app };
